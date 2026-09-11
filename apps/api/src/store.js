import pg from 'pg';
const { Pool } = pg;

export class MemoryStore {
  #cursor = null;
  #challenges = new Map();
  #sessions = new Map();
  #sessionsData = [];
  #contents = new Map();
  async health() { return { db: true }; }
  async workerHealth() { return { worker: false }; }
  async saveChainEvent(event) { this.#contents.set(`event:${event.chainId}:${event.txHash}:${event.logIndex}`, event); return event; }
  async getCursor() { return this.#cursor ?? null; }
  async setCursor(cursor) { this.#cursor = cursor; }
  async indexerStatus() { return { cursor: this.#cursor ?? null, eventCount: [...this.#contents.keys()].filter((key) => key.startsWith('event:')).length, executionEnabled: false }; }
  async createChallenge(challenge) { this.#challenges.set(challenge.id, { ...challenge, consumed: false }); return challenge; }
  async consumeChallenge(id) {
    const challenge = this.#challenges.get(id);
    if (!challenge || challenge.consumed || challenge.expiresAt <= Date.now()) return null;
    challenge.consumed = true;
    return { ...challenge };
  }
  async getChallenge(id) { return this.#challenges.get(id) ?? null; }
  async createSession(session) { this.#sessions.set(session.token, { ...session }); return session; }
  async getSession(token) { const session = this.#sessions.get(token); return session && session.expiresAt > Date.now() ? { ...session } : null; }
  async deleteSession(token) { this.#sessions.delete(token); }
  async listSessions() { return this.#sessionsData.filter((entry) => !entry.withdrawn); }
  async listDrafts(creator) { return this.#sessionsData.filter(s => s.creator.toLowerCase() === creator.toLowerCase() && s.status === 'DRAFT'); }
  async listEnrollments(follower) { return this.#sessionsData.flatMap(s => (s.enrollments ?? []).filter(e => e.follower.toLowerCase() === follower.toLowerCase()).map(e => ({ ...e, sessionId: s.id }))); }
  async saveDraft(session) {
    const current = await this.getSessionData(session.id);
    if (current && (current.creator.toLowerCase() !== session.creator.toLowerCase() || current.status !== 'DRAFT')) return false;
    await this.saveSession(session); return true;
  }
  async getSessionData(id) { return this.#sessionsData.find((entry) => entry.id === id) ?? null; }
  async saveSession(session) { const index = this.#sessionsData.findIndex((entry) => entry.id === session.id); if (index >= 0) this.#sessionsData[index] = session; else this.#sessionsData.push(session); return session; }
  async saveContent(content) { this.#contents.set(content.hash, content); return content; }
  async getContent(hash) { return this.#contents.get(hash) ?? null; }
}

export function createPgStore(connectionString = process.env.DATABASE_URL, { pool: suppliedPool } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL_REQUIRED');
  const pool = suppliedPool ?? new Pool({ connectionString });
  return {
    async health() { await pool.query('SELECT 1'); return { db: true }; },
    async workerHealth() { const { rows } = await pool.query("SELECT indexer_ok AND observed_at > now() - interval '30 seconds' AS worker FROM proofcast_worker_state WHERE chain_id=50312 ORDER BY observed_at DESC LIMIT 1"); return { worker: rows[0]?.worker === true }; },
    async saveChainEvent(event) { await pool.query('INSERT INTO proofcast_chain_events(chain_id,tx_hash,log_index,block_number,block_hash,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING', [event.chainId,event.txHash,event.logIndex,event.blockNumber,event.blockHash,JSON.stringify(event.payload)]); },
    async getCursor() { const { rows } = await pool.query('SELECT last_block AS block,last_block_hash AS hash FROM proofcast_indexer_cursors WHERE chain_id=$1', [50312]); return rows[0] ?? null; },
    async setCursor(cursor) { await pool.query('INSERT INTO proofcast_indexer_cursors(chain_id,last_block,last_block_hash) VALUES($1,$2,$3) ON CONFLICT(chain_id) DO UPDATE SET last_block=EXCLUDED.last_block,last_block_hash=EXCLUDED.last_block_hash', [50312,cursor.block,cursor.hash]); },
    async indexerStatus() { const { rows } = await pool.query('SELECT (SELECT count(*)::int FROM proofcast_chain_events WHERE chain_id=$1) AS "eventCount", (SELECT json_build_object(\'block\',last_block,\'hash\',last_block_hash) FROM proofcast_indexer_cursors WHERE chain_id=$1) AS cursor', [50312]); const value = rows[0] ?? {}; return { cursor: value.cursor ?? null, eventCount: value.eventCount ?? 0, executionEnabled: false }; },
    async createChallenge(c) { await pool.query('INSERT INTO proofcast_auth_challenges (id,address,chain_id,nonce,expires_at) VALUES ($1,$2,$3,$4,to_timestamp($5 / 1000.0))', [c.id,c.address,c.chainId,c.nonce,c.expiresAt]); return c; },
    async consumeChallenge(id) { const { rows } = await pool.query('UPDATE proofcast_auth_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING id,address,chain_id,nonce,EXTRACT(EPOCH FROM expires_at)*1000 AS "expiresAt"', [id]); return rows[0] ?? null; },
    async getChallenge(id) { const { rows } = await pool.query('SELECT id,address,chain_id::int AS "chainId",nonce,EXTRACT(EPOCH FROM expires_at)*1000 AS "expiresAt",consumed_at IS NOT NULL AS consumed FROM proofcast_auth_challenges WHERE id=$1', [id]); return rows[0] ?? null; },
    async createSession(session) { await pool.query('INSERT INTO proofcast_auth_sessions (token,address,expires_at) VALUES ($1,$2,to_timestamp($3 / 1000.0))', [session.token,session.address,session.expiresAt]); return session; },
    async getSession(token) { const { rows } = await pool.query('SELECT token,address,EXTRACT(EPOCH FROM expires_at)*1000 AS "expiresAt" FROM proofcast_auth_sessions WHERE token=$1 AND expires_at>now()', [token]); return rows[0] ?? null; },
    async deleteSession(token) { await pool.query('DELETE FROM proofcast_auth_sessions WHERE token=$1', [token]); },
    async listSessions() { const { rows } = await pool.query('SELECT payload FROM proofcast_sessions WHERE withdrawn = false ORDER BY created_at DESC'); return rows.map(({ payload }) => payload); },
    async listDrafts(creator) { const { rows } = await pool.query("SELECT payload FROM proofcast_sessions WHERE lower(creator)=$1 AND payload->>'status'='DRAFT' ORDER BY created_at DESC", [creator.toLowerCase()]); return rows.map(r => r.payload); },
    async listEnrollments(follower) { const { rows } = await pool.query("SELECT payload->>'id' AS session_id, e FROM proofcast_sessions CROSS JOIN LATERAL jsonb_array_elements(COALESCE(payload->'enrollments','[]'::jsonb)) e WHERE lower(e->>'follower')=$1", [follower.toLowerCase()]); return rows.map(r => ({ ...r.e, sessionId: r.session_id })); },
    async saveDraft(session) {
      const result = await pool.query("INSERT INTO proofcast_sessions (id,creator,withdrawn,payload) VALUES($1,$2,false,$3::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload WHERE lower(proofcast_sessions.creator)=lower(EXCLUDED.creator) AND proofcast_sessions.payload->>'status'='DRAFT' RETURNING id", [session.id,session.creator,JSON.stringify(session)]);
      return result.rowCount === 1;
    },
    async getSessionData(id) { const { rows } = await pool.query('SELECT payload FROM proofcast_sessions WHERE id = $1', [id]); return rows[0]?.payload ?? null; },
    async saveSession(session) { await pool.query('INSERT INTO proofcast_sessions (id, creator, withdrawn, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, withdrawn = EXCLUDED.withdrawn', [session.id, session.creator, session.withdrawn, JSON.stringify(session)]); return session; },
    async saveContent(content) { await pool.query('INSERT INTO proofcast_content (hash, canonical, confirmed) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING', [content.hash, content.canonical, content.confirmed]); return content; },
    async getContent(hash) { const { rows } = await pool.query('SELECT hash, canonical, confirmed, created_at AS "createdAt" FROM proofcast_content WHERE hash = $1', [hash]); return rows[0] ?? null; },
  };
}
