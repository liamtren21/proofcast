import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeContent, hashContent } from '../packages/protocol/src/content.js';
import { parseRawAmount, formatRawAmount, assertExpiryNs } from '../packages/protocol/src/units.js';
import { normalizeMarketRef, validateSessionManifest } from '../packages/protocol/src/manifest.js';

const market = {
  chainId: 50312,
  module: '0x0000000000000000000000000000000000000001',
  operatorId: 7,
  venueId: '0x' + '11'.repeat(32),
  marketId: '0x' + '22'.repeat(32),
  marketAddress: '0x0000000000000000000000000000000000000002',
  pool: '0x0000000000000000000000000000000000000003',
  generation: '1',
  collateral: '0x0000000000000000000000000000000000000004',
  outcomeToken: '0x0000000000000000000000000000000000000005',
  yesId: '1',
  noId: '2',
  tradingStartSec: 100,
  expirySec: 200,
  decisionCutoffSec: 150,
};

test('canonical content is stable across object insertion order and rejects unknown fields', async () => {
  const a = { version: 1, title: 'Thesis', terms: { maxCost: '1000', side: 'YES' } };
  const b = { terms: { side: 'YES', maxCost: '1000' }, title: 'Thesis', version: 1 };
  assert.equal(canonicalizeContent(a), canonicalizeContent(b));
  assert.equal(await hashContent(a), await hashContent(b));
  assert.throws(() => canonicalizeContent({ ...a, extra: true }), /UNKNOWN_FIELD/);
});

test('raw units preserve precision and expiry is nanoseconds', () => {
  assert.equal(parseRawAmount('1000001', 'amount'), 1000001n);
  assert.equal(formatRawAmount(1000001n), '1000001');
  assert.throws(() => parseRawAmount(1.2, 'amount'), /INVALID_AMOUNT/);
  assert.throws(() => assertExpiryNs(86_400_000_002_003n, 2_000n), /EXPIRY_TOO_FAR/);
  assert.doesNotThrow(() => assertExpiryNs(2_000_000_001n, 2_000_000_000n));
});

test('manifest normalizes addresses and enforces real ordered markets', () => {
  const normalized = normalizeMarketRef({ ...market, module: market.module.toUpperCase() });
  assert.equal(normalized.module, market.module);
  assert.deepEqual(validateSessionManifest({
    chainId: 50312,
    markets: [normalized],
    enrollUntilSec: 120,
    sessionUntilSec: 190,
  }), { ok: true });
  assert.equal(validateSessionManifest({
    chainId: 50312,
    markets: [{ ...normalized, decisionCutoffSec: 200 }],
    enrollUntilSec: 120,
    sessionUntilSec: 190,
  }).ok, false);
});
