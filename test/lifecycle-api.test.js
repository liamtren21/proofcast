import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/api/src/app.js';
test('public lifecycle proof is read-only and independent of client claims',async()=>{
  const store={health:async()=>({db:true})};
  let unavailable=false;
  const app=await buildApp({store,lifecycleReader:async()=>{if(unavailable)throw Error('rpc secret');return {network:'PUBLIC_SHANNON',phase:'AWAITING_SETTLEMENT',complete:false};}});
  try{
    const read=await app.inject('/api/v1/evidence/lifecycle');assert.equal(read.statusCode,200);assert.equal(read.json().complete,false);
    assert.match(read.headers['cache-control'],/no-store/);
    const post=await app.inject({method:'POST',url:'/api/v1/evidence/lifecycle',payload:{complete:true}});assert.notEqual(post.statusCode,200);
    unavailable=true;const failed=await app.inject('/api/v1/evidence/lifecycle');assert.equal(failed.statusCode,503);assert.ok(!failed.body.includes('secret'));
  }finally{await app.close();}
});
test('missing verifier never advertises verified proof',async()=>{
  const app=await buildApp({store:{health:async()=>({db:true})}});
  try{assert.equal((await app.inject('/api/v1/evidence/lifecycle')).statusCode,503);}finally{await app.close();}
});
