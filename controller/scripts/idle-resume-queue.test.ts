import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-idle-resume-'));
process.env.STATE_DIR = root;
const { Queue } = await import('../src/broadcast/queue.js');
const { acknowledgeFreshResume, resumeProgramme } = await import('../src/broadcast/idle-resume.js');
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

test('an old atomic write already in flight cannot commit over fresh speech', async (t) => {
  const path = join(root, 'atomic-speech.txt');
  const original = fs.promises.writeFile;
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof original>) => {
    if (args[1] === 'evening speech') { entered(); await blocked; }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const oldWrite = writeHandoff(path, 'evening speech', { maxWaitMs: 0 });
    const rejected = assert.rejects(oldWrite, /invalidated before commit/);
    await writing;
    invalidatePendingHandoffs();
    await writeHandoff(path, 'morning speech', { maxWaitMs: 0 });
    release(); await rejected;
    assert.equal(readFileSync(path, 'utf8'), 'morning speech');
  } finally { release?.(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const fault of ['two lost replies', 'mixer restart'] as const) {
  test(`fresh preparation recovers after ${fault} without leaving the Queue held`, async () => {
    const q = new Queue(); q._writeHandoff = async () => {};
    let idle = true, mixerGeneration = '', lost = fault === 'two lost replies' ? 2 : 0;
    let restart = fault === 'mixer restart', preparedGeneration = '';
    const deps = {
      clock: () => ({ pausedAt: 1000, programmeKey: 'morning' }),
      prepare: async () => {
        q.beginProgrammeResume();
        idle = true; // the monitor's idle_on, before any context/library work
        preparedGeneration = await q.prepareProgrammeResume('/morning.wav', {
          resetMixer: async generation => { assert.equal(idle, true); mixerGeneration = generation; },
          queueStatus: async () => 'ready' as const,
        });
      },
      release: async () => {
        if (restart) { restart = false; idle = false; mixerGeneration = ''; }
        await acknowledgeFreshResume(preparedGeneration, async command => {
          const generation = command.split(' ')[1];
          if (generation !== mixerGeneration) return 'ERROR generation mismatch';
          idle = false;
          if (lost > 0) { lost--; throw Error('lost reply'); }
          return 'OK';
        });
      },
    };
    await assert.rejects(resumeProgramme(null, deps));
    assert.equal(q._programmeResumePreparing, true);
    await resumeProgramme(null, deps);
    q.finishProgrammeResume();
    assert.equal(idle, false);
    assert.equal(q._programmeResumePreparing, false);
  });
}
