CREATE TABLE IF NOT EXISTS proofcast_sessions (
  id TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  withdrawn BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS proofcast_content (
  hash TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS proofcast_auth_challenges (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS proofcast_auth_sessions (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS proofcast_worker_heartbeats (worker_id TEXT PRIMARY KEY, observed_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS proofcast_worker_state (worker_id TEXT PRIMARY KEY, chain_id BIGINT NOT NULL, block_number BIGINT NOT NULL, block_hash TEXT NOT NULL, indexer_ok BOOLEAN NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS proofcast_chain_events (chain_id BIGINT NOT NULL, tx_hash TEXT NOT NULL, log_index BIGINT NOT NULL, block_number BIGINT NOT NULL, block_hash TEXT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY (chain_id, tx_hash, log_index));
CREATE TABLE IF NOT EXISTS proofcast_indexer_cursors (chain_id BIGINT PRIMARY KEY, last_block BIGINT NOT NULL, last_block_hash TEXT NOT NULL);
