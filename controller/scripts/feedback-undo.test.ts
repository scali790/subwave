import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { issueUndo, readUndo } from '../src/feedback-undo.js';

test('sealed undo is action-bound, opaque, expiring and tamper resistant',()=>{
  const target={kind:'block' as const,songId:'private-song-id-12345',revision:randomUUID()};
  const receipt=issueUndo(target,'test-only-secret',1000)!;
  assert.equal(readUndo(receipt.token,'block','test-only-secret',1001)?.songId,target.songId);
  assert.equal(readUndo(receipt.token,'like','test-only-secret',1001),null);
  assert.equal(readUndo(receipt.token,'block','other-secret',1001),null);
  assert.equal(readUndo(receipt.token,'block','test-only-secret',receipt.expiresAt),null);
  assert.equal(readUndo('x'+receipt.token.slice(1),'block','test-only-secret',1001),null);
  assert.equal(readUndo('x'.repeat(1600),'block','test-only-secret',1001),null);
  assert.equal(issueUndo(target,''),null);
  assert.ok(!Buffer.from(receipt.token,'base64url').toString('utf8').includes(target.songId));
});

test('undo removes exact listener record and exact House block revision only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'feedback-undo-'));
  process.env.STATE_DIR=dir;
  try {
    const likes=await import('../src/broadcast/likes.js');
    const blocks=await import('../src/music/blocklist.js');
    await blocks.load();
    const track={id:'a',title:'Test A'};
    await likes.recordLike({track,startedAt:'air-1',ip:'listener-a'});
    await likes.recordLike({track,startedAt:'air-1',ip:'listener-b'});
    await likes.operatorLike(track);
    const own=(await likes.listenerUndoTarget('a','air-1','listener-a'))!;
    assert.equal((await likes.undoListenerLike(own)).count,2);
    assert.equal((await likes.status({songId:'a',startedAt:'air-1',ip:'listener-a'})).liked,false);
    assert.equal((await likes.status({songId:'a',startedAt:'air-1',ip:'listener-b'})).liked,true);
    assert.equal(likes.operatorLiked('a'),true);
    assert.equal((await likes.undoListenerLike(own)).removed,false);
    await likes.recordLike({track,startedAt:'air-1',ip:'listener-a'});
    assert.equal((await likes.undoListenerLike(own)).removed,false); // Later re-like survives the old receipt.
    assert.equal((await likes.status({songId:'a',startedAt:'air-1',ip:'listener-a'})).liked,true);
    await likes.recordLike({track,startedAt:'air-2',ip:'listener-a'});
    await likes.undoListenerLike(own);
    assert.equal((await likes.status({songId:'a',startedAt:'air-2',ip:'listener-a'})).liked,true);
    const persisted=JSON.parse(readFileSync(join(dir,'likes.json'),'utf8'));
    assert.equal(persisted.likes.length,4);

    const revision=randomUUID();
    await blocks.add({type:'track',id:'a',undoRevision:revision});
    await blocks.add({type:'artist',id:'artist-a'});
    await blocks.add({type:'album',id:'album-a'});
    assert.equal(await blocks.undoHouseTrack('a',randomUUID()),'changed');
    assert.equal(await blocks.undoHouseTrack('a',revision),'removed');
    assert.equal(await blocks.undoHouseTrack('a',revision),'missing');
    assert.equal(blocks.list().length,2);
    await blocks.add({type:'track',id:'a'}); // Operator replacement is NOT undoable.
    assert.equal(await blocks.undoHouseTrack('a',revision),'changed');
    const persistedBlocks=JSON.parse(readFileSync(join(dir,'blocklist.json'),'utf8'));
    assert.equal(persistedBlocks.entries.length,3);

    // Exercise the real authenticated HTTP route against these isolated stores.
    const express=(await import('express')).default;
    const {router}=await import('../src/routes/house-control.js');
    const app=express();app.use(express.json());app.use(router);
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address() as {port:number};
    const previousSecret=process.env.HOUSE_CONTROL_TOKEN;
    process.env.HOUSE_CONTROL_TOKEN='test-only-house-secret';
    const token=issueUndo((await likes.listenerUndoTarget('a','air-2','listener-a'))!)!.token;
    const post=async(body:unknown,secret='test-only-house-secret')=>fetch(`http://127.0.0.1:${address.port}/house-control/undo-feedback`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret},body:JSON.stringify(body)});
    try {
      assert.equal((await post({action:'undo_like',undoToken:token},'wrong')).status,401);
      assert.equal((await post({action:'undo_like',undoToken:token,songId:'other'})).status,400);
      assert.equal((await post({action:'undo_never_play',undoToken:token})).status,409);
      assert.equal((await post({action:'undo_like',undoToken:'bad'})).status,409);
      const response=await post({action:'undo_like',undoToken:token});
      assert.equal(response.status,200);assert.equal((await response.json()).liked,false);
      assert.equal((await post({action:'undo_like',undoToken:token})).status,200);
      assert.equal((await likes.status({songId:'a',startedAt:'air-1',ip:'listener-b'})).liked,true);
      const oldBlock=issueUndo({kind:'block',songId:'a',revision})!;
      assert.equal((await post({action:'undo_never_play',undoToken:oldBlock.token})).status,409);
      delete process.env.HOUSE_CONTROL_TOKEN;
      assert.equal((await post({action:'undo_like',undoToken:token})).status,503);
    } finally {
      if(previousSecret===undefined)delete process.env.HOUSE_CONTROL_TOKEN;else process.env.HOUSE_CONTROL_TOKEN=previousSecret;
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
