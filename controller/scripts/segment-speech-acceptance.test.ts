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
test('600 characters pass unchanged without a shortening call', async () => {
  const text = 'a'.repeat(599) + '.';
  const result = await prepareSegmentSpeech(text, validate, async () => { throw new Error('unexpected call'); });
  assert.equal(result.text, text); assert.equal(result.shortened, false);
});
test('632 characters cause exactly one logical rewrite and final validation', async () => {
  let calls = 0;
  const result = await prepareSegmentSpeech('a'.repeat(631) + '.', validate, async (text, ceiling) => {
    calls++; assert.equal(text.length, 632); assert.equal(ceiling, 600);
    return 'Eine vollständige, kurze Ansage.';
  });
  assert.equal(calls, 1); assert.equal(result.shortened, true);
});
for (const revised of ['a'.repeat(600) + '.', '', 'Ein abgeschnittener Satz']) {
  test('unusable rewrite is rejected without another attempt: ' + revised.length, async () => {
    let calls = 0;
    await assert.rejects(prepareSegmentSpeech('a'.repeat(631) + '.', validate,
      async () => { calls++; return revised; }));
    assert.equal(calls, 1);
  });
}
test('codepoints, whitespace and pronunciation expansion use the speech contract', async () => {
  assert.equal((await prepareSegmentSpeech('🙂'.repeat(599) + '.', validate,
    async () => { throw new Error('unexpected'); })).shortened, false);
  const display = 'x'.repeat(590) + ' 12°C.';
  let rewrites = 0;
  const result = await prepareSegmentSpeech(display,
    text => validate(normalizeForSpeech(text)),
    async () => { rewrites++; return 'Zwölf Grad Celsius.'; });
  assert.equal(rewrites, 1); assert.equal(result.text, 'Zwölf Grad Celsius.');
});
test('unknown voice is not rewritten and absent contract does not invent a ceiling', async () => {
  await assert.rejects(prepareSegmentSpeech('Hallo.', () => { throw new SpeechRequestError('unknown_voice'); },
    async () => { throw new Error('unexpected'); }), { code: 'unknown_voice' });
  const text = 'a'.repeat(1000);
  assert.equal((await prepareSegmentSpeech(text, t => validateSpeech(t, null),
    async () => { throw new Error('unexpected'); })).text, text);
});

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
const originalDirector = directorAgent.run;
const originalForced = forcedDirectorAgent.run;
const q = queue as any;
const originalAir = q._airVoice;
let revised = 'Eine kurze vollständige Ansage.';
let modelCalls = 0, speechPosts = 0, airCalls = 0;
let backendReject = false;
let simpleGeneration = false;
let sourceText = 'a'.repeat(631) + '.';
const context = { time: { period: 'day', mood: 'calm' }, weather: null, clock: {} } as any;

