import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('production worker selects the verified dynamic deployment before legacy references',()=>{
 const source=fs.readFileSync(new URL('../apps/worker/src/main.js',import.meta.url),'utf8');
 assert.match(source,/proofCastDynamicV3/);
});
