import express from 'express';
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

const deps: NeverPlayDeps = {
  getNowPlaying: () => queue.getNowPlaying(),
  listBlocks: () => blocklist.list(),
  addTrackBlock: (input) => blocklist.add(input),
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
