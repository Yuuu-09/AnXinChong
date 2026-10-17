import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Run after pnpm build. The temporary server serves the same build at / and /preview/.
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'web/dist');
await readFile(path.join(dist, 'index.html'));
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname).replace(/^\/preview\//, '/');
    const file = path.resolve(
      dist,
      `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`,
    );
    if (!file.startsWith(`${dist}${path.sep}`)) throw new Error('Outside build');
    const content = await readFile(file);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
const passed = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath(),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function check(name, test) {
    const page = await browser.newPage();
    try {
      await test(page);
      passed.push(name);
    } finally {
      await page.close();
    }
  }
  for (const entry of ['web/index.html', 'web/dist/index.html']) {
    await check(`file guidance: ${entry}`, async (page) => {
      await page.goto(pathToFileURL(path.join(root, entry)).href);
      await page.getByRole('heading', { name: '请通过本地预览打开安心充' }).waitFor();
      assert.ok(await page.getByText('./start.command', { exact: true }).isVisible());
    });
  }
  for (const prefix of ['/', '/preview/']) {
    await check(`production startup: ${prefix}`, async (page) => {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}${prefix}`);
      await page.getByRole('heading', { name: '预付有约，消费安心' }).waitFor();
      assert.equal(await page.locator('.startup-panel').count(), 0);
      assert.deepEqual(errors, []);
    });
  }
  for (const failure of [
    'missing',
    'invalid',
    'network',
    'legacy-schema',
    'legacy-factory-schema',
  ]) {
    await check(`configuration failure and retry: ${failure}`, async (page) => {
      await page.route('**/deployments/*.json', async (route) => {
        if (failure === 'network') return route.abort();
        return route.fulfill({
          status: failure === 'missing' ? 404 : 200,
          contentType: 'application/json',
          body: failure.startsWith('legacy')
            ? JSON.stringify({
                ...JSON.parse(
                  await readFile(path.join(dist, 'deployments/monad-testnet.json'), 'utf8'),
                ),
                schemaVersion: failure === 'legacy-schema' ? 1 : 2,
              })
            : '{}',
        });
      });
      await page.goto(base);
      await page.getByRole('heading', { name: '安心充启动失败' }).waitFor();
      assert.match(await page.locator('#startup-message').innerText(), /配置加载失败/);
      await page.unroute('**/deployments/*.json');
      await page.getByRole('button', { name: '重新加载' }).click();
      await page.getByRole('heading', { name: '预付有约，消费安心' }).waitFor();
    });
  }
  await check('entry script failure', async (page) => {
    await page.route('**/assets/index-*.js', (route) => route.abort());
    await page.goto(base);
    await page.getByRole('heading', { name: '安心充启动失败' }).waitFor();
    assert.ok(await page.getByRole('button', { name: '重新加载' }).isVisible());
  });
  console.log(JSON.stringify({ passed: passed.length, cases: passed }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
