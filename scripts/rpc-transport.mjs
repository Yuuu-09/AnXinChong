import { execFile } from 'node:child_process';
import { custom, http } from 'viem';

// Opt in when the local HTTP proxy works with curl but Node fetch times out.
// No shell interpolation, private keys, or signing operations are involved.
export function rpcTransport(url) {
  if (process.env.MONAD_RPC_TRANSPORT !== 'curl') return http(url);
  let id = 0;
  return custom({
    async request({ method, params }) {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] });
      const output = await new Promise((resolve, reject) => {
        const child = execFile(
          'curl',
          [
            '--fail-with-body',
            '--silent',
            '--show-error',
            '--max-time',
            '20',
            '--header',
            'Content-Type: application/json',
            '--data-binary',
            '@-',
            url,
          ],
          { maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) =>
            error ? reject(new Error(stderr || error.message)) : resolve(stdout),
        );
        child.stdin.on('error', reject);
        child.stdin.end(payload);
      });
      const response = JSON.parse(output);
      if (response.error) throw Object.assign(new Error(response.error.message), response.error);
      return response.result;
    },
  });
}
