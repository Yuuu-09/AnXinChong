export const BPS = 10_000n;
export const UNIT = 1_000_000n;
export function parseAmount(text) {
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text))
    throw new Error('请输入最多六位小数的非负金额');
  const [whole, fraction = ''] = text.split('.');
  const result = BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, '0'));
  if (result >= 2n ** 256n) throw new Error('金额超出范围');
  return result;
}
export function formatAmount(value) {
  const n = BigInt(value);
  const tail = (n % UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${n / UNIT}${tail ? `.${tail}` : ''}`;
}
export function discounted(original, bps) {
  if (original <= 0n || bps <= 0n || bps > BPS) throw new Error('无效原价或折扣');
  return (original * bps + BPS - 1n) / BPS;
}
export function splitTargets(released, channelBps, referralBps) {
  const total = channelBps + referralBps;
  if ([released, channelBps, referralBps].some((x) => x < 0n) || total > BPS)
    throw new Error('无效分账参数');
  if (!total) return { merchant: released, channel: 0n, referral: 0n };
  const fees = (released * total) / BPS;
  const channel = (fees * channelBps) / total;
  return { merchant: released - fees, channel, referral: fees - channel };
}
export function splitIncrement(released, amount, channelBps, referralBps) {
  if (amount < 0n) throw new Error('无效释放金额');
  const before = splitTargets(released, channelBps, referralBps);
  const after = splitTargets(released + amount, channelBps, referralBps);
  return Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
}
export function exitQuote(balance, original, spent) {
  if (balance < 0n || original < spent || spent < 0n) throw new Error('账户累计数据错误');
  const compensation = original - spent;
  const actualTopUp = balance < compensation ? balance : compensation;
  return { balance, compensation, actualTopUp, refund: balance - actualTopUp };
}