beforeEach(async () => {
  modelCalls = 0; speechPosts = 0; airCalls = 0; backendReject = false;
  simpleGeneration = false;
  revised = 'Eine kurze vollständige Ansage.'; sourceText = 'a'.repeat(631) + '.';
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === 'http://remote.test/health') return Response.json({ ok: true, capabilities: contract });
    if (url === 'http://remote.test/speak') {
      speechPosts++;
      if (backendReject) return Response.json({ error: 'text_too_long', actual_chars: 632, max_chars: 600 }, { status: 413 });
      assert.equal(JSON.parse(String(init?.body)).text, revised);
      return new Response(Buffer.from('RIFF-fake-audio'));
    }
    if (url === 'https://model.invalid/v1/chat/completions') {
      modelCalls++;
      const body = JSON.parse(String(init?.body));
      assert.ok(body.messages.some((m: any) => String(m.content).includes('within 500 characters')));
      if (!(simpleGeneration && modelCalls === 1)) {
        assert.ok(body.max_tokens <= 1024 || body.max_completion_tokens <= 1024);
      }
      const name = body.tools[0].function.name;
      const value = simpleGeneration && modelCalls === 1
        ? { air: true, reason: 'synthetic fixture', text: sourceText, sfx: null }
        : { text: revised };
      return Response.json({ id: 'synthetic', model: 'synthetic', created: 1, object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'rewrite', type: 'function', function: { name, arguments: JSON.stringify(value) } }] } }],
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
      baseUrl: 'https://model.invalid/v1', fallback: { enabled: false }, agentTimeoutMs: 1000 } } as never);
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
  await withTrace({ kind: 'segment' }, async () => { id = currentTrace()!.traceId; await run(); });
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const lines = readdirSync(join(root, 'logs')).filter(n => n.startsWith('events-'))
      .flatMap(n => readFileSync(join(root, 'logs', n), 'utf8').trim().split('\n').filter(Boolean))
      .map(line => JSON.parse(line));
    const end = lines.find(e => e.traceId === id && e.type === 'trace.end');
    if (end) return end;
  }
  throw new Error('missing trace.end');
}
test('actual autonomous caller rewrites before TTS and queues only the shortened text', async () => {
  const end = await traceEnd(() => agenticTick(context));
  assert.equal(end.ok, true); assert.equal(modelCalls, 1); assert.equal(speechPosts, 1); assert.equal(airCalls, 1);
});
test('actual forced caller reports accepted shortened text', async () => {
  const result = await runCapability('short-segment', context);
  assert.equal(result.queued, true); assert.equal(result.text, revised); assert.equal(modelCalls, 1);
});
test('pool-mode autonomous caller applies the same guard and final acceptance', async () => {
  await settings.update({ llm: { pickerAgent: false } });
  simpleGeneration = true;
  const end = await traceEnd(() => agenticTick(context));
  assert.equal(end.ok, true); assert.equal(modelCalls, 2); assert.equal(speechPosts, 1); assert.equal(airCalls, 1);
});
test('pool-mode forced caller applies the same guard and final acceptance', async () => {
  await settings.update({ llm: { pickerAgent: false } });
  simpleGeneration = true;
  const result = await runCapability('short-segment', context);
  assert.equal(result.queued, true); assert.equal(result.text, revised); assert.equal(modelCalls, 2);
});
test('still oversize rewrite fails the autonomous trace without TTS or handoff', async () => {
  revised = 'b'.repeat(631) + '.';
  const end = await traceEnd(() => agenticTick(context));
  assert.equal(end.ok, false); assert.match(end.error, /632 characters/);
  assert.equal(modelCalls, 1); assert.equal(speechPosts, 0); assert.equal(airCalls, 0);
});
test('late backend rejection fails the enclosing trace even when queue handles the exception', async () => {
  sourceText = revised; backendReject = true;
  const end = await traceEnd(() => agenticTick(context));
  assert.equal(end.ok, false); assert.equal(modelCalls, 0); assert.equal(speechPosts, 1); assert.equal(airCalls, 0);
});
test('rewriter is not given a fresh deadline after director consumed its budget', async () => {
  const run = directorAgent.run;
  directorAgent.run = async args => {
    await new Promise(resolve => setTimeout(resolve, (settings.get().llm.agentTimeoutMs ?? 45000) + 50));
    return run(args);
  };
  const end = await traceEnd(() => agenticTick(context));
  assert.equal(end.ok, false); assert.match(end.error, /deadline exhausted/);
  assert.equal(modelCalls, 0); assert.equal(speechPosts, 0);
});
test('preflight uses the dispatcher normalization and scoped failures do not leak', async () => {
  assert.throws(() => tts.validateSpokenText('x'.repeat(590) + ' 12°C.', 'short-segment'), { code: 'text_too_long' });
  const failed = await traceEnd(async () => { markTraceFailure(new Error('handled')); });
  const next = await traceEnd(async () => {});
  assert.equal(failed.ok, false); assert.equal(next.ok, true);
});
after(async () => {
  globalThis.fetch = originalFetch; directorAgent.run = originalDirector; forcedDirectorAgent.run = originalForced;
  q._airVoice = originalAir; q.senderBusy = false;
  clearTimeout(q._persistTimer); clearTimeout(q._recentPlaysTimer);
  await new Promise(resolve => setTimeout(resolve, 1200)); rmSync(root, { recursive: true, force: true });
});
