import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-idle-resume-'));
process.env.STATE_DIR = root;
const { Queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
const { invalidatePendingHandoffs, writeHandoff } = await import('../src/broadcast/queue/voice-io.js');
after(async () => {
  await new Promise(resolve => setTimeout(resolve, 1100)); // let Queue.persist's debounce finish
  rmSync(root, { recursive: true, force: true });
});

test('fresh resume clears the actual Queue and stale handoff files before publishing morning music', async () => {
  const q = new Queue();
  const old = { track: { id: 'evening', title: 'Evening' }, queuedAt: new Date().toISOString() } as typeof q.upcoming[number];
  q.current = old; q.upcoming = [old]; q.lastSeenKey = 'evening';
  const files = [config.liquidsoap.queueFile, config.liquidsoap.sayFile, config.liquidsoap.introFile,
    config.liquidsoap.jingleFile, config.liquidsoap.sfxFile, config.liquidsoap.nowPlayingFile];
  for (const file of files) writeFileSync(file, 'evening-content');
  const events: string[] = [];
  q._writeHandoff = async (_path: string, uri: string) => {
    assert.equal(q._programmeResumePreparing, true);
    assert.equal(q.current, null); assert.equal(q.upcoming.length, 0);
    assert.equal(uri, 'annotate:title="Morning":/morning.wav');
    events.push('new-music');
  };
  await q.prepareProgrammeResume('annotate:title="Morning":/morning.wav', {
    resetMixer: async () => { for (const file of files) assert.equal(existsSync(file), false); events.push('reset'); },
    queueStatus: async () => { events.push('ready'); return 'ready' as const; },
  });
  assert.deepEqual(events, ['reset', 'new-music', 'ready']);
  assert.equal(q._programmeResumePreparing, true, 'watcher stays held until acknowledged mixer release');
  q.finishProgrammeResume();
  assert.equal(q._programmeResumePreparing, false);
});

test('busy old work holds the gate; failed mixer reset cannot publish new music', async () => {
  const q = new Queue(); q.senderBusy = true;
  assert.throws(() => q.beginProgrammeResume(), /in-flight/);
  assert.equal(q._programmeResumePreparing, true);
  q.senderBusy = false;
  let published = false;
  q._writeHandoff = async () => { published = true; };
  await assert.rejects(q.prepareProgrammeResume('/morning.wav', {
    resetMixer: async () => { throw Error('old mixer'); }, queueStatus: async () => 'ready' as const,
  }), /old mixer/);
  assert.equal(published, false); assert.equal(q._programmeResumePreparing, true);
});

test('a new queue write is refused while a fresh programme is being prepared', async () => {
  const q = new Queue(); q.beginProgrammeResume();
  await assert.rejects(q.push({ track: { id: 'late-evening', title: 'Late evening', artist: 'Artist', album: 'Album', duration: 120 } }), /programme resume/);
});

test('a waiting old speech handoff cannot overwrite the fresh programme', async () => {
  const path = join(root, 'queued-speech.txt');
  writeFileSync(path, 'existing clip');
  const oldWrite = writeHandoff(path, 'evening speech', { maxWaitMs: 150 });
  await new Promise(resolve => setTimeout(resolve, 20));
  invalidatePendingHandoffs();
  await assert.rejects(oldWrite, /earlier programme/);
  assert.equal(readFileSync(path, 'utf8'), 'existing clip');
  unlinkSync(path);
  await writeHandoff(path, 'morning speech', { maxWaitMs: 0 });
  assert.equal(readFileSync(path, 'utf8'), 'morning speech');
});

test('an old in-flight watcher read cannot publish after fresh preparation', async () => {
  const q = new Queue();
  let release!: (value: null) => void;
  q.readNowPlayingFromDisk = () => new Promise(resolve => { release = resolve; });
  let starts = 0;
  q.onTrackStarted = () => { starts++; };
  const interval = globalThis.setInterval;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  try { q.startWatcher(); } finally { globalThis.setInterval = interval; }
  q.beginProgrammeResume();
  q.finishProgrammeResume();
  release(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 0);
  assert.equal(q._nowPlaying, null);
});
