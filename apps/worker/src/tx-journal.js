export class JobJournal {
  #jobs = new Map();
  #now;
  constructor({ now = () => Math.floor(Date.now() / 1000) } = {}) { this.#now = now; }
  enqueue(job) {
    if (!job?.intentId || this.#jobs.has(job.intentId)) return false;
    this.#jobs.set(job.intentId, { ...job, state: 'QUEUED', leaseUntil: 0, workerId: null, txHash: null, nonce: null });
    return true;
  }
  claim(workerId, leaseSeconds) {
    const now = this.#now();
    for (const job of this.#jobs.values()) {
      if (job.state !== 'QUEUED' && !(job.state === 'LEASED' && job.leaseUntil <= now)) continue;
      if (job.txHash) continue;
      job.state = 'LEASED'; job.workerId = workerId; job.leaseUntil = now + leaseSeconds;
      return { ...job };
    }
    return null;
  }
  markBroadcast(intentId, { txHash, nonce }) {
    const job = this.#jobs.get(intentId);
    if (!job || job.state !== 'LEASED' || !txHash || nonce === undefined) throw new Error('INVALID_BROADCAST');
    job.state = 'BROADCAST'; job.txHash = txHash; job.nonce = String(nonce); return { ...job };
  }
  get(intentId) { const job = this.#jobs.get(intentId); return job ? { ...job } : null; }
}

export function classifyBroadcastRecovery(job) {
  if (!job) return 'UNKNOWN_INTENT';
  if (job.txHash) return 'RECONCILE_EXISTING_TX';
  if (job.state === 'QUEUED' || job.state === 'LEASED') return 'SAFE_TO_ATTEMPT';
  return 'STOP';
}
