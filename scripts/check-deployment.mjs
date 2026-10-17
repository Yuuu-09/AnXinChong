import fs from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, defineChain, isAddress, erc20Abi } from 'viem';
import { rpcTransport } from './rpc-transport.mjs';
const name = process.argv[2] ?? 'monad-testnet';
if (!['local', 'monad-testnet'].includes(name)) throw new Error('Choose local or monad-testnet');
const root = path.resolve(import.meta.dirname, '..');
const d = JSON.parse(await fs.readFile(path.join(root, `deployments/${name}.json`), 'utf8'));
if (
  d.schemaVersion !== 3 ||
  d.status !== 'deployed' ||
  !isAddress(d.factory) ||
  !isAddress(d.userRegistry)
)
  throw new Error('The selected network has not been deployed. No verification claimed.');
const chain = defineChain({
  id: d.chainId,
  name: d.networkName,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [d.rpcUrl] } },
});
const client = createPublicClient({ chain, transport: rpcTransport(d.rpcUrl) });
if ((await client.getChainId()) !== d.chainId) throw new Error('Chain ID mismatch');
if (
  !(await client.getCode({ address: d.factory })) ||
  !(await client.getCode({ address: d.asset }))
)
  throw new Error('Missing contract code');
if (
  (await client.readContract({ address: d.asset, abi: erc20Abi, functionName: 'decimals' })) !== 6
)
  throw new Error('Unsupported precision');
const abi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongFactory.json'), 'utf8'),
).abi;
if (
  (await client.readContract({ address: d.factory, abi, functionName: 'asset' })).toLowerCase() !==
  d.asset.toLowerCase()
)
  throw new Error('Factory asset mismatch');
if (
  (
    await client.readContract({ address: d.factory, abi, functionName: 'userRegistry' })
  ).toLowerCase() !== d.userRegistry.toLowerCase()
)
  throw new Error('Factory user registry mismatch');
if (BigInt(d.deploymentBlock) > (await client.getBlockNumber()))
  throw new Error('Deployment block is in the future');
const receipt = await client.getTransactionReceipt({ hash: d.deploymentTransaction });
if (
  receipt.status !== 'success' ||
  receipt.blockNumber !== BigInt(d.deploymentBlock) ||
  receipt.contractAddress?.toLowerCase() !== d.factory.toLowerCase()
)
  throw new Error('Deployment receipt mismatch');
const registryReceipt = await client.getTransactionReceipt({
  hash: d.userRegistryDeploymentTransaction,
});
if (
  registryReceipt.status !== 'success' ||
  registryReceipt.blockNumber !== BigInt(d.userRegistryDeploymentBlock) ||
  registryReceipt.contractAddress?.toLowerCase() !== d.userRegistry.toLowerCase() ||
  !(await client.getCode({ address: d.userRegistry })) ||
  d.userRegistry.toLowerCase() === d.factory.toLowerCase()
)
  throw new Error('User registry deployment mismatch');
const registryAbi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongUserRegistry.json'), 'utf8'),
).abi;
await client.readContract({ address: d.userRegistry, abi: registryAbi, functionName: 'userCount' });
await client.readContract({
  address: d.userRegistry,
  abi: registryAbi,
  functionName: 'getProfile',
  args: ['0x0000000000000000000000000000000000000000'],
});
const vaultAbi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongVault.json'), 'utf8'),
).abi;
const count = await client.readContract({ address: d.factory, abi, functionName: 'merchantCount' });
for (let id = 1n; id <= count; id++) {
  const info = await client.readContract({
    address: d.factory,
    abi,
    functionName: 'getMerchant',
    args: [id],
  });
  const read = (functionName) =>
    client.readContract({ address: info.vault, abi: vaultAbi, functionName });
  if (
    !(await client.getCode({ address: info.vault })) ||
    (await read('factory')).toLowerCase() !== d.factory.toLowerCase() ||
    (await read('asset')).toLowerCase() !== d.asset.toLowerCase() ||
    (await read('userRegistry')).toLowerCase() !== d.userRegistry.toLowerCase() ||
    (await read('merchantId')) !== id ||
    (await client.readContract({
      address: d.factory,
      abi,
      functionName: 'merchantIdOfVault',
      args: [info.vault],
    })) !== id
  )
    throw new Error(`Merchant ${id} vault identity mismatch`);
}
console.log(
  `${name}: factory and user registry deployments, asset, precision and ${count} independent merchant vaults verified.`,
);
