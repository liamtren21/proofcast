import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('ProofCast contract source exposes versioned cards and bounded intents', () => {
  const source = fs.readFileSync(new URL('../contracts/ProofCast.sol', import.meta.url), 'utf8');
  for (const marker of ['publishCard', 'authorizeIntent', 'revokeIntent', 'Receipt', 'marketGeneration', 'executeBinaryIoc', 'setPool', 'deposit', 'mintSet', 'finalizeMarket', 'redeem']) {
    assert.match(source, new RegExp(`\\b${marker}\\b`));
  }
  assert.match(source, /NoArbitraryCall/);
});
