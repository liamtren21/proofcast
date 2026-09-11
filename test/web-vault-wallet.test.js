import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWallet, ownerAction, receiptState } from '../apps/web/src/vault-wallet.js';
const owner='0x1111111111111111111111111111111111111111';
test('receipt reconciliation stays pending until canonical confirmations and rejects another sender',async()=>{
 const hash='0x'+'ab'.repeat(32),blockHash='0x'+'cd'.repeat(32);
 let receipt=null,head=10;
 const provider={getTransactionReceipt:async()=>receipt,getBlock:async()=>({hash:blockHash}),getBlockNumber:async()=>head};
 assert.equal(await receiptState(provider,hash,owner,owner),null);
 receipt={hash,from:owner,to:owner,status:1,blockNumber:10,blockHash};
 assert.equal(await receiptState(provider,hash,owner,owner),null);
 head=12;assert.equal((await receiptState(provider,hash,owner,owner)).status,1);
 receipt.from='0x'+'22'.repeat(20);await assert.rejects(()=>receiptState(provider,hash,owner,owner),/RECEIPT_MISMATCH/);
});
test('wrong chain and changed account cannot sign',async()=>{
 await assert.rejects(()=>assertWallet({request:async()=> '0x1'},owner),/WRONG_CHAIN/);
 await assert.rejects(()=>assertWallet({request:async({method})=>method==='eth_chainId'?'0xc488':[]},owner),/ACCOUNT_CHANGED/);
});
test('withdraw accepts positive six-decimal amount; rejects arbitrary and zero calls',()=>{
 assert.equal(ownerAction('withdraw','0.1').name,'withdraw');
 assert.equal(ownerAction('withdraw','0.1').args[0],100000n);
 assert.throws(()=>ownerAction('transfer','1'),/UNSUPPORTED_ACTION/);
 assert.throws(()=>ownerAction('withdraw','0'),/INVALID_AMOUNT/);
 assert.throws(()=>ownerAction('withdraw','0.0000001'));
});
