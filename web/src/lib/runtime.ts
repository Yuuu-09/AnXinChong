import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  type Address,
  type ContractFunctionReturnType,
} from 'viem';
import { createConfig } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { factoryAbi, registryAbi, vaultAbi } from '../generated/abi';

export type Deployment = {
  schemaVersion: 3;
  status: 'not-deployed' | 'deployed';
  chainId: number;
  networkName: string;
  rpcUrl: string;
  explorerUrl: string;
  asset: Address;
  assetDecimals: number;
  assetSymbol: string;
  factory: Address | null;
  userRegistry: Address | null;
  userRegistryDeploymentBlock: string | null;
  userRegistryDeploymentTransaction: string | null;
  deploymentBlock: string | null;
  confirmations: number;
  isMockAsset: boolean;
  deploymentTransaction: string | null;
  verification: string;
};
export const manifest = await fetch(
  `${import.meta.env.BASE_URL}deployments/${import.meta.env.VITE_DEPLOYMENT ?? 'monad-testnet.json'}`,
  { cache: 'no-store', signal: AbortSignal.timeout(15000) },
).then(async (response) => {
  if (!response.ok) throw new Error('无法读取部署配置');
  const d: Deployment = await response.json();
  if (
    d.schemaVersion !== 3 ||
    !Number.isSafeInteger(d.chainId) ||
    d.assetDecimals !== 6 ||
    !isAddress(d.asset) ||
    !Number.isInteger(d.confirmations) ||
    d.confirmations < 1
  )
    throw new Error('部署配置无效');
  if (
    d.status === 'deployed' &&
    (!d.factory ||
      !isAddress(d.factory) ||
      !/^\d+$/.test(d.deploymentBlock ?? '') ||
      !d.userRegistry ||
      !isAddress(d.userRegistry) ||
      !/^\d+$/.test(d.userRegistryDeploymentBlock ?? '') ||
      d.userRegistry.toLowerCase() === d.factory.toLowerCase())
  )
    throw new Error('缺少有效的部署地址或区块');
  return d;
});
export const configured = manifest.status === 'deployed' && !!manifest.factory;
export const chain = defineChain({
  id: manifest.chainId,
  name: manifest.networkName,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [manifest.rpcUrl] } },
  testnet: true,
});
export const publicClient = createPublicClient({
  chain,
  transport: http(manifest.rpcUrl, { retryCount: 2 }),
});
export const walletConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: { [chain.id]: http(manifest.rpcUrl) },
});

export type UserProfile = ContractFunctionReturnType<typeof registryAbi, 'view', 'getProfile'>;
export async function readUserProfile(account: Address): Promise<UserProfile> {
  if (!manifest.userRegistry) throw new Error('用户资料合约尚未部署');
  return publicClient.readContract({
    address: manifest.userRegistry,
    abi: registryAbi,
    functionName: 'getProfile',
    args: [account],
  });
}
export type Merchant = ContractFunctionReturnType<typeof factoryAbi, 'view', 'getMerchant'>;
export type Plan = ContractFunctionReturnType<typeof vaultAbi, 'view', 'getPlanVersion'>;
export type Membership = ContractFunctionReturnType<typeof vaultAbi, 'view', 'getMembership'>;
export type PurchaseQuote = ContractFunctionReturnType<typeof vaultAbi, 'view', 'quotePurchase'>;
export type ExitQuote = ContractFunctionReturnType<typeof vaultAbi, 'view', 'previewExit'>;
export type Preview = ContractFunctionReturnType<typeof vaultAbi, 'view', 'previewSettlement'>;
export type MerchantStats = ContractFunctionReturnType<typeof vaultAbi, 'view', 'getMerchantStats'>;
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const queryScope = [manifest.chainId, manifest.factory] as const;
export async function readFactory<T>(
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  if (!configured || !manifest.factory)
    throw new Error('工厂合约尚未部署，请先完成本地或测试网部署');
  return (await publicClient.readContract({
    address: manifest.factory,
    abi: factoryAbi as import('viem').Abi,
    functionName,
    args,
  })) as T;
}
export async function registeredVault(vault: Address): Promise<Merchant> {
  const id = await readFactory<bigint>('merchantIdOfVault', [vault]);
  if (id === 0n) throw new Error('该金库不属于当前工厂，无法操作');
  return readFactory<Merchant>('getMerchant', [id]);
}
export async function readVault<T>(
  vault: Address,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  await registeredVault(vault);
  return (await publicClient.readContract({
    address: vault,
    abi: vaultAbi as import('viem').Abi,
    functionName,
    args,
  })) as T;
}
export async function allMerchants(): Promise<readonly { id: bigint; shop: Merchant }[]> {
  const count = await readFactory<bigint>('merchantCount');
  const shops = [];
  for (let cursor = 0n; cursor < count;) {
    const [ids, next] = await readFactory<readonly [readonly bigint[], bigint]>('listMerchants', [
      cursor,
      100n,
    ]);
    if (next <= cursor) throw new Error('工厂分页没有前进，请刷新重试');
    for (const id of ids)
      shops.push({ id, shop: await readFactory<Merchant>('getMerchant', [id]) });
    cursor = next;
  }
  return shops;
}
export async function totalMerchantEscrow(): Promise<bigint> {
  const shops = await allMerchants();
  let total = 0n;
  // Vault addresses come from the configured factory. Bound concurrent RPC reads,
  // and fail the whole query rather than presenting a partial sum as the total.
  for (let offset = 0; offset < shops.length; offset += 20) {
    const balances = await Promise.all(
      shops.slice(offset, offset + 20).map(({ shop }) =>
        publicClient.readContract({
          address: shop.vault,
          abi: vaultAbi,
          functionName: 'totalEscrowed',
        }),
      ),
    );
    total += balances.reduce((sum, balance) => sum + balance, 0n);
  }
  return total;
}
export async function consumerCards(consumer: Address) {
  const accounts: { id: bigint; vault: Address }[] = [];
  for (const { shop } of await allMerchants()) {
    let cursor = 0n;
    do {
      const [ids, next] = await readVault<readonly [readonly bigint[], bigint]>(
        shop.vault,
        'listConsumerMemberships',
        [consumer, cursor, 100n],
      );
      for (const id of ids) accounts.push({ id, vault: shop.vault });
      if (ids.length < 100) break;
      if (next <= cursor) throw new Error('会员账户分页没有前进，请刷新重试');
      cursor = next;
    } while (true);
  }
  return accounts;
}
export function parseId(value: string | undefined): bigint {
  if (!value || !/^[1-9]\d*$/.test(value) || value.length > 78 || BigInt(value) >= 2n ** 256n)
    throw new Error('无效 ID');
  return BigInt(value);
}
