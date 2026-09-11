import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeploymentPlan } from '../scripts/deployment-plan.mjs';

test('ProofCast deployment plan links registry, executor, factory and adapter without enabling native execution', () => {
  const plan = buildDeploymentPlan({ catalog: '0x0000000000000000000000000000000000000001' });
  assert.deepEqual(plan.steps.map(({ name }) => name), ['ProofCastDreamDexAdapter', 'ProofCastRegistry', 'ProofCastExecutor', 'ProofCastFactory', 'link-factory']);
  assert.equal(plan.nativeExecutionEnabled, false);
});
