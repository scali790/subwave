import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeHouseControl,
  getNeverPlayCurrent,
  neverPlayCurrent,
  type NeverPlayDeps,
} from '../src/house-control.js';

function makeDeps(options: {
  nowPlaying?: any[];
  blocks?: Array<{ type: string; id: string }>;
  addResult?: any | null;
} = {}) {
  const nowPlaying = [...(options.nowPlaying ?? [
    { subsonic_id: 'song-123', title: 'Lucky', artist: 'Jason Mraz', album: 'Album' },
  ])];
  const blocks = [...(options.blocks ?? [])];
  const calls = {
    add: [] as any[],
    purge: 0,
    refresh: 0,
    logs: [] as Array<[string, string]>,
  };

  const deps: NeverPlayDeps = {
    getNowPlaying: async () => nowPlaying.length > 1 ? nowPlaying.shift() : nowPlaying[0],
    listBlocks: () => blocks,
    addTrackBlock: async (input) => {
      calls.add.push(input);
      if (Object.prototype.hasOwnProperty.call(options, 'addResult')) return options.addResult ?? null;
      const entry = {
        ...input,
        addedAt: '2026-10-03T00:00:00.000Z',
      };
      blocks.push({ type: entry.type, id: entry.id });
      return entry;
    },
    purgeBlocked: () => {
      calls.purge += 1;
      return 2;
    },
    refreshAutoPlaylist: async () => {
      calls.refresh += 1;
    },
    log: (level, message) => {
      calls.logs.push([level, message]);
    },
  };

  return { deps, calls };
}

test('house-control auth fails closed without a configured token', () => {
  assert.equal(authorizeHouseControl('Bearer anything', ''), 'unconfigured');
});

test('house-control auth rejects missing and wrong bearer values', () => {
  assert.equal(authorizeHouseControl(undefined, 'secret'), 'unauthorized');
  assert.equal(authorizeHouseControl('Basic abc', 'secret'), 'unauthorized');
  assert.equal(authorizeHouseControl('Bearer wrong', 'secret'), 'unauthorized');
});

test('house-control auth accepts only the exact bearer token', () => {
  assert.equal(authorizeHouseControl('Bearer secret-value', 'secret-value'), 'ok');
});

test('status reports exact current track block state', async () => {
  const clear = makeDeps();
  const clearResult = await getNeverPlayCurrent('song-123', clear.deps);
  assert.equal(clearResult.status, 200);
  assert.equal(clearResult.body.blocked, false);

  const blocked = makeDeps({ blocks: [{ type: 'track', id: 'song-123' }] });
  const blockedResult = await getNeverPlayCurrent('song-123', blocked.deps);
  assert.equal(blockedResult.status, 200);
  assert.equal(blockedResult.body.blocked, true);
});

test('status ignores album/artist entries for exact-track state', async () => {
  const { deps } = makeDeps({
    blocks: [
      { type: 'album', id: 'song-123' },
      { type: 'artist', id: 'song-123' },
    ],
  });
  const result = await getNeverPlayCurrent('song-123', deps);
  assert.equal(result.status, 200);
  assert.equal(result.body.blocked, false);
});

test('status rejects missing, non-music and stale song ids', async () => {
  const { deps } = makeDeps();
  assert.equal((await getNeverPlayCurrent('', deps)).status, 400);

  const none = makeDeps({ nowPlaying: [{ title: 'Jingle' }] });
  assert.equal((await getNeverPlayCurrent('song-123', none.deps)).status, 409);

  const stale = makeDeps();
  assert.equal((await getNeverPlayCurrent('song-old', stale.deps)).status, 409);
});

test('never-play adds only one exact track and runs existing block side effects', async () => {
  const { deps, calls } = makeDeps();
  const result = await neverPlayCurrent('song-123', deps);

  assert.equal(result.status, 201);
  assert.equal(result.body.blocked, true);
  assert.equal(result.body.alreadyBlocked, false);
  assert.equal(result.body.purged, 2);
  assert.deepEqual(calls.add, [{
    type: 'track',
    id: 'song-123',
    name: 'Lucky',
    artist: 'Jason Mraz',
    album: 'Album',
  }]);
  assert.equal(calls.purge, 1);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.logs.length, 1);
  assert.match(calls.logs[0][1], /house-control:/);
});

test('already-blocked current track is idempotent', async () => {
  const { deps, calls } = makeDeps({ blocks: [{ type: 'track', id: 'song-123' }] });
  const result = await neverPlayCurrent('song-123', deps);

  assert.equal(result.status, 200);
  assert.equal(result.body.blocked, true);
  assert.equal(result.body.alreadyBlocked, true);
  assert.equal(calls.add.length, 0);
  assert.equal(calls.purge, 0);
  assert.equal(calls.refresh, 0);
});

test('track change between preflight and mutation fails with 409 and no block', async () => {
  const { deps, calls } = makeDeps({
    nowPlaying: [
      { subsonic_id: 'song-123', title: 'First', artist: 'Artist' },
      { subsonic_id: 'song-456', title: 'Next', artist: 'Artist' },
    ],
  });
  const result = await neverPlayCurrent('song-123', deps);

  assert.equal(result.status, 409);
  assert.equal(calls.add.length, 0);
  assert.equal(calls.purge, 0);
  assert.equal(calls.refresh, 0);
});

test('blocklist duplicate race remains idempotent', async () => {
  const { deps, calls } = makeDeps({ addResult: null });
  const result = await neverPlayCurrent('song-123', deps);

  assert.equal(result.status, 200);
  assert.equal(result.body.blocked, true);
  assert.equal(result.body.alreadyBlocked, true);
  assert.equal(calls.add.length, 1);
  assert.equal(calls.purge, 0);
  assert.equal(calls.refresh, 0);
});
