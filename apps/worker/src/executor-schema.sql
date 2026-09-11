CREATE TABLE IF NOT EXISTS proofcast_executor_runs (
  chain_id BIGINT NOT NULL CHECK(chain_id=50312),
  signer TEXT NOT NULL,
  run_id TEXT NOT NULL,
  budget NUMERIC(78,0) NOT NULL CHECK(budget>0),
  reserved NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=budget),
  PRIMARY KEY(chain_id,signer,run_id)
);
CREATE TABLE IF NOT EXISTS proofcast_executor_jobs (
  job_key TEXT PRIMARY KEY,
  deployment TEXT NOT NULL,
  chain_id BIGINT NOT NULL CHECK(chain_id=50312),
  executor TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('execute','recover')),
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','SIGNED','BROADCAST','UNKNOWN','CONFIRMED','REVERTED')),
  signer TEXT,
  run_id TEXT,
  nonce BIGINT CHECK(nonce>=0),
  raw_tx TEXT,
  tx_hash TEXT UNIQUE,
  reserved NUMERIC(78,0),
  receipt JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state='QUEUED' AND raw_tx IS NULL AND tx_hash IS NULL AND nonce IS NULL)
    OR (state<>'QUEUED' AND raw_tx IS NOT NULL AND tx_hash IS NOT NULL AND nonce IS NOT NULL AND signer IS NOT NULL AND run_id IS NOT NULL)),
  UNIQUE(deployment,enrollment_id,market_id,action),
  UNIQUE(chain_id,signer,nonce)
);
