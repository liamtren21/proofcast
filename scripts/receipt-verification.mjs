import assert from 'node:assert/strict';
export function verifyClosedPosition({openRisk,cash,revoked,recovered,transactions}){
  assert.equal(openRisk,0n,'OPEN_RISK_REMAINS');assert.equal(cash,0n,'CASH_REMAINS');
  assert.equal(revoked,true,'NOT_REVOKED');assert.equal(recovered,true,'POSITION_NOT_RECOVERED');
  assert.ok(transactions.some(t=>t.label==='recover'),'RECOVERY_RECEIPT_MISSING');
  assert.ok(transactions.some(t=>t.label==='withdraw'||t.label==='withdraw-unused'),'WITHDRAWAL_RECEIPT_MISSING');
}
export function verifyReceipt(entry,receipt,transaction,block,owner){
  assert.ok(receipt&&transaction&&block,'CHAIN_EVIDENCE_MISSING');
  assert.equal(receipt.status,1,'TRANSACTION_REVERTED');
  assert.equal(receipt.hash.toLowerCase(),entry.hash.toLowerCase(),'WRONG_HASH');
  assert.equal(receipt.blockNumber,entry.block,'WRONG_BLOCK');
  assert.equal(receipt.blockHash,block.hash,'NON_CANONICAL_RECEIPT');
  assert.equal(transaction.chainId,50312n,'WRONG_CHAIN');
  assert.equal(transaction.from.toLowerCase(),owner.toLowerCase(),'WRONG_PROJECT_SENDER');
}
