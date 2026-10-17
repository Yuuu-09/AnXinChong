import fs from 'node:fs/promises';
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, http } from 'viem';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const rpc = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(rpc).hostname))
  throw new Error('This script only deploys to a loopback local node.');
const chain = defineChain({
  id: 31337,
  name: 'Monad Local',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const client = createPublicClient({ chain, transport: http(rpc) });
if ((await client.getChainId()) !== 31337)
  throw new Error('Local deployment requires chain ID 31337.');
const accounts = await client.request({ method: 'eth_accounts' });
if (accounts.length < 6)
  throw new Error('Start a disposable Anvil node with unlocked local accounts.');
const wallet = createWalletClient({ account: accounts[0], chain, transport: http(rpc) });
const artifact = async (name) =>
  JSON.parse(await fs.readFile(path.join(root, `contracts/out/js/${name}.json`), 'utf8'));
async function deploy(name, args = []) {
  const a = await artifact(name);
  const bytecode = `0x${a.evm.bytecode.object}`;
  const estimate = await client.estimateGas({
    account: accounts[0],
    data: encodeDeployData({ abi: a.abi, bytecode, args }),
  });
  const hash = await wallet.deployContract({
    abi: a.abi,
    bytecode,
    args,
    gas: (estimate * 110n) / 100n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress)
    throw new Error(`${name} deployment failed`);
  return { address: receipt.contractAddress, hash, block: receipt.blockNumber, abi: a.abi };
}
const asset = await deploy('MockUSDC');
const userRegistry = await deploy('AnXinChongUserRegistry');
const factory = await deploy('AnXinChongFactory', [asset.address, userRegistry.address]);
const vaultArtifact = await artifact('AnXinChongVault');
async function write(address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(functionName + ' failed');
  return receipt;
}
// Leave the consumer and third merchant unregistered for the browser onboarding checks.
for (const [account, handle, nickname] of [
  [accounts[0], 'qinghe_owner', '青禾店主'],
  [accounts[4], 'muhe_owner', '木禾店主'],
  [accounts[2], 'demo_channel', '渠道伙伴'],
]) {
  const profileWallet = createWalletClient({ account, chain, transport: http(rpc) });
  const hash = await profileWallet.writeContract({
    address: userRegistry.address,
    abi: userRegistry.abi,
    functionName: 'registerUser',
    args: [handle, nickname],
  });
  if ((await client.waitForTransactionReceipt({ hash })).status !== 'success')
    throw new Error('Fixture profile registration failed');
}
await write(factory.address, factory.abi, 'registerMerchant', [
  {
    name: '青禾生活馆',
    description: '理发与日常护理。消费双方确认后结算，优惠与退出规则公开透明。',
  },
  accounts[0],
]);
const firstVault = await client.readContract({
  address: factory.address,
  abi: factory.abi,
  functionName: 'vaultOf',
  args: [1n],
});
const vault = { address: firstVault, abi: vaultArtifact.abi };
const base = {
  merchantId: 1n,
  previousVersionId: 0n,
  description: '本金由合约托管，提前退出时补回已享优惠。',
  channelRecipient: accounts[2],
  channelBps: 200n,
  referralBps: 300n,
};
await write(vault.address, vault.abi, 'createPlanVersion', [
  {
    ...base,
    mode: 0,
    name: '安心储值 · 500 享九折',
    minDeposit: 500_000000n,
    discountBps: 9000n,
    minUnits: 0n,
    listUnitPrice: 0n,
    saleUnitPrice: 0n,
  },
]);
await write(vault.address, vault.abi, 'createPlanVersion', [
  {
    ...base,
    mode: 1,
    name: '轻松理发 · 十次护理卡',
    minDeposit: 0n,
    discountBps: 0n,
    minUnits: 10n,
    listUnitPrice: 88_000000n,
    saleUnitPrice: 58_000000n,
  },
]);
await write(vault.address, vault.abi, 'setReferral', [1n, accounts[1], accounts[3]]);
await write(asset.address, asset.abi, 'mint', [accounts[1], 10_000_000000n]);
const secondWallet = createWalletClient({ account: accounts[4], chain, transport: http(rpc) });
const secondTx = await secondWallet.writeContract({
  address: factory.address,
  abi: factory.abi,
  functionName: 'registerMerchant',
  args: [{ name: '木禾咖啡', description: '独立金库隔离演示' }, accounts[4]],
});
const secondReceipt = await client.waitForTransactionReceipt({ hash: secondTx });
if (secondReceipt.status !== 'success') throw new Error('Second merchant registration failed');
const secondVault = await client.readContract({
  address: factory.address,
  abi: factory.abi,
  functionName: 'vaultOf',
  args: [2n],
});
const secondPlanTx = await secondWallet.writeContract({
  address: secondVault,
  abi: vault.abi,
  functionName: 'createPlanVersion',
  args: [
    {
      ...base,
      merchantId: 2n,
      mode: 0,
      name: '咖啡储值卡',
      minDeposit: 100_000000n,
      discountBps: 10000n,
      minUnits: 0n,
      listUnitPrice: 0n,
      saleUnitPrice: 0n,
    },
  ],
});
if ((await client.waitForTransactionReceipt({ hash: secondPlanTx })).status !== 'success')
  throw new Error('Second plan failed');

const manifest = {
  schemaVersion: 3,
  status: 'deployed',
  chainId: 31337,
  networkName: 'Monad Local',
  rpcUrl: rpc,
  explorerUrl: '',
  asset: asset.address,
  assetDecimals: 6,
  assetSymbol: 'MockUSDC',
  isMockAsset: true,
  factory: factory.address,
  userRegistry: userRegistry.address,
  userRegistryDeploymentBlock: userRegistry.block.toString(),
  userRegistryDeploymentTransaction: userRegistry.hash,
  userRegistryVerification: 'local-only',
  deploymentBlock: factory.block.toString(),
  deploymentTransaction: factory.hash,
  confirmations: 1,
  verification: 'local-only',
  compiler: '0.8.37',
  evmVersion: 'osaka',
  executionNetwork: 'monad',
  deployedAt: new Date().toISOString(),
};
await fs.writeFile(
  path.join(root, 'deployments/local.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await fs.writeFile(
  path.join(root, 'deployments/local-demo.json'),
  JSON.stringify(
    {
      merchant: accounts[0],
      consumer: accounts[1],
      channel: accounts[2],
      referrer: accounts[3],
      merchantId: '1',
      vault: vault.address,
      secondMerchant: accounts[4],
      thirdMerchant: accounts[5],
      secondMerchantId: '2',
      secondVault,
      secondPlan: '1',
      storedPlan: '1',
      countPlan: '2',
    },
    null,
    2,
  ) + '\n',
);
execFileSync(process.execPath, [path.join(root, 'scripts/sync-config.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEPLOYMENT: 'local.json' },
});
console.log(
  JSON.stringify(
    {
      factory: factory.address,
      userRegistry: userRegistry.address,
      vault: vault.address,
      secondVault,
      asset: asset.address,
      chainId: 31337,
      merchant: accounts[0],
      consumer: accounts[1],
    },
    null,
    2,
  ),
);
console.log('Local only. Start the frontend with VITE_DEPLOYMENT=local.json pnpm dev.');
