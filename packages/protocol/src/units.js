export function parseRawAmount(value, name = 'amount') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`INVALID_${name.toUpperCase()}`);
    return value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`INVALID_${name.toUpperCase()}`);
  return BigInt(value);
}

export function formatRawAmount(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('INVALID_AMOUNT');
  return value.toString(10);
}

export function assertExpiryNs(expiryNs, nowNs) {
  if (typeof expiryNs !== 'bigint' || typeof nowNs !== 'bigint' || expiryNs <= nowNs) throw new Error('INVALID_EXPIRY_NS');
  if (expiryNs - nowNs > 86_400_000_000_000n) throw new Error('EXPIRY_TOO_FAR');
}
