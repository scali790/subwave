import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'subwave-idle-session-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { resumeProgramme } = await import('../src/broadcast/idle-resume.js');
const { zonedISODate } = await import('../src/time.js');
after(() => rmSync(root, { recursive: true, force: true }));

function weekFor(id: string) {
  return Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, Array(24).fill(id)]));
}
async function seed(sameShow = false) {
  const personaId = settings.get().personas[0].id;
  const week = weekFor('evening');
  if (!sameShow) week[6][8] = 'weekend_morning';
  await settings.update({ timezone: 'Europe/Zurich', scheduleOverride: null,
    shows: [{ id: 'evening', name: 'Evening', personaId }, { id: 'weekend_morning', name: 'Weekend Morning', personaId }],
    schedule: week,
  } as never);
}
function context(at: Date) {
  return { at: at.toISOString(), time: { period: 'morning', vibe: 'fresh', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', date: {}, clock: {}, listeners: 1,
    activeShow: settings.resolveActiveShow(at) } as never;
}

test('real station schedule and session resolve Friday evening -> Saturday morning after ten hours', async () => {
  await seed();
  const eveningAt = new Date('2026-10-30T21:00:00Z');
  const morningAt = new Date('2026-10-31T07:00:00Z');
  const identity = (at: Date) => ({ pausedAt: at.getTime(), programmeKey: `${zonedISODate(at)}:${settings.resolveActiveShow(at)?.id}` });
  session.start(context(eveningAt));
  session.appendTurn({ role: 'assistant', kind: 'link', text: 'Yesterday evening speech' });
  let released = false;
  await resumeProgramme(identity(eveningAt), {
    clock: () => identity(morningAt),
    prepare: async () => { await session.restartAfterIdle(context(morningAt)); },
    release: async fresh => {
      assert.equal(fresh, true);
      assert.equal(session.getSession()?.show?.id, 'weekend_morning');
      assert.equal(session.pendingHandoff(), null);
      assert.equal(session.getSession()?.messages.some(t => t.text.includes('Yesterday evening')), false);
      released = true;
    },
  });
  assert.equal(released, true);
});

test('same-show long resume invalidates an already-rendering old host utterance', async () => {
  await seed(true);
  const at = new Date('2026-10-30T21:00:00Z');
  session.start(context(at));
  const old = session.captureHostSpeech(at);
  assert.ok(old);
  await session.restartAfterIdle(context(new Date('2026-10-31T07:00:00Z')));
  assert.equal(session.isHostSpeechCurrent(old), false);
  assert.equal(session.getSession()?.handoff, null);
});
