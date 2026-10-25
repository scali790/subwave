import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSegmentSpeech } from '../src/skills/segment-speech.js';
import { validateSpeech, SpeechRequestError } from '../src/audio/tts-contract.js';
import { normalizeForSpeech } from '../src/audio/speech-text.js';

const contract = { schema_version: 1, max_text_chars: 600,
  text_normalization: 'python-whitespace-codepoints-v1' } as const;
const validate = (text: string) => validateSpeech(text, contract);
test('exactly 600 characters retain their complete text', () => {
  const text = 'a'.repeat(599) + '.';
  assert.equal(prepareSegmentSpeech(text, validate), text);
});
for (const chars of [601, 632, 659]) {
  test('oversize text is rejected without a rewrite interface: ' + chars, () => {
    assert.throws(() => prepareSegmentSpeech('a'.repeat(chars - 1) + '.', validate),
      { code: 'text_too_long', actualChars: chars, maxChars: 600 });
  });
}
test('codepoints and expanded pronunciation determine the limit', () => {
  const text = '🙂'.repeat(599) + '.';
  assert.equal(prepareSegmentSpeech(text, validate), text);
  assert.throws(() => prepareSegmentSpeech('x'.repeat(590) + ' 12°C.',
    t => validate(normalizeForSpeech(t))), { code: 'text_too_long' });
});
test('voice rejection and empty text remain errors; unknown contracts invent no ceiling', () => {
  assert.throws(() => prepareSegmentSpeech('Hallo.', () => { throw new SpeechRequestError('unknown_voice'); }),
    { code: 'unknown_voice' });
  assert.throws(() => prepareSegmentSpeech('  ', validate), /no spoken text/);
  const text = 'a'.repeat(1000);
  assert.equal(prepareSegmentSpeech(text, t => validateSpeech(t, null)), text);
});
const preserved = 'Mara wünscht Leise Wege von Blauer Hof für ihre Schwester Nora. Der Wunsch ist noch nicht bestätigt. Das Konzert am 18. Oktober findet nicht statt. Laut Veranstalter werden die 15 Franken erstattet; ein Ersatztermin steht noch nicht fest.';
test('admissible statements retain names, numbers, negation, uncertainty and attribution', () => {
  assert.equal(prepareSegmentSpeech(preserved, validate), preserved);
  assert.equal(prepareSegmentSpeech('**' + preserved + '**', validate), preserved);
});
const frozen = JSON.parse(readFileSync(new URL('./fixtures/segment-speech-semantics.json', import.meta.url), 'utf8')) as Array<{ id: string; text: string }>;
for (const fixture of frozen) {
  test('14 October qualification source is discarded rather than rewritten: ' + fixture.id, () => {
    assert.throws(() => prepareSegmentSpeech(fixture.text, validate), { code: 'text_too_long' });
  });
}

const root = mkdtempSync(join(tmpdir(), 'segment-speech-acceptance-'));
process.env.STATE_DIR = root;
mkdirSync(join(root, 'skills', 'short-segment'), { recursive: true });
writeFileSync(join(root, 'skills', 'short-segment', 'SKILL.md'),
  '---\nname: short-segment\ncooldown: 0\n---\nSay one complete sentence.\n');
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { loadSkills } = await import('../src/skills/loader.js');
const session = await import('../src/broadcast/session.js');
const { directorAgent, forcedDirectorAgent, agenticTick, runCapability } = await import('../src/skills/_agent.js');
const { withTrace, currentTrace, markTraceFailure } = await import('../src/observability/events.js');
const remote = await import('../src/audio/remoteTts.js');
const tts = await import('../src/audio/tts.js');
const originalFetch = globalThis.fetch;
const originalDirector = directorAgent.run, originalForced = forcedDirectorAgent.run;
const q = queue as any;
const originalAir = q._airVoice;
let modelCalls = 0, speechPosts = 0, airCalls = 0;
let backendReject = false, pool = false;
let sourceText = 'a'.repeat(631) + '.';
const context = { time: { period: 'day', mood: 'calm' }, weather: null, clock: {} } as any;

