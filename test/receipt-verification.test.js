import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyReceipt,verifyClosedPosition} from '../scripts/receipt-verification.mjs';
const hash='0x'+'aa'.repeat(32),blockHash='0x'+'bb'.repeat(32),owner='0x'+'11'.repeat(20);
const entry={hash,block:10,status:'MINED_SUCCESS'};
const receipt={hash,blockNumber:10,blockHash,status:1};
test('receipt requires successful canonical inclusion and the project sender',()=>{
  assert.doesNotThrow(()=>verifyReceipt(entry,receipt,{from:owner,chainId:50312n},{hash:blockHash},owner));
  for(const changed of [null,{...receipt,status:0},{...receipt,hash:'wrong'},{...receipt,blockNumber:11}]){
    assert.throws(()=>verifyReceipt(entry,changed,{from:owner,chainId:50312n},{hash:blockHash},owner));
  }
  assert.throws(()=>verifyReceipt(entry,receipt,{from:owner,chainId:1n},{hash:blockHash},owner));
  assert.throws(()=>verifyReceipt(entry,receipt,{from:owner,chainId:50312n},{hash:'reorg'},owner));
  assert.throws(()=>verifyReceipt(entry,receipt,{from:'other',chainId:50312n},{hash:blockHash},owner));
});
test('a resolved losing position needs no zero-value withdraw transaction',()=>{
  const closed={openRisk:0n,cash:0n,revoked:true,recovered:true,transactions:[{label:'recover'},{label:'withdraw-unused'}]};
  assert.doesNotThrow(()=>verifyClosedPosition(closed));
  for(const change of [{openRisk:1n},{cash:1n},{revoked:false},{recovered:false},{transactions:[{label:'withdraw'}]}]){
    assert.throws(()=>verifyClosedPosition({...closed,...change}));
  }
});
