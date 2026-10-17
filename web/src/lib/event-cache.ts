import { get, set } from 'idb-keyval';
import type { AbiEvent, Address, Hex } from 'viem';
import { vaultAbi } from '../generated/abi.ts';

export type HistoryLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
};
type Checkpoint = { scanned: bigint; logs: HistoryLog[] };
type LogClient = {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (args: {
    address: Address;
    event: AbiEvent;
    args: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<unknown[]>;
};
const memory = new Map<string, Checkpoint>();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function scanHistory(
  client: LogClient,
  scope: {
    chainId: number;
    factory?: Address;
    address: Address;
    deploymentBlock: bigint;
    field: 'membershipId' | 'merchantId' | 'recipient';
    value: Address | bigint;
  },
  signal?: AbortSignal,
): Promise<HistoryLog[]> {
  const key = `anxinchong:events:2:${scope.chainId}:${scope.factory?.toLowerCase() ?? 'standalone'}:${scope.address.toLowerCase()}:${scope.field}:${scope.value.toString().toLowerCase()}`;
  let saved = memory.get(key);
  try {
    saved = (await get<Checkpoint>(key)) ?? saved;
  } catch {
    /* cache is optional */
  }
  const tip = await client.getBlockNumber();
  if (saved && saved.scanned > tip) saved = undefined;
  const start = saved
    ? saved.scanned > scope.deploymentBlock + 64n
      ? saved.scanned - 64n
      : scope.deploymentBlock
    : scope.deploymentBlock;
  let logs = (saved?.logs ?? []).filter((l) => l.blockNumber < start);
  const names =
    scope.field === 'recipient'
      ? ['SplitPaid']
      : scope.field === 'merchantId'
        ? ['ConsumptionSettled', 'MembershipExited']
        : ['ConsumptionSettled', 'MembershipExited', 'SplitPaid'];
  const events = vaultAbi.filter(
    (a): a is Extract<(typeof vaultAbi)[number], { type: 'event' }> =>
      a.type === 'event' && names.includes(a.name),
  );
  let from = start,
    size = 1000n,
    retries = 0;
  while (from <= tip) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const to = from + size - 1n < tip ? from + size - 1n : tip;
    try {
      const batches = await Promise.all(
        events.map((event) =>
          client.getLogs({
            address: scope.address,
            event,
            args: { [scope.field]: scope.value },
            fromBlock: from,
            toBlock: to,
          }),
        ),
      );
      const added = batches.flat().filter((l): l is HistoryLog => {
        const log = l as Partial<HistoryLog>;
        return log.blockNumber != null && log.transactionHash != null && log.logIndex != null;
      });
      logs = [...logs, ...added];
      const checkpoint = { scanned: to, logs };
      memory.set(key, checkpoint);
      try {
        await set(key, checkpoint);
      } catch {
        /* private browsing may disallow IndexedDB */
      }
      from = to + 1n;
      retries = 0;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (++retries > 5)
        throw new Error('历史记录未加载完整，请重试。' + (e instanceof Error ? e.message : ''));
      size = size > 1n ? size / 2n : 1n;
      await delay(Math.min(250 * 2 ** retries, 4000));
    }
  }
  const unique = new Map(logs.map((l) => [`${l.transactionHash}:${l.logIndex}`, l]));
  return [...unique.values()].sort((a, b) =>
    a.blockNumber < b.blockNumber
      ? -1
      : a.blockNumber > b.blockNumber
        ? 1
        : a.logIndex - b.logIndex,
  );
}
