import test from 'node:test';
import assert from 'node:assert/strict';
import { scanHistory } from '../web/src/lib/event-cache.ts';
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const address = (n) => '0x' + n.toString(16).padStart(40, '0');
const log = (block, n = 1) => ({
  eventName: 'SplitPaid',
  args: { membershipId: 1n, amount: 1n },
  blockNumber: BigInt(block),
  transactionHash: hash(n),
  logIndex: 0,
});
const scope = (n) => ({
  chainId: 31337,
  address: address(n),
  deploymentBlock: 10n,
  field: 'recipient',
  value: address(999),
});

test('history reconstructs from logs without historical eth_call', async () => {
  const calls = [];
  const logs = [log(11, 1), log(2000, 2)];
  const client = {
    getBlockNumber: async () => 2010n,
    getLogs: async (args) => {
      calls.push(args);
      return logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
    },
  };
  const result = await scanHistory(client, scope(1));
  assert.equal(result.length, 2);
  assert.equal(calls[0].fromBlock, 10n);
  assert.equal(calls.at(-1).toBlock, 2010n);
  assert.ok(calls.every((c) => c.args.recipient === address(999)));
});
test('incremental rescan replaces reorged logs and does not duplicate records', async () => {
  let tip = 100n;
  let logs = [log(20, 1), log(99, 2)];
  const client = {
    getBlockNumber: async () => tip,
    getLogs: async (args) =>
      logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock),
  };
  assert.equal((await scanHistory(client, scope(2))).length, 2);
  tip = 101n;
  logs = [log(20, 1), log(99, 3), log(101, 4)];
  const result = await scanHistory(client, scope(2));
  assert.deepEqual(
    result.map((l) => l.transactionHash),
    [hash(1), hash(3), hash(4)],
  );
  assert.equal((await scanHistory(client, scope(2))).length, 3);
});
test('range failures shrink the window without skipping unqueried blocks', async () => {
  const calls = [];
  const client = {
    getBlockNumber: async () => 30n,
    getLogs: async (args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error('range too wide');
      return [log(15, 5)].filter(
        (l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock,
      );
    },
  };
  const result = await scanHistory(client, scope(3));
  assert.equal(result.length, 1);
  assert.equal(calls[0].fromBlock, calls[1].fromBlock);
});
test('wallet and contract scopes are isolated and aborted scans do not invent empty history', async () => {
  const client = { getBlockNumber: async () => 20n, getLogs: async () => [log(15, 6)] };
  assert.equal((await scanHistory(client, scope(4))).length, 1);
  const empty = { getBlockNumber: async () => 20n, getLogs: async () => [] };
  assert.equal((await scanHistory(empty, scope(5))).length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => scanHistory(client, scope(6), controller.signal), /Aborted/);
});

test('same local card ID remains isolated by factory and vault', async () => {
  const client = { getBlockNumber: async () => 1000n, getLogs: async () => [log(15, 50)] };
  const original = { ...scope(50), factory: address(700), field: 'membershipId', value: 1n };
  assert.equal((await scanHistory(client, original)).length, 1);
  const empty = { getBlockNumber: async () => 1000n, getLogs: async () => [] };
  assert.equal((await scanHistory(empty, { ...original, address: address(51) })).length, 0);
  assert.equal((await scanHistory(empty, { ...original, factory: address(701) })).length, 0);
});
