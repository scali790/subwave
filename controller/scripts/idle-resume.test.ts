import assert from 'node:assert/strict';
import test from 'node:test';
import { needsFreshProgramme, resumeProgramme } from '../src/broadcast/idle-resume.js';
import { setStationTimezone, zonedISODate, zonedParts } from '../src/time.js';

setStationTimezone('Europe/Zurich');
// A local fixture schedule; no host clock changes, network or model calls.
function clock(iso: string) {
  const date = new Date(iso);
  const { hour, dow } = zonedParts(date);
  const weekend = dow === 0 || dow === 6;
  const show = hour >= 6 && hour < 12 ? (weekend ? 'weekend-morning' : 'morning') : 'evening';
  return { pausedAt: date.getTime(), programmeKey: `${zonedISODate(date)}:${show}` };
}

test('Friday evening -> Saturday morning after ten hours prepares the weekend programme before audio', async () => {
  const paused = clock('2026-10-30T21:00:00Z'); // Friday 22:00 Zurich
  const morning = clock('2026-10-31T07:00:00Z'); // Saturday 08:00 Zurich
  const audio = ['evening-song', 'evening-speech'];
  const events: string[] = [];
  const fresh = await resumeProgramme(paused, {
    clock: () => morning,
    prepare: async () => { events.push('prepare'); audio.splice(0, audio.length, morning.programmeKey); },
    release: async reset => { assert.equal(reset, true); assert.deepEqual(audio, ['2026-10-31:weekend-morning']); events.push('release'); },
  });
  assert.equal(fresh, true);
  assert.deepEqual(events, ['prepare', 'release']);
});

test('weekday evening -> weekday morning resolves the current local day', () => {
  assert.equal(needsFreshProgramme(clock('2026-10-28T21:00:00Z'), Date.parse('2026-10-29T07:00:00Z'), clock('2026-10-29T07:00:00Z').programmeKey), true);
});

test('a short pause within the same programme preserves the music', async () => {
  let prepared = false;
  const paused = clock('2026-10-30T19:00:00Z');
  assert.equal(await resumeProgramme(paused, {
    clock: () => clock('2026-10-30T19:05:00Z'),
    prepare: async () => { prepared = true; },
    release: async fresh => assert.equal(fresh, false),
  }), false);
  assert.equal(prepared, false);
});

test('a changed programme requires fresh music even after a short pause', () => {
  assert.equal(needsFreshProgramme({ pausedAt: 100, programmeKey: 'evening' }, 200, 'morning'), true);
});

test('a long pause refreshes even the same programme', () => {
  assert.equal(needsFreshProgramme({ pausedAt: 0, programmeKey: 'night' }, 30 * 60_000, 'night'), true);
});

test('unknown recovered idle state and backward clock both require fresh preparation', () => {
  assert.equal(needsFreshProgramme(null, 100, 'morning'), true);
  assert.equal(needsFreshProgramme({ pausedAt: 200, programmeKey: 'morning' }, 100, 'morning'), true);
});

test('failed preparation leaves the output gate closed', async () => {
  let released = false;
  await assert.rejects(resumeProgramme(null, {
    clock: () => clock('2026-10-31T07:00:00Z'),
    prepare: async () => { throw Error('library unavailable'); },
    release: async () => { released = true; },
  }), /library unavailable/);
  assert.equal(released, false);
});

test('another schedule boundary during preparation cannot release obsolete audio', async () => {
  let current = { pausedAt: 100, programmeKey: 'morning' };
  let released = false;
  await assert.rejects(resumeProgramme(null, {
    clock: () => current,
    prepare: async () => { current = { pausedAt: 200, programmeKey: 'lunch' }; },
    release: async () => { released = true; },
  }), /programme changed/);
  assert.equal(released, false);
});

test('mixer refusal propagates instead of claiming a successful resume', async () => {
  await assert.rejects(resumeProgramme(null, {
    clock: () => clock('2026-10-31T07:00:00Z'), prepare: async () => {},
    release: async () => { throw Error('old mixer'); },
  }), /old mixer/);
});
