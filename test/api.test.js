import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app.js';
import { MemoryStore } from '../apps/api/src/store.js';

function store() {
  const backing = new MemoryStore();
  const sessions = [];
  const contents = new Map();
  let cursor = null;
  const events = [];
  return {
    sessions, contents, events,
    async health() { return { db: true }; },
    async workerHealth() { return { worker: true }; },
    async listSessions() { return sessions.filter((entry) => !entry.withdrawn); },
    async getSessionData(id) { return sessions.find((entry) => entry.id === id) ?? null; },
    async getSession(token) { return backing.getSession(token); },
    async createSession(session) { return backing.createSession(session); },
    async saveSession(session) { const index = sessions.findIndex((entry) => entry.id === session.id); if (index >= 0) sessions[index] = session; else sessions.push(session); return session; },
    async saveContent(content) { contents.set(content.hash, content); return content; },
    async getContent(hash) { return contents.get(hash) ?? null; },
    async setCursor(value) { cursor = value; },
    async saveChainEvent(event) { events.push(event); },
    async indexerStatus() { return { cursor, eventCount: events.length, executionEnabled: false }; },
  };
}

test('API exposes explicit readiness and persists public session/content through the store', async (t) => {
  const backing = store();
  const app = await buildApp({ store: backing, now: () => 1_700_000_000 });
  t.after(() => app.close());
  const ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
  assert.equal(ready.statusCode, 200);
  assert.equal(JSON.parse(ready.payload).ready, true);

  // Public records must come from the observer, never from an unconfirmed creator draft.
  await backing.saveSession({ id: 'session-1', creator: '0xcreator', title: 'A thesis', status: 'CONFIRMED', markets: [] });
  const list = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
  assert.deepEqual(JSON.parse(list.payload).sessions.map(({ id }) => id), ['session-1']);

  const content = await app.inject({ method: 'POST', url: '/api/v1/content', payload: { version: 1, title: 'A thesis', terms: { side: 'YES', maxCost: '1' } } });
  assert.equal(content.statusCode, 201);
  const hash = JSON.parse(content.payload).hash;
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/content/${hash}` });
  assert.equal(JSON.parse(fetched.payload).hash, hash);
});

test('indexer status exposes cursor, event count, and execution gate', async (t) => {
  const backing = store();
  await backing.setCursor({ block: 321, hash: '0xdef' });
  await backing.saveChainEvent({ chainId: 50312, txHash: '0xtx', logIndex: 0, blockNumber: 321, blockHash: '0xdef', payload: { kind: 'Test' } });
  const app = await buildApp({ store: backing });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/indexer/status' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.payload), { cursor: { block: 321, hash: '0xdef' }, eventCount: 1, executionEnabled: false, healthy: true });
});

test('API rejects client claims of confirmed execution', async (t) => {
  const app = await buildApp({ store: store() });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/v1/transactions', payload: { txHash: '0x1', executed: true } });
  assert.equal(response.statusCode, 400);
});

test('wallet auth session is persisted by the store and can be revoked', async (t) => {
  const backing = new MemoryStore();
  const app = await buildApp({ store: backing });
  t.after(() => app.close());
  await backing.createSession({ token: 'proof-token', address: '0xabc', expiresAt: Date.now() + 60_000 });
  const found = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: 'proofcast_session=proof-token' } });
  assert.equal(found.statusCode, 200);
  assert.equal(JSON.parse(found.payload).address, '0xabc');
  const logout = await app.inject({ method: 'DELETE', url: '/api/v1/auth/session', headers: { cookie: 'proofcast_session=proof-token' } });
  assert.equal(logout.statusCode, 204);
  const revoked = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: 'proofcast_session=proof-token' } });
  assert.equal(revoked.statusCode, 401);
});

test('creator draft compares authenticated wallet addresses case-insensitively', async (t) => {
  const backing = new MemoryStore();
  const app = await buildApp({ store: backing, now: () => 1_700_000_000 });
  t.after(() => app.close());
  await backing.createSession({ token: 'creator-token', address: '0xabc', expiresAt: Date.now() + 60_000 });
  const response = await app.inject({ method: 'POST', url: '/api/v1/session-drafts', headers: { cookie: 'proofcast_session=creator-token' }, payload: { id: 'case-session', creator: '0xABC', title: 'Case safe', markets: [] } });
  assert.equal(response.statusCode, 201);
});

test('follower can enroll in an open session before a signal is anchored', async (t) => {
  const backing = store();
  const app = await buildApp({ store: backing, now: () => 100 });
  t.after(() => app.close());
  await backing.saveSession({ id: 'open-1', creator: '0xcreator', title: 'Open', markets: [{ marketId: 'm1' }], enrollUntilSec: 200, sessionUntilSec: 400, withdrawn: false, status: 'CONFIRMED' });
  await backing.createSession({ token: 'follower-token', address: '0xfollower', expiresAt: Date.now() + 60000 });
  const response = await app.inject({ method: 'POST', url: '/api/v1/sessions/open-1/enrollments', headers: { cookie: 'proofcast_session=follower-token' }, payload: { enrollmentId: 'e-1', vault: '0xvault', allowedSideMask: ['YES'], maxYesPrice: '500000', maxNoPrice: '0', maxCostPerOrder: '1000000', totalRiskBudget: '2000000', validUntil: 300 } });
  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.payload).enrollment.follower, '0xfollower');
  assert.equal((await backing.getSessionData('open-1')).enrollments.length, 1);
});

test('session detail returns public timeline and enrollments', async (t) => {
  const backing = store();
  const app = await buildApp({ store: backing });
  t.after(() => app.close());
  await backing.saveSession({ id: 'detail-1', creator: '0xcreator', title: 'Detail', markets: [{ marketId: 'm1' }], enrollUntilSec: 200, sessionUntilSec: 400, withdrawn: false, status: 'CONFIRMED', signals: [], enrollments: [{ enrollmentId: 'e1', follower: '0xfollower', revoked: false }] });
  const response = await app.inject({ method: 'GET', url: '/api/v1/sessions/detail-1' });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.payload);
  assert.equal(body.session.id, 'detail-1');
  assert.equal(body.session.enrollments.length, 1);
  assert.deepEqual(body.timeline.map((entry) => entry.kind), ['SESSION_CREATED', 'ENROLLMENT']);
});
