import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHouseSkip } from '../src/skip-current.js';

test('House skip checks expected track, preparation, duplicate lock and no retry', async () => {
 let current='song',writes=0,commits=0,fail=false;
 let wait: Promise<void> | null = null;
 const skip=createHouseSkip({getNowPlaying:async()=>({subsonic_id:current}),commitBeforeSkip:async()=>{commits++;if(wait)await wait;return {pending:true,committed:true};},skipTrack:async()=>{writes++;if(fail)throw Error('uncertain');}});
 assert.equal((await skip.status('../bad')).status,400);
 assert.equal((await skip.skip('old')).status,409);assert.equal(commits,0);assert.equal(writes,0);
 assert.equal((await skip.status('song')).status,200);assert.equal(writes,0);
 assert.equal((await skip.skip('song')).body.ok,true);assert.equal(writes,1);
 let release: () => void = () => {};
 wait=new Promise<void>(r=>{release=r;});const pending=skip.skip('song');await new Promise(r=>setImmediate(r));
 assert.equal((await skip.skip('song')).status,409);current='new';release();assert.equal((await pending).status,409);assert.equal(writes,1);
 wait=null;fail=true;await assert.rejects(skip.skip('new'));assert.equal(writes,2);
 fail=false;assert.equal((await skip.skip('new')).status,200);
});
