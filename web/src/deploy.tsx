import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeDeployData,
  formatEther,
  keccak256,
  erc20Abi,
  type Abi,
  type Address,
  type Hex,
  type EIP1193Provider,
} from 'viem';
import { factoryAbi, registryAbi } from './generated/abi';

const chain = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
  testnet: true,
});
type Artifact = { abi: Abi; bytecode: Hex };
type Build = { chainId: number; asset: Address; registry: Artifact; factory: Artifact };
type Completed = { address: Address; hash: Hex; block: string; gasUsed: string };
type Step = 'registry' | 'factory';
type Prepared = {
  step: Step;
  account: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};
type Pending = { step: Step; hash: Hex; dataHash: Hex };
type Session = {
  pending?: Pending;
  account: Address;
  provider: EIP1193Provider;
  build: Build;
  balance: bigint;
  registry?: Completed;
  factory?: Completed;
};
const storeKey = (account: Address) => `anxinchong:wallet-deploy:10143:${account.toLowerCase()}`;
function okx() {
  const provider = (window as Window & { okxwallet?: EIP1193Provider }).okxwallet;
  if (!provider) throw new Error('未检测到 OKX 插件钱包，请在已安装插件的 Chrome 中打开。');
  return provider;
}
const publicClient = (provider: EIP1193Provider) =>
  createPublicClient({ chain, transport: custom(provider, { retryCount: 0 }) });
