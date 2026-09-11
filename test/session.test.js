import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWindow,
  createSession,
  enrollFollower,
  publishSignal,
  revokeEnrollment,
  withdrawSession,
} from '../src/session.js';

test('a registered market remains visible when creator gives no signal', () => {
  const session = createSession({ enrollUntil: 10n, cutoff: 20n, now: 0n, marketIds: ['m1'] });
  assert.equal(classifyWindow({ now: 21n, observedThrough: 21n, cutoff: 20n }), 'NO_SIGNAL');
  assert.deepEqual(session.marketIds, ['m1']);
});

test('missing chain observation is not silently classified as no signal', () => {
  assert.equal(classifyWindow({ now: 21n, observedThrough: 19n, cutoff: 20n }), 'DATA_UNAVAILABLE');
});

test('abstain is distinct from silence', () => {
  assert.equal(classifyWindow({ now: 21n, observedThrough: 21n, cutoff: 20n, signal: 'ABSTAIN' }), 'ABSTAIN');
});

test('session rejects future aliases and reversed enrollment window', () => {
  assert.throws(() => createSession({ enrollUntil: 20n, cutoff: 10n, now: 0n, marketIds: ['BTC-next'] }), /INVALID_SESSION/);
});

test('follower can opt in before the session starts publishing', () => {
  const session = createSession({
    sessionId: 's1',
    creator: 'creator-1',
    enrollUntil: 10n,
    sessionUntil: 30n,
    cutoff: 20n,
    now: 0n,
    marketIds: ['m1'],
  });

  const enrolled = enrollFollower(session, {
    enrollmentId: 'e1',
    follower: 'follower-1',
    vault: 'vault-1',
    allowedSideMask: ['YES'],
    maxYesPrice: 70n,
    maxNoPrice: 0n,
    maxCostPerOrder: 100n,
    totalRiskBudget: 100n,
    validUntil: 25n,
    nonce: 1n,
    termsHash: 'terms-1',
    now: 9n,
  });

  assert.equal(enrolled.enrollments.length, 1);
  assert.equal(enrolled.enrollments[0].follower, 'follower-1');
  assert.equal(enrolled.signals.length, 0);
});

test('enrollment closes once signal publishing begins and creator cannot enroll a follower', () => {
  const session = createSession({
    sessionId: 's1', creator: 'creator-1', enrollUntil: 10n, sessionUntil: 30n,
    cutoff: 20n, now: 0n, marketIds: ['m1'],
  });
  const published = publishSignal(session, {
    marketId: 'm1', creator: 'creator-1', sideOrAbstain: 'YES',
    validUntil: 20n, evidenceHash: 'evidence-1', now: 10n,
  });

  assert.throws(() => enrollFollower(published, {
    enrollmentId: 'e1', follower: 'follower-1', vault: 'vault-1',
    allowedSideMask: ['YES'], maxYesPrice: 70n, maxNoPrice: 0n,
    maxCostPerOrder: 100n, totalRiskBudget: 100n, validUntil: 25n,
    nonce: 1n, termsHash: 'terms-1', now: 9n,
  }), /ENROLLMENT_CLOSED/);
  assert.throws(() => publishSignal(session, {
    marketId: 'm1', creator: 'someone-else', sideOrAbstain: 'YES',
    validUntil: 20n, evidenceHash: 'evidence-1', now: 10n,
  }), /UNAUTHORIZED_CREATOR/);
});

test('only one executable signal is accepted for a market and abstain is anchored', () => {
  const session = createSession({
    sessionId: 's1', creator: 'creator-1', enrollUntil: 10n, sessionUntil: 30n,
    cutoff: 20n, now: 0n, marketIds: ['m1'],
  });
  const abstained = publishSignal(session, {
    marketId: 'm1', creator: 'creator-1', sideOrAbstain: 'ABSTAIN',
    validUntil: 20n, evidenceHash: 'evidence-1', now: 11n,
  });

  assert.equal(abstained.signals[0].sideOrAbstain, 'ABSTAIN');
  assert.throws(() => publishSignal(abstained, {
    marketId: 'm1', creator: 'creator-1', sideOrAbstain: 'NO',
    validUntil: 20n, evidenceHash: 'evidence-2', now: 12n,
  }), /SIGNAL_ALREADY_PUBLISHED/);
});

test('withdraw and revoke preserve lifecycle history while blocking new execution state', () => {
  const session = createSession({
    sessionId: 's1', creator: 'creator-1', enrollUntil: 10n, sessionUntil: 30n,
    cutoff: 20n, now: 0n, marketIds: ['m1'],
  });
  const enrolled = enrollFollower(session, {
    enrollmentId: 'e1', follower: 'follower-1', vault: 'vault-1',
    allowedSideMask: ['YES'], maxYesPrice: 70n, maxNoPrice: 0n,
    maxCostPerOrder: 100n, totalRiskBudget: 100n, validUntil: 25n,
    nonce: 1n, termsHash: 'terms-1', now: 9n,
  });
  const revoked = revokeEnrollment(enrolled, { enrollmentId: 'e1', follower: 'follower-1', now: 9n });
  const withdrawn = withdrawSession(revoked, { creator: 'creator-1', now: 10n });

  assert.equal(withdrawn.enrollments.length, 1);
  assert.equal(withdrawn.enrollments[0].revoked, true);
  assert.equal(withdrawn.withdrawn, true);
  assert.equal(withdrawn.events.map((event) => event.type).join(','), 'ENROLLED,ENROLLMENT_REVOKED,SESSION_WITHDRAWN');
  assert.throws(() => publishSignal(withdrawn, {
    marketId: 'm1', creator: 'creator-1', sideOrAbstain: 'ABSTAIN',
    validUntil: 20n, evidenceHash: 'evidence-1', now: 11n,
  }), /SESSION_WITHDRAWN/);
});
