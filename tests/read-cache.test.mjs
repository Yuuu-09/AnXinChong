import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadCache, mapConcurrent } from '../web/src/lib/read-cache.ts';

test('concurrent current-state reads share a request without caching the next balance', async () => {
  const cache = new ReadCache();
  let reads = 0;
  const load = async () => ++reads;
  assert.deepEqual(
    await Promise.all([cache.read('balance', load), cache.read('balance', load)]),
    [1, 1],
  );
  assert.equal(await cache.read('balance', load), 2);
});

test('metadata is reusable, failed reads are retried, and scopes stay separate', async () => {
  const cache = new ReadCache();
  let reads = 0;
  const load = async () => ++reads;
  assert.equal(await cache.read('factory-a:vault-a:plan-1', load, 30_000), 1);
  assert.equal(await cache.read('factory-a:vault-a:plan-1', load, 30_000), 1);
  assert.equal(await cache.read('factory-b:vault-a:plan-1', load, 30_000), 2);
  await assert.rejects(
    cache.read(
      'failed',
      async () => {
        throw new Error('RPC failed');
      },
      30_000,
    ),
  );
  assert.equal(await cache.read('failed', async () => 'recovered', 30_000), 'recovered');
});

test('a pre-transaction request cannot repopulate a cleared cache', async () => {
  const cache = new ReadCache();
  let finish;
  const old = cache.read(
    'plan',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    30_000,
  );
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.read('plan', async () => 'new', 30_000), 'new');
  finish('old');
  await old;
  assert.equal(await cache.read('plan', async () => 'should not be needed', 30_000), 'new');
});

test('parallel directory reads keep ordering and cap concurrency', async () => {
  let active = 0;
  let peak = 0;
  const values = [3, 1, 2, 0, 4];
  const result = await mapConcurrent(
    values,
    async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      return value * 2;
    },
    2,
  );
  assert.deepEqual(
    result,
    values.map((v) => v * 2),
  );
  assert.equal(peak, 2);
  await assert.rejects(
    mapConcurrent(values, async (value) => {
      if (value === 2) throw new Error('missing vault');
      return value;
    }),
    /missing vault/,
  );
});