beforeEach(async () => {
  modelCalls = 0; speechPosts = 0; airCalls = 0; backendReject = false; pool = false;
  sourceText = 'a'.repeat(631) + '.';
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === 'http://remote.test/health') return Response.json({ ok: true, capabilities: contract });
    if (url === 'http://remote.test/speak') {
      speechPosts++;
      if (backendReject) return Response.json({ error: 'text_too_long', actual_chars: 632, max_chars: 600 }, { status: 413 });
      assert.equal(JSON.parse(String(init?.body)).text, normalizeForSpeech(sourceText));
      return new Response(Buffer.from('RIFF-fake-audio'));
    }
    if (url === 'https://model.invalid/v1/chat/completions') {
      modelCalls++;
      assert.ok(pool && modelCalls === 1, 'no shortening/recovery request may follow the initial generation');
      const body = JSON.parse(String(init?.body));
      assert.ok(body.messages.some((m: any) => String(m.content).includes('within 500 characters')));
      const name = body.tools[0].function.name;
      return Response.json({ id: 'synthetic', model: 'synthetic', created: 1, object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'initial', type: 'function', function: { name,
            arguments: JSON.stringify({ air: true, reason: 'synthetic fixture', text: sourceText, sfx: null }) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    }
    throw new Error('test forbids network: ' + url);
  }) as typeof fetch;
  await settings.load();
  const persona = { ...settings.get().personas[0], id: 'p_test', name: 'Test DJ', language: 'de',
    skills: ['short-segment'], frequency: 'aggressive', tts: { engine: 'remote', voice: '', cloudProvider: 'openai' } };
  await settings.update({ personas: [persona], activePersonaId: persona.id, shows: [], schedule: {},
    scheduleOverride: null, skills: { enabled: { 'short-segment': true } }, sfx: { enabled: false },
    tts: { defaultEngine: 'remote', remote: { url: 'http://remote.test' } },
    llm: { pickerAgent: true, provider: 'openai-compatible', model: 'synthetic',
      baseUrl: 'https://model.invalid/v1', fallback: { enabled: false } } } as never);
  await remote.refresh(); await loadSkills(); session.start(context);
  q.senderBusy = true; q.current = null; q.upcoming = []; q.history = []; q.djLog = [];
  q._airVoice = async () => { airCalls++; return { voiceId: 'test', clipMs: 1000, aired: Promise.resolve(null) }; };
  directorAgent.run = async () => ({ object: { air: true, segment: { kind: 'short-segment', text: sourceText, sfx: null } },
    steps: 1, toolCalls: [], extras: undefined });
  forcedDirectorAgent.run = async () => ({ object: { text: sourceText, sfx: null },
    steps: 1, toolCalls: [], extras: undefined });
});
async function traceEnd(run: () => Promise<unknown>) {
  let id = '';
  try {
    await withTrace({ kind: 'segment' }, async () => { id = currentTrace()!.traceId; await run(); });
  } catch (err) {
    assert.ok(err instanceof SpeechRequestError);
  }
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const lines = readdirSync(join(root, 'logs')).filter(n => n.startsWith('events-'))
      .flatMap(n => readFileSync(join(root, 'logs', n), 'utf8').trim().split('\n').filter(Boolean))
      .map(line => JSON.parse(line));
    const end = lines.find(e => e.traceId === id && e.type === 'trace.end');
    if (end) return { end, events: lines.filter(e => e.traceId === id) };
  }
  throw new Error('missing trace.end');
}
for (const mode of ['agent', 'pool'] as const) {
  for (const trigger of ['autonomous', 'forced'] as const) {
    for (const admissible of [true, false]) {
      test(mode + ' ' + trigger + ': ' + (admissible ? 'accepts unchanged text' : 'discards oversize before TTS/handoff'), async () => {
        pool = mode === 'pool';
        if (pool) await settings.update({ llm: { pickerAgent: false } });
        if (admissible) sourceText = preserved;
        let result: Awaited<ReturnType<typeof runCapability>> | undefined;
        const { end, events } = await traceEnd(async () => {
          if (trigger === 'autonomous') await agenticTick(context);
          else result = await runCapability('short-segment', context);
        });
        assert.equal(end.ok, admissible);
        assert.equal(modelCalls, pool ? 1 : 0);
        assert.equal(speechPosts, admissible ? 1 : 0); assert.equal(airCalls, admissible ? 1 : 0);
        assert.ok(!events.some(e => e.type === 'speech.shorten' || e.type === 'speech.shortened'));
        if (!admissible) {
          assert.match(end.error, /632 characters/);
          assert.ok(events.some(e => e.type === 'speech.rejected' && e.stage === 'preflight'));
        }
        if (result) { assert.equal(result.queued, true); assert.equal(result.text, sourceText); }
      });
    }
  }
}
test('late backend rejection still fails the enclosing trace', async () => {
  sourceText = preserved; backendReject = true;
  const { end } = await traceEnd(() => agenticTick(context));
  assert.equal(end.ok, false); assert.equal(modelCalls, 0); assert.equal(speechPosts, 1); assert.equal(airCalls, 0);
});
test('dispatcher normalization and handled failure scopes remain intact', async () => {
  assert.throws(() => tts.validateSpokenText('x'.repeat(590) + ' 12°C.', 'short-segment'), { code: 'text_too_long' });
  const failed = await traceEnd(async () => { markTraceFailure(new Error('handled')); });
  const next = await traceEnd(async () => {});
  assert.equal(failed.end.ok, false); assert.equal(next.end.ok, true);
});
after(async () => {
  globalThis.fetch = originalFetch; directorAgent.run = originalDirector; forcedDirectorAgent.run = originalForced;
  q._airVoice = originalAir; q.senderBusy = false;
  clearTimeout(q._persistTimer); clearTimeout(q._recentPlaysTimer);
  await new Promise(resolve => setTimeout(resolve, 1200)); rmSync(root, { recursive: true, force: true });
});
