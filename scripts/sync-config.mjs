import { mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'web/public/deployments');
export async function syncDeploymentConfig(
  selected = process.env.VITE_DEPLOYMENT ?? 'monad-testnet.json',
) {
  if (!['monad-testnet.json', 'local.json'].includes(selected))
    throw new Error('Unknown deployment manifest');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copyFile(path.join(root, 'deployments', selected), path.join(target, selected));
  console.log(`Deployment manifest ${selected} copied into static assets.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncDeploymentConfig();
}
