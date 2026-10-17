export const BPS: bigint;
export const UNIT: bigint;
export type Split = { merchant: bigint; channel: bigint; referral: bigint };
export function parseAmount(text: string): bigint;
export function formatAmount(value: bigint): string;
export function discounted(original: bigint, bps: bigint): bigint;
export function splitTargets(released: bigint, channel: bigint, referral: bigint): Split;
export function splitIncrement(
  released: bigint,
  amount: bigint,
  channel: bigint,
  referral: bigint,
): Split;
export function exitQuote(
  balance: bigint,
  original: bigint,
  spent: bigint,
): { balance: bigint; compensation: bigint; actualTopUp: bigint; refund: bigint };
