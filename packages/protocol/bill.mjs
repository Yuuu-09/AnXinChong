import { getAddress, isAddress, keccak256, stringToHex } from 'viem';

export const BILL_TYPES = {
  Bill: [
    { name: 'membershipId', type: 'uint256' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'merchantSigner', type: 'address' },
    { name: 'consumer', type: 'address' },
    { name: 'mode', type: 'uint8' },
    { name: 'originalValue', type: 'uint256' },
    { name: 'discountBps', type: 'uint256' },
    { name: 'debitAmount', type: 'uint256' },
    { name: 'units', type: 'uint256' },
    { name: 'orderId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'serviceHash', type: 'bytes32' },
  ],
};
export const billDomain = (chainId, verifyingContract) => ({
  name: 'AnXinChong',
  version: '1',
  chainId,
  verifyingContract,
});
export const serviceHash = (text) => keccak256(stringToHex(text));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const bigintFields = BILL_TYPES.Bill.filter((x) => x.type === 'uint256').map((x) => x.name);

export function encodeEnvelope(envelope) {
  const json = JSON.stringify(envelope, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  if (encoder.encode(json).length > 4096) throw new Error('账单超过 4 KiB');
  return btoa(String.fromCharCode(...encoder.encode(json)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function decodeEnvelope(encoded, expectedChainId, expectedContract) {
  if (typeof encoded !== 'string' || encoded.length > 5500 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new Error('账单编码无效');
  let envelope;
  try {
    const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0),
    );
    if (bytes.length > 4096) throw new Error();
    envelope = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error('无法解析账单');
  }
  if (
    !envelope ||
    envelope.schemaVersion !== 1 ||
    envelope.chainId !== expectedChainId ||
    !isAddress(envelope.verifyingContract ?? '') ||
    getAddress(envelope.verifyingContract) !== getAddress(expectedContract)
  )
    throw new Error('账单版本、网络或合约不匹配');
  if (typeof envelope.serviceText !== 'string' || encoder.encode(envelope.serviceText).length > 120)
    throw new Error('服务说明超出限制');
  if (!/^0x(?:[a-fA-F0-9]{2}){1,1024}$/.test(envelope.merchantSignature ?? ''))
    throw new Error('商家签名格式错误');
  const source = envelope.bill;
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new Error('账单字段错误');
  const bill = {};
  for (const field of BILL_TYPES.Bill) {
    const value = source[field.name];
    if (bigintFields.includes(field.name)) {
      if (
        typeof value !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(value) ||
        value.length > 78 ||
        BigInt(value) >= 2n ** 256n
      )
        throw new Error(`账单数字错误：${field.name}`);
      bill[field.name] = BigInt(value);
    } else if (field.type === 'address') {
      if (!isAddress(value ?? '')) throw new Error('账单地址错误');
      bill[field.name] = getAddress(value);
    } else if (field.type === 'bytes32') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? '')) throw new Error('账单摘要错误');
      bill[field.name] = value;
    } else {
      if (value !== 0 && value !== 1) throw new Error('消费模式错误');
      bill[field.name] = value;
    }
  }
  if (bill.serviceHash !== serviceHash(envelope.serviceText))
    throw new Error('服务说明与签名摘要不一致');
  return { ...envelope, bill };
}

// Extract only our confirmation route. A scanned origin is never opened.
export function decodeBillLink(value, expectedChainId) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('账单链接格式无效');
  let url;
  try {
    url = new URL(value.trim(), 'https://anxinchong.invalid/');
  } catch {
    throw new Error('账单链接格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hash.startsWith('#/pay?'))
    throw new Error('这不是安心充消费账单二维码');
  const params = new URLSearchParams(url.hash.slice('#/pay?'.length));
  const rawVault = params.get('vault');
  const encoded = params.get('bill');
  if (
    params.getAll('vault').length !== 1 ||
    params.getAll('bill').length !== 1 ||
    !isAddress(rawVault ?? '') ||
    !encoded
  )
    throw new Error('账单链接缺少有效的金库或账单');
  const vault = getAddress(rawVault);
  const envelope = decodeEnvelope(encoded, expectedChainId, vault);
  return { vault, encoded, envelope, route: `/pay?vault=${vault}&bill=${encoded}` };
}
