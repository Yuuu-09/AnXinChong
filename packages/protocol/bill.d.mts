import type { Address, Hex } from 'viem';
export type Bill = {
  membershipId: bigint;
  termsHash: Hex;
  merchantSigner: Address;
  consumer: Address;
  mode: number;
  originalValue: bigint;
  discountBps: bigint;
  debitAmount: bigint;
  units: bigint;
  orderId: Hex;
  nonce: bigint;
  issuedAt: bigint;
  deadline: bigint;
  serviceHash: Hex;
};
export type Envelope = {
  schemaVersion: 1;
  chainId: number;
  verifyingContract: Address;
  bill: Bill;
  merchantSignature: Hex;
  serviceText: string;
};
export const BILL_TYPES: {
  readonly Bill: readonly {
    readonly name: string;
    readonly type: 'uint256' | 'uint8' | 'bytes32' | 'address';
  }[];
};
export function billDomain(
  chainId: number,
  verifyingContract: Address,
): { name: 'AnXinChong'; version: '1'; chainId: number; verifyingContract: Address };
export function serviceHash(text: string): Hex;
export function encodeEnvelope(envelope: Envelope): string;
export function decodeEnvelope(encoded: string, chainId: number, contract: Address): Envelope;
export function decodeBillLink(
  value: string,
  chainId: number,
): { vault: Address; encoded: string; envelope: Envelope; route: string };
