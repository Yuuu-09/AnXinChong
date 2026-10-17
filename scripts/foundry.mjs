import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const tool = process.argv[2] ?? 'test';
const binary = path.join(root, '.tools', process.platform === 'win32' ? 'forge.exe' : 'forge');
const args =
  tool === 'test'
    ? ['test', '--network', 'monad', ...process.argv.slice(3)]
    : [tool, ...process.argv.slice(3)];
const result = spawnSync(fs.existsSync(binary) ? binary : 'forge', args, {
  cwd: path.join(root, 'contracts'),
  stdio: 'inherit',
});
if (result.error) {
  console.error('Install official Foundry 1.8.5, or place forge in .tools/. See README.md.');
  process.exit(1);
}
process.exit(result.status ?? 1);
