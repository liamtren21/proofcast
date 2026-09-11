const ALLOWED_SIGNALS = new Set(['YES', 'NO', 'ABSTAIN']);
const ALLOWED_SIDES = new Set(['YES', 'NO']);

function invalid(message) {
  throw new Error(message);
}

function requireBigInt(value, name) {
  if (typeof value !== 'bigint' || value < 0n) invalid(`INVALID_${name.toUpperCase()}`);
}

function copyState(state, changes = {}) {
  return Object.freeze({
    ...state,
    ...changes,
    marketIds: [...(changes.marketIds ?? state.marketIds)],
    enrollments: [...(changes.enrollments ?? state.enrollments)],
    signals: [...(changes.signals ?? state.signals)],
    events: [...(changes.events ?? state.events)],
  });
}

export function classifyWindow({ now, observedThrough, cutoff, signal }) {
  if (observedThrough < cutoff && now > cutoff) return 'DATA_UNAVAILABLE';
  if (signal === 'ABSTAIN') return 'ABSTAIN';
  if (ALLOWED_SIGNALS.has(signal)) return 'SIGNAL_PUBLISHED';
  return now > cutoff ? 'NO_SIGNAL' : 'AWAITING_SIGNAL';
}

export function createSession({
  sessionId = 'local-session',
  creator = 'local-creator',
  enrollUntil,
  sessionUntil,
  cutoff,
  now,
  marketIds,
}) {
  sessionUntil ??= typeof cutoff === 'bigint' ? cutoff + 1n : cutoff + 1;
  if (!Array.isArray(marketIds) || marketIds.length === 0 || marketIds.length > 3 || new Set(marketIds).size !== marketIds.length) {
    throw new Error('INVALID_SESSION');
  }
  if (enrollUntil <= now || enrollUntil > cutoff || cutoff >= sessionUntil || marketIds.some((id) => id.includes('next'))) {
    throw new Error('INVALID_SESSION');
  }
  return Object.freeze({
    sessionId,
    creator,
    enrollUntil,
    sessionUntil,
    cutoff,
    marketIds: [...marketIds],
    withdrawn: false,
    enrollments: [],
    signals: [],
    events: [],
  });
}

export function enrollFollower(state, enrollment) {
  if (state.withdrawn) invalid('SESSION_WITHDRAWN');
  if (state.signals.length > 0 || enrollment.now >= state.enrollUntil) invalid('ENROLLMENT_CLOSED');
  if (state.enrollments.some(({ enrollmentId }) => enrollmentId === enrollment.enrollmentId)) {
    invalid('ENROLLMENT_ALREADY_EXISTS');
  }
  if (!enrollment.follower || !enrollment.vault || !enrollment.enrollmentId) invalid('INVALID_ENROLLMENT');
  if (!Array.isArray(enrollment.allowedSideMask) || enrollment.allowedSideMask.length === 0
      || enrollment.allowedSideMask.some((side) => !ALLOWED_SIDES.has(side))) invalid('INVALID_SIDE_MASK');
  for (const field of ['maxYesPrice', 'maxNoPrice', 'maxCostPerOrder', 'totalRiskBudget', 'validUntil', 'nonce']) {
    requireBigInt(enrollment[field], field);
  }
  if (enrollment.validUntil > state.sessionUntil || enrollment.validUntil <= enrollment.now) invalid('INVALID_ENROLLMENT');
  const record = Object.freeze({
    ...enrollment,
    allowedSideMask: [...enrollment.allowedSideMask],
    revoked: false,
  });
  return copyState(state, {
    enrollments: [...state.enrollments, record],
    events: [...state.events, Object.freeze({ type: 'ENROLLED', enrollmentId: enrollment.enrollmentId, now: enrollment.now })],
  });
}

export function publishSignal(state, signal) {
  if (state.withdrawn) invalid('SESSION_WITHDRAWN');
  if (signal.creator !== state.creator) invalid('UNAUTHORIZED_CREATOR');
  if (!state.marketIds.includes(signal.marketId)) invalid('UNKNOWN_MARKET');
  if (signal.now < state.enrollUntil || signal.now > state.cutoff) invalid('PUBLISH_WINDOW_CLOSED');
  if (!ALLOWED_SIGNALS.has(signal.sideOrAbstain)) invalid('INVALID_SIGNAL');
  if (state.signals.some(({ marketId }) => marketId === signal.marketId)) invalid('SIGNAL_ALREADY_PUBLISHED');
  requireBigInt(signal.validUntil, 'valid_until');
  if (signal.validUntil > state.sessionUntil || signal.validUntil < signal.now) invalid('INVALID_SIGNAL_EXPIRY');
  if (!signal.evidenceHash) invalid('INVALID_SIGNAL');
  const record = Object.freeze({ ...signal });
  return copyState(state, {
    signals: [...state.signals, record],
    events: [...state.events, Object.freeze({ type: 'SIGNAL_ANCHORED', marketId: signal.marketId, now: signal.now })],
  });
}

export function revokeEnrollment(state, { enrollmentId, follower, now }) {
  const index = state.enrollments.findIndex((entry) => entry.enrollmentId === enrollmentId);
  if (index === -1) invalid('UNKNOWN_ENROLLMENT');
  const current = state.enrollments[index];
  if (current.follower !== follower) invalid('UNAUTHORIZED_FOLLOWER');
  if (current.revoked) invalid('ENROLLMENT_ALREADY_REVOKED');
  const enrollments = [...state.enrollments];
  enrollments[index] = Object.freeze({ ...current, revoked: true, revokedAt: now });
  return copyState(state, {
    enrollments,
    events: [...state.events, Object.freeze({ type: 'ENROLLMENT_REVOKED', enrollmentId, now })],
  });
}

export function withdrawSession(state, { creator, now }) {
  if (creator !== state.creator) invalid('UNAUTHORIZED_CREATOR');
  if (state.withdrawn) invalid('SESSION_ALREADY_WITHDRAWN');
  return copyState(state, {
    withdrawn: true,
    events: [...state.events, Object.freeze({ type: 'SESSION_WITHDRAWN', now })],
  });
}
