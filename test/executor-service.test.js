import test from 'node:test';
import assert from 'node:assert/strict';
import {startExecutorService} from '../apps/worker/src/executor-main.js';
test('disabled executor process exposes disabled health without key or database',async()=>{
 const service=await startExecutorService({env:{},port:0});
 try{const r=await fetch(service.url);assert.equal(r.status,503);assert.deepEqual(await r.json(),{enabled:false});}finally{await service.close();}
});
test('executor service validates interval before starting',async()=>{
 await assert.rejects(()=>startExecutorService({env:{},interval:0}),/INVALID_EXECUTOR_SERVICE/);
});
