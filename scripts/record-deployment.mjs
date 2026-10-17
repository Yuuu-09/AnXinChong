import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createPublicClient,
  erc20Abi,
  encodeDeployData,
  keccak256,
  isAddress,
  isHash,
  zeroAddress,
} from 'viem';
import { rpcTransport } from './rpc-transport.mjs';
const [factory, hash, userRegistry, registryHash] = process.argv.slice(2);
if (
  !isAddress(factory ?? '') ||
  !isHash(hash ?? '') ||
  !isAddress(userRegistry ?? '') ||
  !isHash(registryHash ?? '')
)
  throw new Error(
    'Usage: node scripts/record-deployment.mjs <factory address> <factory tx hash> <user registry address> <registry tx hash>',
  );
const root = path.resolve(import.meta.dirname, '..');
const filename = path.join(root, 'deployments/monad-testnet.json');
const previous = JSON.parse(await fs.readFile(filename, 'utf8'));
const client = createPublicClient({ transport: rpcTransport(previous.rpcUrl) });
if ((await client.getChainId()) !== 10143) throw new Error('Monad Testnet only');
const receipt = await client.getTransactionReceipt({ hash });
if (
  receipt.status !== 'success' ||
  receipt.contractAddress?.toLowerCase() !== factory.toLowerCase()
)
  throw new Error('Deployment receipt mismatch');
const abi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongFactory.json'), 'utf8'),
).abi;
const asset = await client.readContract({ address: factory, abi, functionName: 'asset' });
if (
  (
    await client.readContract({ address: factory, abi, functionName: 'userRegistry' })
  ).toLowerCase() !== userRegistry.toLowerCase()
)
  throw new Error('Factory user registry mismatch');
// A shared v1 vault also exposes asset(); require the factory directory interface.
if (
  (await client.readContract({
    address: factory,
    abi,
    functionName: 'merchantIdOfVault',
    args: [zeroAddress],
  })) !== 0n ||
  (
    await client.readContract({ address: factory, abi, functionName: 'vaultOf', args: [0n] })
  ).toLowerCase() !== zeroAddress
)
  throw new Error('The address is not a valid factory directory');
if (asset.toLowerCase() !== previous.asset.toLowerCase())
  throw new Error(
    'Unexpected asset: explicitly document an asset change before recording deployment.',
  );
if ((await client.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' })) !== 6)
  throw new Error('Asset decimals mismatch');
const registryReceipt = await client.getTransactionReceipt({ hash: registryHash });
if (
  registryReceipt.status !== 'success' ||
  registryReceipt.contractAddress?.toLowerCase() !== userRegistry.toLowerCase() ||
  userRegistry.toLowerCase() === factory.toLowerCase()
)
  throw new Error('User registry receipt mismatch');
const registryAbi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongUserRegistry.json'), 'utf8'),
).abi;
await client.readContract({ address: userRegistry, abi: registryAbi, functionName: 'userCount' });
await client.readContract({
  address: userRegistry,
  abi: registryAbi,
  functionName: 'getProfile',
  args: [zeroAddress],
});
const factoryArtifact = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongFactory.json'), 'utf8'),
);
const registryArtifact = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongUserRegistry.json'), 'utf8'),
);
const factoryTx = await client.getTransaction({ hash });
const registryTx = await client.getTransaction({ hash: registryHash });
const expectedFactory = encodeDeployData({
  abi,
  bytecode: `0x${factoryArtifact.evm.bytecode.object}`,
  args: [asset, userRegistry],
});
const expectedRegistry = `0x${registryArtifact.evm.bytecode.object}`;
if (
  factoryTx.to !== null ||
  registryTx.to !== null ||
  factoryTx.value !== 0n ||
  registryTx.value !== 0n ||
  factoryTx.from.toLowerCase() !== registryTx.from.toLowerCase() ||
  factoryTx.input !== expectedFactory ||
  registryTx.input !== expectedRegistry
)
  throw new Error(
    'Deployment transactions do not match the local compiler artifacts and constructor parameters',
  );
const head = await client.getBlockNumber();
if (
  head - receipt.blockNumber + 1n < BigInt(previous.confirmations) ||
  head - registryReceipt.blockNumber + 1n < BigInt(previous.confirmations)
)
  throw new Error('Insufficient deployment confirmations');
const block = await client.getBlock({ blockNumber: receipt.blockNumber });
await fs.mkdir(path.join(root, 'evidence/deployment'), { recursive: true });
await fs.writeFile(
  path.join(root, 'evidence/deployment/monad-testnet.json'),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      chainId: 10143,
      checkedAtBlock: head.toString(),
      deployer: factoryTx.from,
      asset,
      assetDecimals: 6,
      registry: {
        address: userRegistry,
        transaction: registryHash,
        block: registryReceipt.blockNumber.toString(),
        gasUsed: registryReceipt.gasUsed.toString(),
        inputHash: keccak256(expectedRegistry),
        status: registryReceipt.status,
      },
      factory: {
        address: factory,
        transaction: hash,
        block: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        inputHash: keccak256(expectedFactory),
        status: receipt.status,
      },
      bytecodeAndConstructorParametersMatch: true,
    },
    null,
    2,
  ) + '\n',
);
const next = {
  ...previous,
  status: 'deployed',
  schemaVersion: 3,
  factory,
  userRegistry,
  userRegistryDeploymentTransaction: registryHash,
  userRegistryDeploymentBlock: registryReceipt.blockNumber.toString(),
  userRegistryVerification: 'pending',
  deploymentTransaction: hash,
  deploymentBlock: receipt.blockNumber.toString(),
  deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
  deployer: factoryTx.from,
  compiler: '0.8.37',
  evmVersion: 'osaka',
  executionNetwork: 'monad',
  optimizerRuns: 200,
  viaIR: true,
  verification: 'pending',
};
await fs.writeFile(filename, JSON.stringify(next, null, 2) + '\n');
console.log(
  'Verified deployment recorded. Source verification remains pending; run pnpm deployment:check and sync the frontend configuration.',
);
