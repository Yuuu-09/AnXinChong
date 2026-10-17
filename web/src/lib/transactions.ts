import { useRef, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { BaseError, erc20Abi, type Abi, type Address, type Hex } from 'viem';
import { BILL_TYPES, billDomain, type Bill } from '@anxinchong/protocol/bill';
import { factoryAbi, registryAbi, vaultAbi } from '../generated/abi';
import { chain, configured, manifest, publicClient, registeredVault } from './runtime';

export const errorText = (error: unknown) =>
  error instanceof BaseError
    ? error.shortMessage
    : error instanceof Error
      ? error.message
      : String(error);
export function useTransactions(vault?: Address) {
  const { address, chainId } = useAccount();
  const { data: wallet } = useWalletClient();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [hash, setHash] = useState<Hex>();
  const [error, setError] = useState('');
  const lock = useRef(false);
  const context = `${address}:${chainId}:${vault}`;
  const latestContext = useRef(context);
  latestContext.current = context;
  function assertContext() {
    if (latestContext.current !== context) throw new Error('钱包或网络已改变，请重新确认本次操作');
  }
  function assertWallet() {
    assertContext();
    if (!configured || !manifest.factory) throw new Error('合约尚未部署');
    if (!address || !wallet) throw new Error('请先连接钱包');
    if (chainId !== chain.id) throw new Error(`请切换到 ${chain.name}`);
    return { address, wallet };
  }
  async function send(functionName: string, args: readonly unknown[], token = false) {
    const current = assertWallet();
    const registration = !token && functionName === 'registerMerchant';
    const profileAction = !token && ['registerUser', 'updateNickname'].includes(functionName);
    if (profileAction && !manifest.userRegistry) throw new Error('用户资料合约尚未部署');
    if (!profileAction) {
      const registered = await publicClient.readContract({
        address: manifest.userRegistry!,
        abi: registryAbi,
        functionName: 'isRegistered',
        args: [current.address],
      });
      if (!registered) throw new Error('请先注册用户资料');
    }
    if (!registration && !profileAction) {
      if (!vault) throw new Error('缺少商家金库地址');
      await registeredVault(vault);
      if (
        token &&
        (functionName !== 'approve' || String(args[0]).toLowerCase() !== vault.toLowerCase())
      )
        throw new Error('USDC 只能授权给当前商家金库');
    }
    const target = token
      ? manifest.asset
      : profileAction
        ? manifest.userRegistry!
        : registration
          ? manifest.factory!
          : vault!;
    const abi: Abi = token
      ? erc20Abi
      : profileAction
        ? registryAbi
        : registration
          ? factoryAbi
          : vaultAbi;
    setPhase('正在模拟交易并估算 Gas…');
    const params = { address: target, abi, functionName, args, account: current.address };
    await publicClient.simulateContract(params);
    const estimate = await publicClient.estimateContractGas(params);
    const gas = (estimate * 110n + 99n) / 100n;
    if (gas > 30_000_000n) throw new Error('Gas 估算超过单笔上限');
    const fees = await publicClient.estimateFeesPerGas();
    const balance = await publicClient.getBalance({ address: current.address });
    if (balance < gas * fees.maxFeePerGas) throw new Error('测试 MON 不足以支付本笔交易 Gas');
    assertContext();
    setPhase('请在钱包确认交易');
    const sent = await current.wallet.writeContract({ ...params, chain, gas, ...fees });
    setHash(sent);
    setPhase('交易已提交，等待链上确认…');
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: sent,
      confirmations: manifest.confirmations,
    });
    if (receipt.status !== 'success') throw new Error('交易在链上执行失败，资金与权益未结算');
    setPhase('交易已确认');
    await cache.invalidateQueries();
    return receipt;
  }
  async function sign(bill: Bill) {
    const current = assertWallet();
    if (!vault) throw new Error('缺少商家金库地址');
    await registeredVault(vault);
    if (
      !(await publicClient.readContract({
        address: manifest.userRegistry!,
        abi: registryAbi,
        functionName: 'isRegistered',
        args: [current.address],
      }))
    )
      throw new Error('请先注册用户资料');
    assertContext();
    setPhase('请在钱包签署消费账单');
    const signature = await current.wallet.signTypedData({
      account: current.address,
      domain: billDomain(chain.id, vault),
      types: BILL_TYPES,
      primaryType: 'Bill',
      message: bill,
    });
    assertContext();
    setPhase('账单已签名，尚未结算');
    return signature;
  }
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setPhase('');
    setHash(undefined);
    try {
      return await action();
    } catch (e) {
      setError(errorText(e));
      setPhase('');
      return undefined;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function reset() {
    if (lock.current) return;
    setPhase('');
    setHash(undefined);
    setError('');
  }
  return { address, busy, phase, hash, error, send, sign, run, reset };
}
