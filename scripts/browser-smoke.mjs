import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  hashTypedData,
  http,
} from 'viem';
import {
  BILL_TYPES,
  billDomain,
  decodeEnvelope,
  encodeEnvelope,
} from '../packages/protocol/bill.mjs';
const root = path.resolve(import.meta.dirname, '..');
const d = JSON.parse(await fs.readFile(path.join(root, 'deployments/local.json'), 'utf8'));
const demo = JSON.parse(await fs.readFile(path.join(root, 'deployments/local-demo.json'), 'utf8'));
assert.equal(d.chainId, 31337);
assert.equal(d.isMockAsset, true);
const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local browser tests only');
const abi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongVault.json'), 'utf8'),
).abi;
const chain = defineChain({
  id: 31337,
  name: 'Monad Local',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [d.rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(d.rpcUrl) });
const wallet = createWalletClient({ account: demo.consumer, chain, transport: http(d.rpcUrl) });
const read = (functionName, args = []) =>
  client.readContract({ address: demo.vault, abi, functionName, args });
const factoryAbi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongFactory.json'), 'utf8'),
).abi;
const readFactory = (functionName, args = []) =>
  client.readContract({ address: d.factory, abi: factoryAbi, functionName, args });
const readSecond = (functionName, args = []) =>
  client.readContract({ address: demo.secondVault, abi, functionName, args });
const registryAbi = JSON.parse(
  await fs.readFile(path.join(root, 'contracts/out/js/AnXinChongUserRegistry.json'), 'utf8'),
).abi;
const readProfile = (account) =>
  client.readContract({
    address: d.userRegistry,
    abi: registryAbi,
    functionName: 'getProfile',
    args: [account],
  });
