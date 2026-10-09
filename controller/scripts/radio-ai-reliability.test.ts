import test from 'node:test';
import assert from 'node:assert/strict';
import { contractText, validateSpeech, readSpeechConstraints, SpeechRequestError } from '../src/audio/tts-contract.js';
import { withinOperation, withLlmBudget, operationSignal, currentOperation, upstreamDiagnostic } from '../src/llm/internal/core/operation.js';
import { FallbackAvailability } from '../src/llm/internal/core/fallback-availability.js';
import { withTransientRetry } from '../src/llm/internal/core/retry.js';

const contract = readSpeechConstraints({ schema_version: 1, max_text_chars: 600,
  text_normalization: 'python-whitespace-codepoints-v1', voices: ['marlowe:v1', 'wren:v1', 'hale:v1'] })!;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('599/600 accepted; 601/615 rejected without a render', () => {
  for (const n of [599, 600]) assert.doesNotThrow(() => validateSpeech('x'.repeat(n), contract));
  for (const n of [601, 615]) assert.throws(() => validateSpeech('x'.repeat(n), contract),
    (e: SpeechRequestError) => e.code === 'text_too_long' && e.actualChars === n && e.maxChars === 600);
});

test('Python whitespace and Unicode codepoint semantics; no silent shortening', () => {
  assert.equal(contractText(' \u0085Hello\u001cworld\u3000 '), 'Hello world');
  assert.equal(contractText('\ufeffx'), '\ufeffx', 'Python does not strip FEFF');
  assert.doesNotThrow(() => validateSpeech('😀'.repeat(600), contract));
  assert.throws(() => validateSpeech('😀'.repeat(601), contract), SpeechRequestError);
});

test('generic remote without capabilities retains its contract; approved voices only when advertised', () => {
  assert.equal(readSpeechConstraints({ max_text_chars: 600 }), null);
  assert.equal(readSpeechConstraints({ ...contract, schema_version: 2 }), null);
  assert.doesNotThrow(() => validateSpeech('x'.repeat(900), null, 'other-server-voice'));
  for (const voice of contract.voices!) assert.doesNotThrow(() => validateSpeech('Hi', contract, voice));
  assert.throws(() => validateSpeech('Hi', contract, 'bm_daniel'), /unknown_voice/);
});

test('an unavailable fallback is skipped during cooldown, then readmitted only with its model', async () => {
  let now = 0, calls = 0, online = false, modelPresent = true;
  const fetcher = (async () => {
    calls++;
    if (!online) throw new TypeError('fetch failed');
    return Response.json({ models: modelPresent ? [{ name: 'qwen:latest' }] : [] });
  }) as typeof fetch;
  const gate = new FallbackAvailability(fetcher, () => now, 60, 15);
  const cfg = { provider: 'ollama', model: 'qwen', ollamaUrl: 'http://worker' };
  assert.equal(await gate.ready(cfg, cfg.ollamaUrl), false);
  online = true;
  assert.equal(await gate.ready(cfg, cfg.ollamaUrl), false);
  assert.equal(calls, 1);
  now = 61;
  assert.equal(await gate.ready(cfg, cfg.ollamaUrl), true);
  gate.failed(cfg);
  assert.equal(await gate.ready(cfg, cfg.ollamaUrl), false);
  now = 122; modelPresent = false;
  assert.equal(await gate.ready(cfg, cfg.ollamaUrl), false);
  assert.equal(calls, 3);
});

test('simultaneous half-open callers share one bounded catalogue probe', async () => {
  let calls = 0;
  const gate = new FallbackAvailability((async () => {
    calls++; await delay(10); return Response.json({ models: [{ name: 'qwen:9b' }] });
  }) as typeof fetch);
  const cfg = { provider: 'ollama', model: 'qwen:9b' };
  assert.deepEqual(await Promise.all([gate.ready(cfg, 'http://worker'), gate.ready(cfg, 'http://worker')]), [true, true]);
  assert.equal(calls, 1);
});

test('auth errors and absent catalogue models do not count as readiness', async () => {
  for (const response of [new Response('', { status: 401 }), Response.json({ models: [{ name: 'other:9b' }] })]) {
    const gate = new FallbackAvailability((async () => response) as typeof fetch);
    assert.equal(await gate.ready({ provider: 'ollama', model: 'qwen:9b' }, 'http://worker'), false);
  }
});

test('one deadline survives nested recovery; late work cannot start a new retry', async () => {
  let attempts = 0, outerId: string | undefined, innerId: string | undefined;
  const started = performance.now();
  await assert.rejects(withinOperation(35, async () => {
    outerId = currentOperation()?.id;
    await delay(15);
    return withinOperation(200, async () => {
      innerId = currentOperation()?.id;
      return withTransientRetry('deadline-test', async () => {
        attempts++;
        await delay(35);
        operationSignal()?.throwIfAborted();
        throw new TypeError('fetch failed');
      });
    });
  }), { name: 'LlmDeadlineError' });
  assert.ok(performance.now() - started < 200);
  await delay(60);
  assert.equal(attempts, 1);
  assert.equal(innerId, outerId);
});

test('an already cancelled caller cannot start a provider request', async () => {
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  let attempts = 0;
  await assert.rejects(withinOperation(100, async () => { attempts++; }, abort.signal), /cancelled/);
  assert.equal(attempts, 0);
});

test('upstream diagnostics retain status/budget reason without response text or credentials', () => {
  const d = upstreamDiagnostic({ lastError: { statusCode: 424, responseBody: JSON.stringify({
    last_error: { error: 'upstream_timeout', status_code: 503, text: 'SECRET-DO-NOT-LOG' },
    elapsed_seconds: 6.01, attempted_keys: 1,
  }) } });
  assert.deepEqual(d, { httpStatus: 424, upstreamCode: 'upstream_timeout', upstreamStatus: 503, upstreamSeconds: 6.01, upstreamAttempts: 1 });
  assert.ok(!JSON.stringify(d).includes('SECRET'));
});

test('decision deadline prevents stateless recovery calls while deterministic music recovery completes', async () => {
  let calls = 0, musicRecovered = false;
  await withLlmBudget(25, async () => {
    await assert.rejects(withinOperation(200, async () => { calls++; await delay(60); }), { name: 'LlmDeadlineError' });
    await assert.rejects(withinOperation(200, async () => { calls++; }), { name: 'LlmDeadlineError' });
    musicRecovered = true;
  });
  assert.equal(calls, 1);
  assert.equal(musicRecovered, true);
});

test('a late successful catalogue probe cannot override a newer failed generation', async () => {
  let resolve!: (r: Response) => void;
  const gate = new FallbackAvailability((() => new Promise<Response>(r => { resolve = r; })) as typeof fetch);
  const cfg = { provider: 'ollama', model: 'qwen', ollamaUrl: 'http://worker' };
  const pending = gate.ready(cfg, cfg.ollamaUrl);
  gate.failed(cfg);
  resolve(Response.json({ models: [{ name: 'qwen:latest' }] }));
  assert.equal(await pending, false);
  assert.equal(await gate.ready(cfg, cfg.ollamaUrl), false);
});
