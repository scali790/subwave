// Exercise the actual runTrackEvent -> pool/repair -> enqueue path in isolated
// state. Only the agent result and HTTP dependencies are deterministic.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-discovery-fallback-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://library.invalid';
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { breakerSuccess } = await import('../src/broadcast/dj-agent/breaker.js');
const session = await import('../src/broadcast/session.js');
const song = { id: 'candidate-abcdefghijklmnop', title: 'Quiet Turn', artist: 'Synthetic Quartet', duration: 300 };
after(() => {
  const q = queue as any;
  clearTimeout(q._persistTimer); clearTimeout(q._recentPlaysTimer);
  library.shutdown(); rmSync(stateRoot, { recursive: true, force: true });
});

for (const mode of ['skip', 'empty', 'near-miss', 'repick'] as const) {
  test(`radio caller ${mode}: queues a real candidate through the existing fallback/repair`, async () => {
    await settings.load();
    await library.load();
    await settings.update({ llm: { pickerAgent: true, dailyTokenCap: 0, artistVarietyWindow: 0,
      provider: 'openai-compatible', model: 'synthetic-pool', baseUrl: 'https://pool.invalid/v1',
      fallback: { enabled: false } } });
    breakerSuccess();
    library.set(song.id, { ...song, moods: ['calm'], energy: 'medium' });
    const q = queue as any;
    q.current = null; q.upcoming = []; q.history = []; q.djLog = []; q._recentPlays = [];
    q.senderBusy = true;
    const originalRun = pickerAgent.run;
    const originalFetch = globalThis.fetch;
    let modelCalls = 0;
    (pickerAgent as any).run = async () => {
      if (mode === 'skip' || mode === 'empty') throw Object.assign(new Error('No candidates'), {
        name: 'AgentDiscoveryError', discoveryCalls: mode === 'empty' ? 1 : 0,
      });
      return { object: { id: mode === 'near-miss' ? song.id.slice(0, -1) : 'fabricated-other-id',
        reason: 'Fits.', say: null, transition: 'normal' }, steps: 2,
        toolCalls: [{ name: 'findTracks', result: [song] }], extras: { seen: new Map([[song.id, song]]) } };
    };
    globalThis.fetch = (async (input: any, init: any) => {
      const url = new URL(String(input));
      if (url.origin === 'http://library.invalid') return Response.json({ 'subsonic-response': {
        status: 'ok', randomSongs: { song: [song] }, similarSongs2: { song: [song] },
        topSongs: { song: [song] }, searchResult3: { song: [song], artist: [] },
        albumList2: { album: [] }, genres: { genre: [] },
      } });
      assert.equal(url.href, 'https://pool.invalid/v1/chat/completions', 'no external/backup call');
      modelCalls++;
      const body = JSON.parse(init.body);
      const name = body.tools?.[0]?.function.name;
      const value = { id: song.id, reason: 'Fits the show.', transition: 'normal', say: null };
      return Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: name ? 'tool_calls' : 'stop', message: {
          role: 'assistant', content: name ? null : JSON.stringify(value),
          ...(name ? { tool_calls: [{ id: 'emit', type: 'function', function: { name, arguments: JSON.stringify(value) } }] } : {}),
        } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }) as typeof fetch;
    try {
      const ctx = { activeShow: null, clock: {}, time: { period: 'day' }, dominantMood: 'calm' };
      session.start(ctx as any);
      await runTrackEvent(queue, ctx, { wantLink: false });
      assert.deepEqual(queue.upcoming.map(item => item.track.id), [song.id]);
      assert.equal(modelCalls, mode === 'near-miss' ? 0 : 1);
      const log = queue.djLog.map(entry => entry.message).join('\n');
      assert.match(log, mode === 'near-miss' ? /repaired to near-miss/ : mode === 'repick' ? /re-picked/ : /falling back to pool/);
      if (mode === 'empty') assert.doesNotMatch(log, /DJ agent pick failed/);
      if (mode === 'skip') assert.match(log, /DJ agent pick failed/);
    } finally {
      (pickerAgent as any).run = originalRun; globalThis.fetch = originalFetch;
      q.senderBusy = false;
    }
  });
}
