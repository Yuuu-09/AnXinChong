type Entry = { promise: Promise<unknown>; pending: boolean; expires: number };

// Values are cached only when the caller explicitly supplies a TTL. With TTL 0,
// simultaneous reads share a request, but the next read always goes to the RPC.
export class ReadCache {
  private entries = new Map<string, Entry>();

  read<T>(key: string, load: () => Promise<T>, ttl = 0): Promise<T> {
    const saved = this.entries.get(key);
    if (saved && (saved.pending || saved.expires > Date.now())) return saved.promise as Promise<T>;
    const entry: Entry = { pending: true, expires: 0, promise: Promise.resolve() };
    entry.promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          entry.pending = false;
          entry.expires = Date.now() + ttl;
          if (ttl === 0 && this.entries.get(key) === entry) this.entries.delete(key);
          return value;
        },
        (error) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        },
      );
    this.entries.set(key, entry);
    if (this.entries.size > 512) {
      for (const [oldKey, oldEntry] of this.entries) {
        if (!oldEntry.pending && oldKey !== key) this.entries.delete(oldKey);
        if (this.entries.size <= 512) break;
      }
    }
    return entry.promise as Promise<T>;
  }

  clear() {
    this.entries.clear();
  }
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  load: (value: T, index: number) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await load(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}