const output = path.join(root, 'evidence/acceptance');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath(),
});
const errors = [];
const reports = [];
async function until(action, predicate, description) {
  const timeout = Date.now() + 30000;
  while (Date.now() < timeout) {
    const value = await action();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out: ${description}`);
}
async function context(account) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await c.addInitScript(
    ({ account, rpc }) => {
      const listeners = new Map();
      const provider = {
        isMetaMask: true,
        on(event, listener) {
          const list = listeners.get(event) ?? [];
          list.push(listener);
          listeners.set(event, list);
        },
        removeListener(event, listener) {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((l) => l !== listener),
          );
        },
        async request({ method, params = [] }) {
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
          if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions')
            return [{ parentCapability: 'eth_accounts' }];
          if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain')
            return null;
          const response = await fetch(rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
          });
          const json = await response.json();
          if (json.error)
            throw Object.assign(new Error(json.error.message), {
              code: json.error.code,
              data: json.error.data,
            });
          return json.result;
        },
      };
      Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
    },
    { account, rpc: d.rpcUrl },
  );
  return c;
}
async function pageFor(c, path_) {
  const page = await c.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + path_);
  return page;
}
async function connect(page) {
  const button = page.getByRole('button', { name: '连接钱包', exact: true });
  await button.or(page.locator('.wallet-address')).first().waitFor();
  if (await button.isVisible()) await button.click();
  await page.locator('.wallet-address').waitFor();
}
async function selectMember(page, id, planName) {
  const table = page.getByRole('table', { name: '我的会员列表', exact: true });
  const row = table
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: `#${id}`, exact: true }) });
  await row.getByText('@demo_consumer', { exact: true }).waitFor();
  await row.getByText('小明的新昵称', { exact: true }).waitFor();
  await row.getByText(planName, { exact: true }).waitFor();
  await row.getByRole('button', { name: '创建消费', exact: true }).click();
  await until(
    () => page.getByLabel('会员账户 ID', { exact: true }).inputValue(),
    (value) => value === id.toString(),
    'member selection prefills the correct account',
  );
  assert.equal(
    await page
      .getByLabel('储值卡填消费原价，次数卡填次数')
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page.getByLabel('完整账单链接').count(),
    0,
    'Previous account bill is cleared',
  );
  await until(
    () =>
      page.locator('.bill-composer').evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.top < innerHeight && box.bottom > 0;
      }),
    Boolean,
    'scroll to bill composer',
  );
  return row;
}
const consumerContext = await context(demo.consumer);
const merchantContext = await context(demo.merchant);
try {
  const consumer = await pageFor(consumerContext, '#/');
  await connect(consumer);
  assert.equal((await readProfile(demo.consumer)).handle, '');
  await consumer.goto(`${base}#/buy/${demo.vault}/1`);
  await consumer.getByRole('heading', { name: '请先注册用户资料', exact: true }).waitFor();
  assert.equal(await consumer.getByRole('button', { name: '授权并购买', exact: true }).count(), 0);
  await consumer.getByRole('link', { name: '去注册用户资料', exact: true }).click();
  await consumer.getByLabel('Handle（永久用户名）', { exact: true }).fill('demo_consumer');
  await consumer.getByLabel('昵称', { exact: true }).fill('小明');
  await consumer.getByRole('checkbox').check();
  await consumer.getByRole('button', { name: '确认注册到链上', exact: true }).click();
  await until(
    () => readProfile(demo.consumer),
    (p) => p.handle === 'demo_consumer',
    'on-chain user registration',
  );
  await consumer.getByRole('heading', { name: '我的链上资料', exact: true }).waitFor();
  assert.equal(
    await consumer.getByLabel('Handle（永久用户名）', { exact: true }).isEditable(),
    false,
  );
  reports.push({ scenario: 'mandatory-user-registration-before-purchase', result: 'pass' });
  await consumer.getByLabel('昵称', { exact: true }).fill('小明的新昵称');
  await consumer.getByRole('button', { name: '保存昵称到链上', exact: true }).click();
  await until(
    () => readProfile(demo.consumer),
    (p) => p.nickname === '小明的新昵称',
    'on-chain nickname change',
  );
  assert.equal((await readProfile(demo.consumer)).handle, 'demo_consumer');
  await consumer.locator('.wallet-address').filter({ hasText: '@demo_consumer' }).waitFor();
  await consumer.screenshot({
    path: path.join(output, 'user-profile-desktop.png'),
    fullPage: true,
  });
  await consumer.getByRole('link', { name: '继续使用业务功能', exact: true }).click();
  await consumer.getByRole('heading', { name: '购买会员计划', exact: true }).waitFor();
  reports.push({
    scenario: 'immutable-handle-editable-nickname-and-return-to-business',
    result: 'pass',
  });
  await consumer.goto(base);
  const merchant = await pageFor(merchantContext, '#/merchant-console');
  await connect(merchant);
  await merchant.getByRole('heading', { name: '会员计划列表', exact: true }).waitFor();
  await merchant.getByRole('heading', { name: '我的会员', exact: true }).waitFor();
  assert.equal(
    await merchant.getByRole('heading', { name: '商家认可的邀请关系', exact: true }).count(),
    0,
  );
  assert.equal(await merchant.getByLabel('邀请者地址（留空清除）').count(), 0);
  assert.equal(await merchant.getByRole('link', { name: 'Monad 开发文档' }).count(), 0);
  assert.equal(await merchant.getByLabel('店铺名称', { exact: true }).isVisible(), false);
  assert.equal(await merchant.getByLabel('计划名称', { exact: true }).isVisible(), false);
  assert.equal(
    await merchant.locator('main section').nth(1).getByRole('heading').innerText(),
    '会员计划列表',
  );
  await merchant.screenshot({
    path: path.join(output, 'merchant-console-desktop.png'),
    fullPage: true,
  });
  await merchant.getByRole('button', { name: '店铺资料', exact: true }).click();
  const profileDialog = merchant.getByRole('dialog', { name: '店铺资料', exact: true });
  await profileDialog.waitFor();
  assert.equal(
    await profileDialog.getByLabel('店铺名称', { exact: true }).inputValue(),
    '青禾生活馆',
  );
  await merchant.screenshot({
    path: path.join(output, 'merchant-profile-dialog.png'),
    fullPage: true,
  });
  await profileDialog.getByLabel('店铺名称', { exact: true }).fill('青禾生活馆（更新）');
  await profileDialog.getByRole('button', { name: '保存店铺资料', exact: true }).click();
  await profileDialog.waitFor({ state: 'hidden' });
  assert.equal((await readFactory('getMerchant', [1n])).name, '青禾生活馆（更新）');
  reports.push({
    scenario: 'merchant-profile-dialog-updates-on-chain-and-closes-on-confirmation',
    result: 'pass',
  });
  for (const [mode, name] of [
    ['储值折扣', '弹窗储值计划'],
    ['次数套餐', '弹窗次数计划'],
  ]) {
    const count = await read('planVersionCount');
    await merchant.getByRole('button', { name: '新建会员计划', exact: true }).click();
    const dialog = merchant.getByRole('dialog', { name: '新建会员计划', exact: true });
    assert.equal(await dialog.getByText('交易已确认', { exact: false }).count(), 0);
    await dialog.getByRole('button', { name: mode, exact: true }).click();
    await dialog.getByLabel('计划名称', { exact: true }).fill(name);
    if (mode === '储值折扣') {
      await dialog.getByLabel('消费实付比例（%）', { exact: true }).fill('101');
      await dialog.getByRole('button', { name: '发布会员计划', exact: true }).click();
      await dialog.getByText('比例不能超过 100%', { exact: true }).waitFor();
      assert.equal(await read('planVersionCount'), count);
      await dialog.getByLabel('消费实付比例（%）', { exact: true }).fill('90');
      await merchant.screenshot({
        path: path.join(output, 'merchant-plan-dialog-desktop.png'),
        fullPage: true,
      });
    } else {
      const fixedUnits = dialog.getByLabel('固定次数（次）', { exact: true });
      for (const invalid of ['0', '1.5', '-2']) {
        await fixedUnits.fill(invalid);
        assert.equal(await fixedUnits.evaluate((input) => input.checkValidity()), false);
        await dialog.getByRole('button', { name: '发布会员计划', exact: true }).click();
        assert.equal(await read('planVersionCount'), count);
      }
      await fixedUnits.fill('12');
    }
    await dialog.getByRole('button', { name: '发布会员计划', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await read('planVersionCount'), count + 1n);
    if (mode === '次数套餐') {
      assert.equal((await read('getPlanVersion', [count + 1n])).minUnits, 12n);
    }
    await merchant.getByRole('cell', { name: new RegExp(`^${name}`) }).waitFor();
  }
  await merchant.setViewportSize({ width: 390, height: 844 });
  await merchant.screenshot({
    path: path.join(output, 'merchant-console-mobile.png'),
    fullPage: true,
  });
  assert.equal(
    await merchant.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await merchant.getByRole('button', { name: '新建会员计划', exact: true }).click();
  const mobileDialog = merchant.getByRole('dialog', { name: '新建会员计划', exact: true });
  await mobileDialog.waitFor();
  await merchant.screenshot({
    path: path.join(output, 'merchant-plan-dialog-mobile.png'),
    fullPage: false,
  });
  assert.equal(
    await mobileDialog.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  await merchant.keyboard.press('Escape');
  await mobileDialog.waitFor({ state: 'hidden' });
  assert.equal(
    await merchant
      .getByRole('button', { name: '新建会员计划', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await merchant.setViewportSize({ width: 1440, height: 1080 });
  reports.push({
    scenario: 'merchant-plan-dialog-both-modes-validation-mobile-and-keyboard',
    result: 'pass',
  });
  await consumer.locator('.shop-card').last().waitFor();
  await consumer.screenshot({ path: path.join(output, 'market-desktop.png'), fullPage: true });
  for (const scenario of [
    {
      name: 'stored-refund',
      plan: 1,
      input: '500',
      spend: '200',
      refund: 300_000000n,
      topup: 20_000000n,
      remaining: 320_000000n,
    },
    {
      name: 'count-refund',
      plan: 2,
      input: '10',
      spend: '3',
      refund: 316_000000n,
      topup: 90_000000n,
      remaining: 406_000000n,
    },
    {
      name: 'count-zero-refund',
      plan: 2,
      input: '10',
      spend: '7',
      refund: 0n,
      topup: 174_000000n,
      remaining: 174_000000n,
    },
  ]) {
    const before = await read('membershipCount');
    await consumer.goto(`${base}#/buy/${demo.vault}/${scenario.plan}`);
    await connect(consumer);
    if (scenario.plan === 1) {
      await consumer.getByLabel('充值金额（USDC）').fill(scenario.input);
    } else {
      await consumer.getByText('10 次 / 张', { exact: true }).waitFor();
      assert.equal(await consumer.getByRole('textbox').count(), 0);
    }
    if (scenario.name === 'stored-refund') {
      // Allow approval, then reject only the purchase transaction.
      const rpcPattern = `${new URL(d.rpcUrl).origin}/**`;
      const rejectPurchase = async (route) => {
        const body = route.request().postDataJSON();
        if (
          body.method === 'eth_sendTransaction' &&
          body.params[0]?.data?.startsWith(
            encodeFunctionData({
              abi,
              functionName: 'buy',
              args: [1n, 1n, `0x${'00'.repeat(32)}`],
            }).slice(0, 10),
          )
        ) {
          await route.fulfill({
            json: {
              jsonrpc: '2.0',
              id: body.id,
              error: { code: 4001, message: 'User rejected purchase' },
            },
          });
        } else await route.continue();
      };
      await consumer.route(rpcPattern, rejectPurchase);
      await consumer.getByRole('button', { name: '授权并购买', exact: true }).click();
      await consumer
        .locator('.notice.danger')
        .filter({ hasText: /rejected|拒绝/i })
        .waitFor();
      assert.ok(consumer.url().endsWith(`#/buy/${demo.vault}/1`));
      assert.equal(await read('membershipCount'), before);
      await consumer.unroute(rpcPattern, rejectPurchase);
    }
    await consumer.getByRole('button', { name: '授权并购买', exact: true }).click();
    const id = before + 1n;
    await until(
      () => read('membershipCount'),
      (n) => n === id,
      'purchase membership',
    );
    await consumer.waitForURL('**/#/cards');
    await consumer.getByRole('heading', { name: '我的会员卡', exact: true }).waitFor();
    if (scenario.name === 'stored-refund') {
      reports.push({
        scenario: 'purchase-confirmed-navigation-and-rejected-buy-stays-on-form',
        result: 'pass',
      });
    }
    assert.equal(
      (await read('getMembership', [id])).remainingPrincipal,
      scenario.plan === 1 ? 500_000000n : 580_000000n,
    );
    if (scenario.plan === 2) {
      assert.equal((await read('getMembership', [id])).purchasedUnits, 10n);
    }
    const memberRow = await selectMember(
      merchant,
      id,
      scenario.plan === 1 ? '安心储值 · 500 享九折' : '轻松理发 · 十次护理卡',
    );
    if (scenario.name === 'stored-refund') {
      await merchant.screenshot({
        path: path.join(output, 'merchant-members-desktop.png'),
        fullPage: true,
      });
      await merchant.setViewportSize({ width: 390, height: 844 });
      await selectMember(merchant, id, '安心储值 · 500 享九折');
      assert.equal(
        await merchant.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await merchant.screenshot({
        path: path.join(output, 'merchant-members-mobile.png'),
        fullPage: true,
      });
      await merchant.setViewportSize({ width: 1440, height: 1080 });
    }
    await merchant.getByLabel('储值卡填消费原价，次数卡填次数').fill(scenario.spend);
    await merchant.getByLabel('服务说明', { exact: true }).fill('理发服务 · 双端验收');
    const old = (await merchant.getByLabel('完整账单链接').count())
      ? await merchant.getByLabel('完整账单链接').inputValue()
      : '';
    await merchant.getByRole('button', { name: '签名并生成账单', exact: true }).click();
    await merchant.getByLabel('完整账单链接').waitFor({ state: 'attached' });
    const link = await until(
      () => merchant.getByLabel('完整账单链接').inputValue(),
      (value) => value !== old && value.includes('#/pay?vault='),
      'merchant bill signature',
    );
    const encoded = new URLSearchParams(new URL(link).hash.split('?')[1]).get('bill');
    const envelope = decodeEnvelope(encoded, 31337, demo.vault);
    assert.equal(envelope.bill.membershipId, id);
    const contractDigest = await read('billDigest', [envelope.bill]);
    assert.equal(
      contractDigest,
      hashTypedData({
        domain: billDomain(31337, demo.vault),
        types: BILL_TYPES,
        primaryType: 'Bill',
        message: envelope.bill,
      }),
      'Solidity and viem EIP-712 digests must match',
    );
    if (scenario.name === 'stored-refund' || scenario.name === 'count-refund') {
      const qrFile = path.join(root, '.cache', `bill-qr-${scenario.name}.png`);
      await merchant
        .getByRole('img', { name: '消费账单二维码', exact: true })
        .screenshot({ path: qrFile });
      await merchant
        .locator('.bill-output')
        .screenshot({ path: path.join(output, `bill-share-${scenario.name}.png`) });
      if (scenario.name === 'stored-refund') {
        assert.equal(await merchant.getByLabel('完整账单链接').isVisible(), false);
        await merchant.getByRole('button', { name: '放大账单二维码', exact: true }).click();
        await merchant.getByRole('dialog', { name: '扫码确认本次消费', exact: true }).waitFor();
        await merchant.getByRole('button', { name: '关闭弹窗', exact: true }).click();
        await consumer.goto(`${base}#/cards`);
        await consumer.getByRole('button', { name: '扫码消费', exact: true }).click();
        const scanner = consumer.getByRole('dialog', { name: '扫码消费', exact: true });
        await consumer.screenshot({
          path: path.join(output, 'bill-scanner-desktop.png'),
          fullPage: false,
        });
        await scanner.getByText('也可以粘贴账单链接', { exact: true }).click();
        await scanner.getByLabel('账单链接', { exact: true }).fill('https://example.com/');
        await scanner.getByRole('button', { name: '进入消费确认', exact: true }).click();
        await scanner.getByText('这不是安心充消费账单二维码', { exact: true }).waitFor();
        await scanner.getByLabel('识别二维码图片', { exact: true }).setInputFiles(qrFile);
        await consumer.getByRole('heading', { name: '确认本次消费', exact: true }).waitFor();
        reports.push({
          scenario: 'real-qr-image-scan-to-local-confirmation-with-invalid-link-rejection',
          result: 'pass',
        });
      } else {
        // Canvas stream simulates a camera; this never accesses a physical camera.
        await consumer.bringToFront();
        await consumerContext.addInitScript(
          ({ png }) => {
            window.__testCameraMode = 'deny';
            window.__testCameraTracks = [];
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
              configurable: true,
              value: async () => {
                if (window.__testCameraMode === 'deny')
                  throw new DOMException('Denied', 'NotAllowedError');
                const image = new Image();
                image.src = png;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = 1000;
                canvas.height = 1000;
                const context = canvas.getContext('2d');
                context.fillStyle = '#fff';
                context.fillRect(0, 0, 1000, 1000);
                if (window.__testCameraMode !== 'blank') context.drawImage(image, 0, 0, 1000, 1000);
                const stream = canvas.captureStream(10);
                const frames = setInterval(() => {
                  context.fillStyle = '#fff';
                  context.fillRect(0, 0, 1000, 1000);
                  if (window.__testCameraMode !== 'blank') {
                    context.imageSmoothingEnabled = false;
                    context.drawImage(image, 0, 0, 1000, 1000);
                  }
                }, 100);
                stream.getTracks().forEach((track) => {
                  const stop = track.stop.bind(track);
                  track.stop = () => {
                    clearInterval(frames);
                    stop();
                  };
                });
                window.__testCameraTracks.push(...stream.getTracks());
                return stream;
              },
            });
          },
          { png: `data:image/png;base64,${(await fs.readFile(qrFile)).toString('base64')}` },
        );
        await consumer.goto(`${base}#/cards`);
        // A hash-route change keeps the current document; reload to install the mock.
        await consumer.reload();
        assert.equal(await consumer.evaluate(() => Array.isArray(window.__testCameraTracks)), true);
        await consumer.getByRole('button', { name: '扫码消费', exact: true }).click();
        let scanner = consumer.getByRole('dialog', { name: '扫码消费', exact: true });
        await scanner.getByRole('button', { name: '开启摄像头', exact: true }).click();
        await scanner.getByText(/摄像头未获授权/).waitFor();
        await consumer.evaluate(() => {
          window.__testCameraMode = 'blank';
        });
        await scanner.getByRole('button', { name: '开启摄像头', exact: true }).click();
        await scanner
          .getByRole('button', { name: '关闭摄像头', exact: true })
          .waitFor()
          .catch(async (error) => {
            console.log('Camera diagnostic:', await scanner.innerText());
            throw error;
          });
        await scanner.getByRole('button', { name: '关闭弹窗', exact: true }).click();
        assert.equal(
          await consumer.evaluate(() =>
            window.__testCameraTracks.every((track) => track.readyState === 'ended'),
          ),
          true,
        );
        await consumer.setViewportSize({ width: 390, height: 844 });
        await consumer.getByRole('button', { name: '扫码消费', exact: true }).click();
        scanner = consumer.getByRole('dialog', { name: '扫码消费', exact: true });
        await consumer.screenshot({
          path: path.join(output, 'bill-scanner-mobile.png'),
          fullPage: false,
        });
        assert.equal(
          await scanner.evaluate((element) => element.scrollWidth > element.clientWidth),
          false,
        );
        await consumer.evaluate(() => {
          window.__testCameraMode = 'qr';
        });
        await scanner.getByRole('button', { name: '开启摄像头', exact: true }).click();
        await consumer.getByRole('heading', { name: '确认本次消费', exact: true }).waitFor();
        assert.equal(
          await consumer.evaluate(() =>
            window.__testCameraTracks.every((track) => track.readyState === 'ended'),
          ),
          true,
        );
        await consumer.setViewportSize({ width: 1440, height: 1080 });
        reports.push({
          scenario: 'camera-qr-decode-denial-close-cleanup-and-mobile',
          result: 'pass',
          camera: 'simulated canvas stream',
        });
      }
    } else await consumer.goto(link);
    await connect(consumer);
    await consumer.getByText('消费后预计可退金额', { exact: true }).waitFor();
    assert.equal(await consumer.getByText('商家 / 渠道 / 邀请收入', { exact: true }).count(), 0);
    await consumer.screenshot({
      path: path.join(output, `pay-confirm-${scenario.name}.png`),
      fullPage: true,
    });
    const monBefore = await client.getBalance({ address: demo.consumer });
    await consumer.getByRole('button', { name: '确认消费，签名并支付', exact: true }).click();
    await until(
      () => read('getMembership', [id]),
      (m) => m.totalActualSpend > 0n,
      'dual-signature settlement',
    );
    await consumer.getByRole('button', { name: '本次消费已结算', exact: true }).waitFor();
    const settleLink = await consumer.locator('.notice a[href*="/tx/"]').getAttribute('href');
    const settlementHash = settleLink.split('/tx/')[1];
    const transaction = await client.getTransaction({ hash: settlementHash });
    const receipt = await client.getTransactionReceipt({ hash: settlementHash });
    const monCharged = monBefore - (await client.getBalance({ address: demo.consumer }));
    assert.equal(
      monCharged,
      transaction.gas * receipt.effectiveGasPrice,
      'Monad charges the transaction gas limit',
    );
    const consumed = await read('getMembership', [id]);
    assert.equal(consumed.remainingPrincipal, scenario.remaining);
    const quote = await read('previewExit', [id]);
    assert.equal(quote.refund, scenario.refund);
    assert.equal(quote.actualTopUp, scenario.topup);
    await consumer.goto(`${base}#/cards/${demo.vault}/${id}/exit`);
    const button = consumer.getByRole('button', {
      name: scenario.refund === 0n ? '确认零退款退卡' : '按以上金额退出',
      exact: true,
    });
    await button.waitFor();
    if (scenario.refund === 0n) {
      assert.equal(await button.isDisabled(), true);
      assert.equal((await read('getMembership', [id])).lifecycle, 0);
      await consumer.getByRole('checkbox').check();
    }
    await consumer.screenshot({ path: path.join(output, `${scenario.name}.png`), fullPage: true });
    const previewSelector = encodeFunctionData({
      abi,
      functionName: 'previewExit',
      args: [id],
    }).slice(0, 10);
    const memberSelector = encodeFunctionData({
      abi,
      functionName: 'getMembership',
      args: [id],
    }).slice(0, 10);
    let previewRequestsAfterExit = 0;
    const rpcPattern = `${new URL(d.rpcUrl).origin}/**`;
    const delayMembership = async (route) => {
      const payload = route.request().postDataJSON();
      const data = payload.method === 'eth_call' ? payload.params?.[0]?.data : '';
      if (data?.startsWith(previewSelector)) previewRequestsAfterExit++;
      const response = await route.fetch();
      // Reproduce the race: account refresh takes longer than the old parallel preview.
      if (data?.startsWith(memberSelector))
        await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({ response });
    };
    await consumer.route(rpcPattern, delayMembership);
    await button.click();
    await until(
      () => read('getMembership', [id]),
      (m) => m.lifecycle === 1,
      'consumer-only exit',
    );
    const closed = await read('getMembership', [id]);
    await consumer.getByText('该账户已退出，实际退款', { exact: false }).waitFor();
    assert.equal(
      await consumer.locator('.notice.danger').count(),
      0,
      'Successful refunds do not show preview errors',
    );
    assert.equal(
      await consumer.getByRole('button', { name: /按以上金额退出|确认零退款退卡/ }).count(),
      0,
    );
    await consumer.reload();
    await consumer.getByText('该账户已退出，实际退款', { exact: false }).waitFor();
    assert.equal(
      await consumer.locator('.notice.danger').count(),
      0,
      'Closed account reload is also a success state',
    );
    assert.equal(
      previewRequestsAfterExit,
      0,
      'Closed accounts do not request previewExit after confirmation or reload',
    );
    await consumer.screenshot({
      path: path.join(output, `exit-complete-${scenario.name}.png`),
      fullPage: true,
    });
    await consumer.unroute(rpcPattern, delayMembership);
    await memberRow.getByRole('button', { name: '已退出', exact: true }).waitFor();
    assert.equal(
      await memberRow.getByRole('button', { name: '已退出', exact: true }).isDisabled(),
      true,
    );
    assert.equal(closed.refundedAmount, scenario.refund);
    assert.equal(closed.exitTopUp, scenario.topup);
    assert.equal(
      closed.initialPrincipal,
      closed.refundedAmount + closed.merchantPaid + closed.channelPaid + closed.referralPaid,
    );
    const cs = await wallet.signTypedData({
      domain: billDomain(31337, demo.vault),
      types: BILL_TYPES,
      primaryType: 'Bill',
      message: envelope.bill,
    });
    await assert.rejects(() =>
      client.simulateContract({
        address: demo.vault,
        abi,
        functionName: 'settle',
        args: [envelope.bill, envelope.merchantSignature, cs],
        account: demo.consumer,
      }),
    );
    reports.push({
      scenario: scenario.name,
      membershipId: id.toString(),
      refund: closed.refundedAmount.toString(),
      topUp: closed.exitTopUp.toString(),
      settlementTransaction: settlementHash,
      gasLimit: transaction.gas.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      monChargedWei: monCharged.toString(),
      result: 'pass',
    });
  }
  reports.push({
    scenario: 'merchant-member-identity-plan-selection-scroll-mobile-and-closed-state',
    result: 'pass',
  });
  reports.push({
    scenario: 'refund-success-terminal-page-and-reload-under-delayed-state-refresh',
    result: 'pass',
  });
  // Each vault starts numbering cards at 1. The UI must preserve both identities.
  const secondBefore = await readSecond('membershipCount');
  await consumer.goto(`${base}#/buy/${demo.secondVault}/1`);
  await consumer.getByLabel('充值金额（USDC）').fill('100');
  await consumer.getByRole('button', { name: '授权并购买', exact: true }).click();
  await until(
    () => readSecond('membershipCount'),
    (n) => n === secondBefore + 1n,
    'second vault purchase',
  );
  await consumer.waitForURL('**/#/cards');
  assert.equal(
    (await readSecond('getMembership', [secondBefore + 1n])).remainingPrincipal,
    100_000000n,
  );
  assert.equal(
    await client.readContract({
      address: d.asset,
      abi: (await import('viem')).erc20Abi,
      functionName: 'balanceOf',
      args: [d.factory],
    }),
    0n,
  );
  await consumer.goto(`${base}#/cards`);
  await consumer.locator(`a.membership-card[href*="${demo.vault}"]`).first().waitFor();
  await consumer.locator(`a.membership-card[href*="${demo.secondVault}"]`).first().waitFor();
  await consumer
    .locator('a.membership-card')
    .filter({ hasText: '青禾生活馆（更新）' })
    .filter({ hasText: '安心储值 · 500 享九折' })
    .first()
    .waitFor();
  await consumer
    .locator('a.membership-card')
    .filter({ hasText: '木禾咖啡' })
    .filter({ hasText: '咖啡储值卡' })
    .first()
    .waitFor();
  assert.equal(await consumer.getByText(/商家 #\d+ · 会员账户/).count(), 0);
  await consumer.screenshot({
    path: path.join(output, 'membership-names-desktop.png'),
    fullPage: true,
  });
  await consumer.setViewportSize({ width: 390, height: 844 });
  await consumer.screenshot({
    path: path.join(output, 'membership-names-mobile.png'),
    fullPage: true,
  });
  assert.equal(
    await consumer.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await consumer.setViewportSize({ width: 1440, height: 1080 });
  reports.push({
    scenario: 'two-vault-card-discovery-and-isolation',
    vault: demo.secondVault,
    result: 'pass',
  });

  const secondContext = await context(demo.secondMerchant);
  try {
    const secondPage = await pageFor(secondContext, '#/merchant-console');
    await connect(secondPage);
    await selectMember(secondPage, secondBefore + 1n, '咖啡储值卡');
    await secondPage.getByLabel('储值卡填消费原价，次数卡填次数').fill('40');
    await secondPage.getByLabel('服务说明', { exact: true }).fill('第二家商家消费');
    const otherEscrow = await read('totalEscrowed');
    await secondPage.getByRole('button', { name: '签名并生成账单', exact: true }).click();
    await secondPage.getByLabel('完整账单链接').waitFor({ state: 'attached' });
    const secondLink = await secondPage.getByLabel('完整账单链接').inputValue();
    await consumer.goto(secondLink);
    await consumer.getByRole('button', { name: '确认消费，签名并支付', exact: true }).click();
    await consumer.getByRole('button', { name: '本次消费已结算', exact: true }).waitFor();
    assert.equal(
      (await readSecond('getMembership', [secondBefore + 1n])).remainingPrincipal,
      60_000000n,
    );
    assert.equal(await read('totalEscrowed'), otherEscrow);
    reports.push({
      scenario: 'second-merchant-dual-signature-settlement',
      vault: demo.secondVault,
      result: 'pass',
    });

    const original = decodeEnvelope(
      new URLSearchParams(new URL(secondLink).hash.split('?')[1]).get('bill'),
      31337,
      demo.secondVault,
    );
    // A registered but different URL target must fail before asking the consumer to sign.
    await consumer.goto(`${base}#/pay?vault=${demo.vault}&bill=${encodeEnvelope(original)}`);
    await consumer.getByText('账单版本、网络或合约不匹配', { exact: true }).waitFor();
    assert.equal(
      await consumer.getByRole('button', { name: '确认消费，签名并支付', exact: true }).count(),
      0,
    );
    for (const target of [d.factory, d.asset]) {
      const foreign = { ...original, verifyingContract: target };
      await consumer.goto(`${base}#/pay?vault=${target}&bill=${encodeEnvelope(foreign)}`);
      await consumer.getByText('该金库不属于当前工厂，无法操作', { exact: true }).waitFor();
      assert.equal(
        await consumer
          .getByRole('button', { name: '确认消费，签名并支付', exact: true })
          .isDisabled(),
        true,
      );
    }
    reports.push({
      scenario: 'bill-rejects-mismatched-unregistered-and-factory-targets',
      result: 'pass',
    });
  } finally {
    await secondContext.close();
  }

  const channelContext = await context(demo.channel);
  try {
    const channel = await pageFor(channelContext, '#/commissions');
    await connect(channel);
    const expected =
      (await read('getRecipientStats', [demo.channel]))[0] +
      (await readSecond('getRecipientStats', [demo.channel]))[0];
    await channel
      .locator('.stats-grid .amount')
      .first()
      .filter({ hasText: (Number(expected) / 1e6).toFixed(2) })
      .waitFor();
    await channel.locator(`a[href*="/cards/${demo.vault}/"]`).first().waitFor();
    await channel.locator(`a[href*="/cards/${demo.secondVault}/"]`).first().waitFor();
    reports.push({ scenario: 'cross-vault-commission-aggregation-and-history', result: 'pass' });
  } finally {
    await channelContext.close();
  }

  const thirdContext = await context(demo.thirdMerchant);
  try {
    const third = await pageFor(thirdContext, '#/merchant-console');
    await connect(third);
    const before = await readFactory('merchantCount');
    await third.getByRole('heading', { name: '请先注册用户资料', exact: true }).waitFor();
    await third.getByRole('link', { name: '去注册用户资料', exact: true }).click();
    await third.getByLabel('Handle（永久用户名）', { exact: true }).fill('demo_consumer');
    await third.getByLabel('昵称', { exact: true }).fill('新商家');
    await third.getByRole('checkbox').check();
    await third.getByText('这个 handle 已被注册，请换一个。', { exact: true }).waitFor();
    assert.equal(
      await third.getByRole('button', { name: '确认注册到链上', exact: true }).isDisabled(),
      true,
    );
    await third.getByLabel('Handle（永久用户名）', { exact: true }).fill('third_merchant');
    await third.getByRole('checkbox').check();
    await third.getByRole('button', { name: '确认注册到链上', exact: true }).click();
    await until(
      () => readProfile(demo.thirdMerchant),
      (p) => p.handle === 'third_merchant',
      'third merchant user registration',
    );
    await third.getByRole('link', { name: '继续使用业务功能', exact: true }).click();
    reports.push({ scenario: 'duplicate-handle-rejected-and-merchant-onboarding', result: 'pass' });
    await third.getByLabel('店铺名称', { exact: true }).fill('浏览器注册商家');
    await third.getByRole('button', { name: '注册并创建独立金库', exact: true }).click();
    await until(
      () => readFactory('merchantCount'),
      (n) => n === before + 1n,
      'factory registration in browser',
    );
    await third.getByRole('button', { name: '店铺资料', exact: true }).waitFor();
    const info = await readFactory('getMerchant', [before + 1n]);
    assert.notEqual(info.vault.toLowerCase(), demo.vault.toLowerCase());
    assert.notEqual(info.vault.toLowerCase(), demo.secondVault.toLowerCase());
    assert.equal(info.owner.toLowerCase(), demo.thirdMerchant.toLowerCase());
    reports.push({
      scenario: 'factory-creates-vault-from-merchant-console',
      vault: info.vault,
      result: 'pass',
    });
  } finally {
    await thirdContext.close();
  }

  const fresh = await context(demo.consumer);
  const restored = await pageFor(fresh, '#/cards');
  await connect(restored);
  await restored.locator('.wallet-address').filter({ hasText: '小明的新昵称' }).waitFor();
  await restored
    .getByRole('heading', { name: '青禾生活馆（更新）', exact: true })
    .first()
    .waitFor();
  await restored.goto(
    `${base}#/cards/${demo.vault}/${reports.find((r) => r.scenario === 'stored-refund').membershipId}`,
  );
  await restored.getByRole('heading', { name: '账户已退出', exact: true }).waitFor();
  await restored.getByRole('link', { name: '查看交易', exact: false }).first().waitFor();
  reports.push({ scenario: 'fresh-browser-chain-recovery', result: 'pass' });
  // Give merchant #21 a real escrow balance to catch totals limited to page 1.
  let lastOwner;
  let lastVault;
  while ((await readFactory('merchantCount')) < 21n) {
    const id = (await readFactory('merchantCount')) + 1n;
    const account = `0x${(1000n + id).toString(16).padStart(40, '0')}`;
    await client.request({ method: 'anvil_setBalance', params: [account, '0x3635c9adc5dea00000'] });
    await client.request({ method: 'anvil_impersonateAccount', params: [account] });
    lastOwner = createWalletClient({ account, chain, transport: http(d.rpcUrl) });
    for (const request of [
      {
        address: d.userRegistry,
        abi: registryAbi,
        functionName: 'registerUser',
        args: [`market_${id}`, `分页商家${id}`],
      },
      {
        address: d.factory,
        abi: factoryAbi,
        functionName: 'registerMerchant',
        args: [{ name: `分页商家${id}`, description: '全平台托管合计验收' }, account],
      },
    ]) {
      const hash = await lastOwner.writeContract(request);
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
    }
    lastVault = await readFactory('vaultOf', [id]);
  }
  const planHash = await lastOwner.writeContract({
    address: lastVault,
    abi,
    functionName: 'createPlanVersion',
    args: [
      {
        merchantId: 21n,
        previousVersionId: 0n,
        mode: 0,
        name: '第21家储值计划',
        description: '分页之外的本金',
        minDeposit: 7_000000n,
        discountBps: 9000n,
        minUnits: 0n,
        listUnitPrice: 0n,
        saleUnitPrice: 0n,
        channelRecipient: '0x0000000000000000000000000000000000000000',
        channelBps: 0n,
        referralBps: 0n,
      },
    ],
  });
  assert.equal((await client.waitForTransactionReceipt({ hash: planHash })).status, 'success');
  await consumer.goto(`${base}#/buy/${lastVault}/1`);
  await consumer.getByLabel('充值金额（USDC）').fill('7');
  await consumer.getByRole('button', { name: '授权并购买', exact: true }).click();
  await consumer.waitForURL('**/#/cards');
  let expectedTotal = 0n;
  for (let id = 1n; id <= 21n; id++) {
    const vault = await readFactory('vaultOf', [id]);
    expectedTotal += await client.readContract({
      address: vault,
      abi,
      functionName: 'totalEscrowed',
    });
  }
  await consumer.goto(base + '#/');
  const globalStat = consumer.locator('.stat').filter({ hasText: '全部商家托管余额' });
  await until(
    () => globalStat.locator('.amount').innerText(),
    (text) => text.replace(d.assetSymbol, '').trim() === (Number(expectedTotal) / 1e6).toString(),
    'all merchants escrow including merchant 21',
  );
  assert.equal(await consumer.locator('.shop-card').count(), 20);
  assert.equal(await consumer.getByRole('heading', { name: '分页商家21', exact: true }).count(), 0);
  await consumer.getByRole('button', { name: '下一页', exact: true }).click();
  await consumer.getByRole('heading', { name: '分页商家21', exact: true }).waitFor();
  assert.equal(await consumer.locator('.shop-card').count(), 1);
  assert.equal(
    (await globalStat.locator('.amount').innerText()).replace(d.assetSymbol, '').trim(),
    (Number(expectedTotal) / 1e6).toString(),
  );
  await consumer.screenshot({
    path: path.join(output, 'market-global-escrow-page-2.png'),
    fullPage: true,
  });
  reports.push({
    scenario: 'global-escrow-includes-merchant-21-and-is-independent-of-pagination',
    merchants: 21,
    totalEscrowed: expectedTotal.toString(),
    result: 'pass',
  });
  await restored.setViewportSize({ width: 390, height: 844 });
  await restored.goto(base + '#/');
  await restored.getByRole('heading', { name: '预付有约，消费安心', exact: true }).waitFor();
  await restored.locator('.shop-card').last().waitFor();
  await restored.screenshot({ path: path.join(output, 'market-mobile.png'), fullPage: true });
  assert.equal(
    await restored.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    'No mobile horizontal overflow',
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await fs.writeFile(
    path.join(output, 'browser-smoke.json'),
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        environment: 'Local Anvil Monad execution, isolated injected test-wallet providers',
        chainId: 31337,
        factory: d.factory,
        userRegistry: d.userRegistry,
        vault: demo.vault,
        secondVault: demo.secondVault,
        reports,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ passed: reports.length, reports, errors }, null, 2));
} finally {
  await browser.close();
}