function Deploy() {
  const lock = useRef(false);
  const [session, setSession] = useState<Session>();
  const [prepared, setPrepared] = useState<Prepared>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(
    '先连接 OKX，再逐笔预览和部署。两笔交易的转账金额均为 0，仅支付测试 MON Gas。',
  );
  const [error, setError] = useState('');
  const [pendingHash, setPendingHash] = useState<Hex>();
  async function guard(s: Session) {
    const client = publicClient(s.provider);
    const accounts = await s.provider.request({ method: 'eth_accounts' });
    if (accounts[0]?.toLowerCase() !== s.account.toLowerCase())
      throw new Error('钱包账户已改变，请重新连接并预览。');
    if ((await client.getChainId()) !== 10143)
      throw new Error('请在 OKX 切换到 Monad Testnet（10143），不能使用主网。');
    return client;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : e && typeof e === 'object' && 'message' in e
            ? String(e.message)
            : `OKX 请求失败（错误码 ${e && typeof e === 'object' && 'code' in e ? String(e.code) : '未知'}）`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function connect() {
    await run(async () => {
      setStatus('正在请求 OKX 连接账户…');
      const provider = okx();
      const [account] = await provider.request({ method: 'eth_requestAccounts' });
      if (!account) throw new Error('OKX 没有返回已连接账户');
      setStatus('正在读取本地编译产物…');
      const response = await fetch('/__deploy/artifacts', { cache: 'no-store' });
      if (!response.ok) throw new Error(await response.text());
      const build: Build = await response.json();
      if (build.chainId !== 10143) throw new Error('部署网络配置不正确');
      const base = { account, provider, build, balance: 0n };
      setStatus('正在核对 OKX 当前网络…');
      const client = await guard(base);
      setStatus('正在读取测试 MON 余额…');
      const balance = await client.getBalance({ address: account });
      setStatus('正在核对测试 USDC 合约…');
      if (
        (await client.readContract({
          address: build.asset,
          abi: erc20Abi,
          functionName: 'decimals',
        })) !== 6
      )
        throw new Error('支付资产精度不匹配');
      const saved = JSON.parse(localStorage.getItem(storeKey(account)) ?? '{}') as {
        registry?: Completed;
        factory?: Completed;
        pending?: Pending;
      };
      // Receipts are public and cached only for this bytecode build and account.
      let registry: Completed | undefined, factory: Completed | undefined;
      if (saved.registry) {
        const receipt = await client.getTransactionReceipt({ hash: saved.registry.hash });
        const tx = await client.getTransaction({ hash: saved.registry.hash });
        if (
          receipt.status === 'success' &&
          receipt.contractAddress?.toLowerCase() === saved.registry.address.toLowerCase() &&
          tx.from.toLowerCase() === account.toLowerCase() &&
          tx.input === build.registry.bytecode
        )
          registry = saved.registry;
      }
      if (registry && saved.factory) {
        const receipt = await client.getTransactionReceipt({ hash: saved.factory.hash });
        const bound = await client.readContract({
          address: saved.factory.address,
          abi: factoryAbi,
          functionName: 'userRegistry',
        });
        if (
          receipt.status === 'success' &&
          receipt.contractAddress?.toLowerCase() === saved.factory.address.toLowerCase() &&
          bound.toLowerCase() === registry.address.toLowerCase()
        )
          factory = saved.factory;
      }
      setSession({ ...base, balance, registry, factory, pending: saved.pending });
      setPendingHash(saved.pending?.hash);
      setPrepared(undefined);
      setStatus('OKX 已连接，已核对 Monad 测试网、MON 余额及 USDC 精度。');
    });
  }
  async function preview(step: Step) {
    if (!session) return;
    await run(async () => {
      if (session.pending) throw new Error('有已广播的部署交易，请先恢复确认。');
      setPrepared(undefined);
      const client = await guard(session);
      if (step === 'factory' && !session.registry) throw new Error('请先部署用户注册合约');
      const artifact = session.build[step];
      const args = step === 'registry' ? [] : [session.build.asset, session.registry!.address];
      const data = encodeDeployData({ ...artifact, args });
      const estimate = await client.estimateGas({ account: session.account, data, value: 0n });
      const gas = (estimate * 110n + 99n) / 100n;
      if (gas > 30_000_000n) throw new Error('Gas 超过单笔上限');
      const fees = await client.estimateFeesPerGas();
      const balance = await client.getBalance({ address: session.account });
      if (balance < gas * fees.maxFeePerGas)
        throw new Error('测试 MON 余额不足以覆盖本笔最高 Gas 费用');
      setSession({ ...session, balance });
      setPrepared({ step, account: session.account, data, gas, ...fees });
      setStatus('模拟及估算已完成。核对下面的交易信息后，才会请求 OKX 确认。');
    });
  }
  async function send() {
    if (!session || !prepared) return;
    await run(async () => {
      const client = await guard(session);
      const wallet = createWalletClient({
        account: session.account,
        chain,
        transport: custom(session.provider),
      });
      setStatus('请在 OKX 插件中核对并确认部署交易。');
      const hash = await wallet.sendTransaction({
        account: session.account,
        chain,
        data: prepared.data,
        gas: prepared.gas,
        maxFeePerGas: prepared.maxFeePerGas,
        maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
        value: 0n,
      });
      const pending: Pending = { step: prepared.step, hash, dataHash: keccak256(prepared.data) };
      localStorage.setItem(
        storeKey(session.account),
        JSON.stringify({ registry: session.registry, factory: session.factory, pending }),
      );
      setPendingHash(hash);
      setSession({ ...session, pending });
      await finish(session, pending, client);
    });
  }
  async function finish(s: Session, pending: Pending, client: ReturnType<typeof publicClient>) {
    setStatus('交易已广播，等待两次区块确认；请勿重复部署。');
    const receipt = await client.waitForTransactionReceipt({
      hash: pending.hash,
      confirmations: 2,
      timeout: 180000,
    });
    if (receipt.status !== 'success' || !receipt.contractAddress)
      throw new Error('部署失败，请先核对该交易回执，不要重复提交。');
    const expected = encodeDeployData({
      ...s.build[pending.step],
      args: pending.step === 'registry' ? [] : [s.build.asset, s.registry!.address],
    });
    const tx = await client.getTransaction({ hash: pending.hash });
    if (
      keccak256(expected) !== pending.dataHash ||
      tx.input !== expected ||
      tx.from.toLowerCase() !== s.account.toLowerCase() ||
      tx.value !== 0n
    )
      throw new Error('部署交易与本地编译产物不一致');
    const completed: Completed = {
      address: receipt.contractAddress,
      hash: pending.hash,
      block: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    };
    if (pending.step === 'registry')
      await client.readContract({
        address: completed.address,
        abi: registryAbi,
        functionName: 'userCount',
      });
    else {
      const bound = await client.readContract({
        address: completed.address,
        abi: factoryAbi,
        functionName: 'userRegistry',
      });
      const asset = await client.readContract({
        address: completed.address,
        abi: factoryAbi,
        functionName: 'asset',
      });
      if (
        bound.toLowerCase() !== s.registry!.address.toLowerCase() ||
        asset.toLowerCase() !== s.build.asset.toLowerCase()
      )
        throw new Error('工厂绑定参数核验失败');
    }
    const updated = {
      ...s,
      [pending.step]: completed,
      pending: undefined,
      balance: await client.getBalance({ address: s.account }),
    };
    localStorage.setItem(
      storeKey(s.account),
      JSON.stringify({ registry: updated.registry, factory: updated.factory }),
    );
    setSession(updated);
    setPrepared(undefined);
    setPendingHash(undefined);
    setStatus('部署成功，已确认回执并读取合约核验。');
  }
  async function recover() {
    if (!session?.pending) return;
    await run(async () => {
      const client = await guard(session);
      await finish(session, session.pending!, client);
    });
  }
  return (
    <main>
      <h1>安心充 · OKX 测试网部署</h1>
      <p>
        仅用于 Monad Testnet · Chain ID 10143。部署用户注册合约和工厂，不进行 USDC
        授权、转账或用户注册。
      </p>
      <button disabled={busy} onClick={() => void connect()}>
        连接并检查 OKX
      </button>
      {session && (
        <section>
          <h2>部署钱包与资产</h2>
          <p>
            钱包：<code>{session.account}</code>
          </p>
          <p>测试 MON 余额：{formatEther(session.balance)}</p>
          <p>
            支付资产：<code>{session.build.asset}</code>
          </p>
          <button
            disabled={busy || !!session.pending || !!session.registry}
            onClick={() => void preview('registry')}
          >
            预览第一笔：部署用户注册合约
          </button>
          <button
            disabled={busy || !!session.pending || !session.registry || !!session.factory}
            onClick={() => void preview('factory')}
          >
            预览第二笔：部署工厂合约
          </button>
        </section>
      )}
      {prepared && (
        <section>
          <h2>待确认部署交易</h2>
          <p>
            合约：{prepared.step === 'registry' ? 'AnXinChongUserRegistry' : 'AnXinChongFactory'}
          </p>
          <p>网络：Monad Testnet（10143）</p>
          <p>
            发送者：<code>{prepared.account}</code>
          </p>
          <p>转账金额：0 MON</p>
          <p>Gas 上限：{prepared.gas.toString()}</p>
          <p>最高 Gas 费用：{formatEther(prepared.gas * prepared.maxFeePerGas)} 测试 MON</p>
          <p>
            部署数据摘要：<code>{keccak256(prepared.data)}</code>
          </p>
          <button disabled={busy || !!pendingHash} onClick={() => void send()}>
            在 OKX 中确认这笔部署
          </button>
        </section>
      )}
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
      {session?.pending && (
        <button disabled={busy} onClick={() => void recover()}>
          恢复已广播交易的确认
        </button>
      )}
      {pendingHash && (
        <p>
          已广播交易：<code>{pendingHash}</code>。请勿重复部署。
        </p>
      )}
      {(['registry', 'factory'] as const).map(
        (step) =>
          session?.[step] && (
            <section key={step}>
              <h2>{step === 'registry' ? '用户注册合约' : '工厂合约'}已部署</h2>
              <p>
                地址：<code>{session[step]!.address}</code>
              </p>
              <p>
                交易：<code>{session[step]!.hash}</code>
              </p>
              <p>区块：{session[step]!.block}</p>
            </section>
          ),
      )}
      {session?.factory && session.registry && (
        <section>
          <h2>登记部署命令</h2>
          <pre>
            node scripts/record-deployment.mjs {session.factory.address} {session.factory.hash}{' '}
            {session.registry.address} {session.registry.hash}
          </pre>
        </section>
      )}
    </main>
  );
}
const style = document.createElement('style');
style.textContent =
  'body{margin:0;background:#f5f7f3;color:#183f35;font:15px/1.8 system-ui}main{max-width:900px;margin:40px auto;padding:24px}section{background:white;border:1px solid #dce6dc;border-radius:14px;padding:24px;margin:20px 0}h1{font-size:26px}h2{font-size:19px}button{padding:12px 18px;border:0;border-radius:7px;background:#1c6151;color:white;margin:8px 12px 8px 0;cursor:pointer}button:disabled{opacity:.4;cursor:default}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}p[role=alert]{color:#b32727;background:#fff2f0;padding:18px}';
document.head.append(style);
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Deploy />
  </React.StrictMode>,
);
