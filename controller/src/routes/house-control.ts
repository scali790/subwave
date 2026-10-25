import express from 'express';
import { randomUUID } from 'node:crypto';
import { issueUndo, readUndo } from '../feedback-undo.js';
import * as likes from '../broadcast/likes.js';
import { createHouseSkip } from '../skip-current.js';
import { skipTrack } from '../broadcast/liquidsoap-control.js';
import { queue } from '../broadcast/queue.js';
import * as blocklist from '../music/blocklist.js';
import { refreshAutoPlaylist } from '../broadcast/scheduler.js';
import {
  authorizeHouseControl,
  getNeverPlayCurrent,
  neverPlayCurrent,
  type NeverPlayDeps,
} from '../house-control.js';

export const router = express.Router();

const houseSkip = createHouseSkip({
  getNowPlaying: () => queue.getNowPlaying(),
  commitBeforeSkip: () => queue.commitBeforeSkip(),
  skipTrack: () => skipTrack(),
});

for (const method of ['get', 'post'] as const) {
  router[method]('/house-control/skip-current', async (req, res) => {
    if (!authorize(req, res)) return;
    try {
      const result = method === 'get'
        ? await houseSkip.status(req.query.songId)
        : await houseSkip.skip(req.body?.songId);
      res.status(result.status).json(result.body);
    } catch {
      res.status(500).json({ error: 'House skip not confirmed; do not retry automatically' });
    }
  });
}

const deps: NeverPlayDeps = {
  getNowPlaying: () => queue.getNowPlaying(),
  listBlocks: () => blocklist.list(),
  addTrackBlock: (input) => blocklist.add({ ...input, undoRevision:randomUUID() }),
  issueUndo: (entry) => issueUndo({ kind:'block', songId:entry.id, revision:entry.undoRevision }),
  purgeBlocked: () => queue.purgeBlocked(),
  refreshAutoPlaylist: () => refreshAutoPlaylist(),
  log: (level, message) => queue.log(level as any, message),
};

function authorize(req: express.Request, res: express.Response): boolean {
  const result = authorizeHouseControl(req.headers.authorization);
  if (result === 'ok') return true;
  if (result === 'unconfigured') {
    res.status(503).json({ error: 'house control is not configured' });
    return false;
  }
  res.status(401).json({ error: 'house control authorization required' });
  return false;
}

router.get('/house-control/never-play-current', async (req, res) => {
  if (!authorize(req, res)) return;
  try {
    const result = await getNeverPlayCurrent(req.query.songId, deps);
    res.status(result.status).json(result.body);
  } catch (err: any) {
    queue.log('error', `house-control never-play status failed: ${err?.message || err}`);
    res.status(500).json({ error: 'house control failed' });
  }
});

router.post('/house-control/never-play-current', async (req, res) => {
  if (!authorize(req, res)) return;
  try {
    const result = await neverPlayCurrent(req.body?.songId, deps);
    res.status(result.status).json(result.body);
  } catch (err: any) {
    queue.log('error', `house-control never-play failed: ${err?.message || err}`);
    res.status(500).json({ error: 'house control failed' });
  }
});

router.post('/house-control/undo-feedback', async (req,res) => {
  if (!authorize(req,res)) return;
  const action=req.body?.action;
  if (!req.body || Object.keys(req.body).some(k => !['action','undoToken'].includes(k)) || !['undo_like','undo_never_play'].includes(action)) return res.status(400).json({ error:'Invalid undo request' });
  const target=readUndo(req.body.undoToken,action==='undo_like'?'like':'block');
  if (!target) return res.status(409).json({ error:'Undo expired or invalid' });
  try {
    if (target.kind==='like') {
      const result=await likes.undoListenerLike(target);
      return res.json({ ok:true, liked:false, count:result.count, removed:result.removed });
    }
    const result=await blocklist.undoHouseTrack(target.songId,target.revision);
    if (result==='changed') return res.status(409).json({ error:'Block changed; not removed' });
    if (result==='removed') refreshAutoPlaylist().catch(() => queue.log('error','Undo: automatic playlist refresh failed'));
    return res.json({ ok:true, never_play:false, removed:result==='removed' });
  } catch { return res.status(503).json({ error:'Undo not confirmed; no automatic retry' }); }
});
