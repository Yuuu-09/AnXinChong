import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { syncDeploymentConfig } from '../scripts/sync-config.mjs';
export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'deployment-manifest',
      async configResolved(config) {
        await syncDeploymentConfig(config.env.VITE_DEPLOYMENT ?? 'monad-testnet.json');
      },
    },
    react(),
    {
      name: 'local-wallet-deployment',
      configureServer(server) {
        server.middlewares.use('/__deploy/artifacts', async (request, response) => {
          if (request.method !== 'GET') {
            response.statusCode = 405;
            response.end();
            return;
          }
          try {
            const read = async (name: string) =>
              JSON.parse(
                await readFile(
                  new URL(`../contracts/out/js/${name}.json`, import.meta.url),
                  'utf8',
                ),
              );
            const [registry, factory, deployment] = await Promise.all([
              read('AnXinChongUserRegistry'),
              read('AnXinChongFactory'),
              readFile(new URL('../deployments/monad-testnet.json', import.meta.url), 'utf8').then(
                JSON.parse,
              ),
            ]);
            response.setHeader('Content-Type', 'application/json');
            response.setHeader('Cache-Control', 'no-store');
            response.end(
              JSON.stringify({
                chainId: 10143,
                asset: deployment.asset,
                registry: { abi: registry.abi, bytecode: `0x${registry.evm.bytecode.object}` },
                factory: { abi: factory.abi, bytecode: `0x${factory.evm.bytecode.object}` },
              }),
            );
          } catch {
            response.statusCode = 503;
            response.end('请先在项目目录运行 pnpm compile');
          }
        });
      },
    },
  ],
  // Local development only: serve compiled public bytecode to the wallet deployment page.
  // This endpoint is absent from production builds and never accepts keys or signed transactions.
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
