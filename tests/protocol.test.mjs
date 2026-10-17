import test from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  UNIT,
  parseAmount,
  formatAmount,
  discounted,
  exitQuote,
  splitTargets,
  splitIncrement,
} from '../packages/protocol/math.mjs';
import {
  BILL_TYPES,
  billDomain,
  encodeEnvelope,
  decodeEnvelope,
  decodeBillLink,
  serviceHash,
} from '../packages/protocol/bill.mjs';

test('USDC parsing never uses floating point or silently truncates precision', () => {
  for (const value of ['0', '1', '500', '0.000001', '1234567890123456789.123456'])
    assert.equal(parseAmount(formatAmount(parseAmount(value))), parseAmount(value));
  for (const value of ['1.0000001', '-1', '1e6', 'NaN', '01', '', ' 1', '1.'])
    assert.throws(() => parseAmount(value));
});
test('stored value consumption and refund match the PRD', () => {
  const debit = discounted(200n * UNIT, 9000n);
  assert.equal(debit, 180n * UNIT);
  assert.deepEqual(exitQuote(500n * UNIT - debit, 200n * UNIT, debit), {
    balance: 320n * UNIT,
    compensation: 20n * UNIT,
    actualTopUp: 20n * UNIT,
    refund: 300n * UNIT,
  });
  assert.equal(discounted(1n, 9000n), 1n);
  assert.equal(discounted(11n, 9000n), 10n);
});
test('count refunds and capped compensation match all PRD examples', () => {
  for (const [count, expectedRefund, expectedTopup] of [
    [0n, 580n, 0n],
    [3n, 316n, 90n],
    [6n, 52n, 180n],
    [7n, 0n, 174n],
  ]) {
    const q = exitQuote((580n - count * 58n) * UNIT, count * 88n * UNIT, count * 58n * UNIT);
    assert.equal(q.refund, expectedRefund * UNIT);
    assert.equal(q.actualTopUp, expectedTopup * UNIT);
    assert.equal(q.refund + q.actualTopUp + count * 58n * UNIT, 580n * UNIT);
  }
});
test('commission carries cannot cause a negative merchant payment', () => {
  assert.deepEqual(splitIncrement(0n, 1n, 5000n, 5000n), {
    merchant: 0n,
    channel: 0n,
    referral: 1n,
  });
  assert.deepEqual(splitIncrement(1n, 1n, 5000n, 5000n), {
    merchant: 0n,
    channel: 1n,
    referral: 0n,
  });
  assert.deepEqual(splitTargets(100n * UNIT, 200n, 300n), {
    merchant: 95n * UNIT,
    channel: 2n * UNIT,
    referral: 3n * UNIT,
  });
});
test('10000 deterministic distribution cases conserve funds and are split-independent', () => {
  let seed = 10143n;
  const random = (max) => {
    seed = (1664525n * seed + 1013904223n) % 2n ** 32n;
    return seed % max;
  };
  for (let n = 0; n < 10000; n++) {
    const c = random(10001n),
      i = random(10001n - c),
      u = random(10n ** 15n),
      amount = random(10n ** 12n),
      part = random(amount + 1n);
    const whole = splitIncrement(u, amount, c, i),
      a = splitIncrement(u, part, c, i),
      b = splitIncrement(u + part, amount - part, c, i);
    assert.equal(whole.merchant + whole.channel + whole.referral, amount);
    for (const key of Object.keys(whole)) {
      assert.ok(whole[key] >= 0n);
      assert.equal(a[key] + b[key], whole[key]);
    }
  }
});

const contract = '0x1111111111111111111111111111111111111111';
const merchant = privateKeyToAccount('0x' + '11'.repeat(32));
const bill = {
  membershipId: 2n ** 200n,
  termsHash: '0x' + '22'.repeat(32),
  merchantSigner: merchant.address,
  consumer: zeroAddress,
  mode: 0,
  originalValue: 200n * UNIT,
  discountBps: 9000n,
  debitAmount: 180n * UNIT,
  units: 0n,
  orderId: '0x' + '33'.repeat(32),
  nonce: 4n,
  issuedAt: 1000n,
  deadline: 1900n,
  serviceHash: serviceHash('服务说明'),
};
async function envelope() {
  return {
    schemaVersion: 1,
    chainId: 10143,
    verifyingContract: contract,
    bill,
    serviceText: '服务说明',
    merchantSignature: await merchant.signTypedData({
      domain: billDomain(10143, contract),
      types: BILL_TYPES,
      primaryType: 'Bill',
      message: bill,
    }),
  };
}
test('self-contained bills preserve uint256 integers and signature across devices', async () => {
  const original = await envelope();
  const restored = decodeEnvelope(encodeEnvelope(original), 10143, contract);
  assert.deepEqual(restored.bill, bill);
  assert.equal(restored.merchantSignature, original.merchantSignature);
  assert.equal(
    hashTypedData({
      domain: billDomain(10143, contract),
      types: BILL_TYPES,
      primaryType: 'Bill',
      message: restored.bill,
    }),
    hashTypedData({
      domain: billDomain(10143, contract),
      types: BILL_TYPES,
      primaryType: 'Bill',
      message: bill,
    }),
  );
});
test('bill decoder rejects wrong chain, wrong contract, descriptions, schema, and malformed payloads', async () => {
  const original = await envelope();
  assert.throws(() => decodeEnvelope(encodeEnvelope(original), 1, contract));
  assert.throws(() => decodeEnvelope(encodeEnvelope(original), 10143, zeroAddress));
  assert.throws(() =>
    decodeEnvelope(encodeEnvelope({ ...original, serviceText: 'tampered' }), 10143, contract),
  );
  assert.throws(() =>
    decodeEnvelope(encodeEnvelope({ ...original, schemaVersion: 2 }), 10143, contract),
  );
  assert.throws(() => decodeEnvelope('a'.repeat(5501), 10143, contract));
  for (const value of ['-1', '1e18', '1.5', (2n ** 256n).toString()])
    assert.throws(() =>
      decodeEnvelope(
        encodeEnvelope({ ...original, bill: { ...bill, nonce: value } }),
        10143,
        contract,
      ),
    );
});
test('scanned bills stay on the current site and reject unrelated links or altered envelopes', async () => {
  const encoded = encodeEnvelope(await envelope());
  const route = `#/pay?vault=${contract}&bill=${encoded}`;
  for (const prefix of ['', '/', 'http://127.0.0.1:5173/', 'https://merchant.example/']) {
    const decoded = decodeBillLink(prefix + route, 10143);
    assert.equal(decoded.route, `/pay?vault=${contract}&bill=${encoded}`);
    assert.deepEqual(decoded.envelope.bill, bill);
  }
  for (const value of [
    'https://example.com/',
    'javascript:alert(1)',
    '#/cards',
    `${route}&vault=${contract}`,
    `${route}&bill=${encoded}`,
    '#/pay?vault=bad&bill=a',
    'x'.repeat(8193),
  ])
    assert.throws(() => decodeBillLink(value, 10143));
  assert.throws(() => decodeBillLink(route, 1));
  const tampered = encodeEnvelope({ ...(await envelope()), serviceText: 'changed' });
  assert.throws(() => decodeBillLink(`#/pay?vault=${contract}&bill=${tampered}`, 10143));
});
