// Exercise the real SDK/strategy/failover path with synthetic HTTP responses.
// A 424 has no model output to repair: it must not buy another primary call.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { APICallError } from 'ai';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-object-recovery-'));
const { getDefaults, setCache } = await import('../src/settings/store.js');
const { djObject } = await import('../src/llm/internal/strategy/object.js');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');
const schema = z.object({ say: z.string() });
type Seen = { url: string; body: any; signal?: AbortSignal };
type Provider = 'openai-compatible' | 'deepseek';

function configure(fallback = false, provider: Provider = 'openai-compatible', timeoutMs = 5000) {
  recentCalls.length = 0;
  setCache({ ...getDefaults(), llm: {
    ...getDefaults().llm, provider, model: 'radio-primary-test',
    keys: { deepseek: 'synthetic-not-a-real-key' },
    baseUrl: 'https://radio-primary.invalid/v1', reasoning: false, agentTimeoutMs: timeoutMs,
    fallback: { enabled: fallback, provider: 'openai-compatible', model: 'radio-backup-test',
      baseUrl: 'https://radio-backup.invalid/v1', reasoning: false },
  } });
}
function completion(body: any, object: unknown = { say: 'Ein guter Song darf bleiben.' }) {
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  return new Response(JSON.stringify({
    id: 'synthetic', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: tools ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: tools ? null : JSON.stringify(object),
      ...(tools ? { tool_calls: [{ id: 'emit-test', type: 'function', function: { name: 'emit', arguments: JSON.stringify(object) } }] } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function failure(status: number) {
  return new Response(JSON.stringify({ error: { message: 'Synthetic upstream rejection', code: status === 424 ? 'upstream_total_budget_exhausted' : 'test_failure' },
    last_error: { error: 'upstream_total_budget_exhausted' }, elapsed_seconds: 6, attempted_keys: 1,
  }), { status, headers: { 'content-type': 'application/json' } });
}
async function capturing<T>(respond: (call: Seen, calls: Seen[]) => Response | Promise<Response>, run: (calls: Seen[]) => Promise<T>) {
  const original = globalThis.fetch;
  const calls: Seen[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal };
    // All requests are intercepted; no real provider or credentials are used.
    assert.match(call.url, /^https:\/\/(?:radio-(?:primary|backup)\.invalid\/v1|api\.deepseek\.com(?:\/v1)?)\/chat\/completions$/);
    calls.push(call);
    return respond(call, calls);
  }) as typeof fetch;
  try { return await run(calls); }
  finally { globalThis.fetch = original; setCache(null); }
}
const generate = (options: { signal?: AbortSignal } = {}) => djObject({ system: 'A synthetic test.', prompt: 'Return a short line.', schema, kind: 'test.objectRecovery', ...options });

for (const provider of ['openai-compatible', 'deepseek'] as const) {

test(`${provider}: 424 consumes one primary attempt, then reaches the configured backup`, async () => {
  configure(true, provider);
  await capturing(call => call.body.model === 'radio-primary-test' ? failure(424) : completion(call.body), async calls => {
    assert.deepEqual(await generate(), { say: 'Ein guter Song darf bleiben.' });
    assert.deepEqual(calls.map(c => c.body.model), ['radio-primary-test', 'radio-backup-test']);
    const failed = recentCalls.find(c => !c.ok);
    assert.equal(failed?.upstream.httpStatus, 424);
    assert.equal(failed?.upstream.upstreamCode, 'upstream_total_budget_exhausted');
    assert.match(failed?.via, /^ai-sdk(?::tool)?:failover/);
    assert.ok(!failed?.via.includes('recovery'));
  });
});
test(`${provider}: 424 without backup preserves the upstream error without a format retry`, async () => {
  configure(false, provider);
  await capturing(() => failure(424), async calls => {
    await assert.rejects(generate, (err: any) => err.statusCode === 424);
    assert.equal(calls.length, 1);
  });
});
test(`${provider}: authentication refusal does not trigger a second billable primary attempt`, async () => {
  configure(false, provider);
  await capturing(() => failure(401), async calls => {
    await assert.rejects(generate, (err: any) => err.statusCode === 401);
    assert.equal(calls.length, 1);
  });
});
test(`${provider}: invalid structured output still gets one free-text recovery`, async () => {
  configure(false, provider);
  await capturing((call, calls) => completion(call.body, calls.length === 1 ? {} : { say: 'Recovered.' }), async calls => {
    assert.deepEqual(await generate(), { say: 'Recovered.' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.tools, undefined);
    assert.match(calls[1].body.messages.at(-1).content, /JSON Schema/);
  });
});
test(`${provider}: a provider rejecting its structured-output mode with 400 retains compatibility recovery`, async () => {
  configure(false, provider);
  await capturing((call, calls) => calls.length === 1 ? failure(400) : completion(call.body), async calls => {
    assert.deepEqual(await generate(), { say: 'Ein guter Song darf bleiben.' });
    assert.equal(calls.length, 2);
  });
});
test(`${provider}: a successful structured response stays a single call`, async () => {
  configure(false, provider);
  await capturing(call => completion(call.body), async calls => {
    assert.deepEqual(await generate(), { say: 'Ein guter Song darf bleiben.' });
    assert.equal(calls.length, 1);
  });
});

test(`${provider}: failures on both legs do not start format recovery on either leg`, async () => {
  configure(true, provider);
  await capturing(() => failure(424), async calls => {
    await assert.rejects(generate, (err: any) => err.statusCode === 424);
    assert.deepEqual(calls.map(c => c.body.model), ['radio-primary-test', 'radio-backup-test']);
  });
});

test(`${provider}: exhausted transient retries do not gain another sequence through format recovery`, async () => {
  configure(true, provider);
  await capturing(call => {
    if (call.body.model === 'radio-backup-test') return completion(call.body);
    // Disable the SDK's own retries for this synthetic transport error so the
    // assertion measures the existing Subwave retry owner (initial + two).
    throw new APICallError({ message: 'Synthetic upstream overloaded', url: call.url,
      requestBodyValues: call.body, statusCode: 503, isRetryable: false,
      responseHeaders: { 'retry-after-ms': '1' } });
  }, async calls => {
    assert.deepEqual(await generate(), { say: 'Ein guter Song darf bleiben.' });
    assert.deepEqual(calls.map(c => c.body.model), [
      'radio-primary-test', 'radio-primary-test', 'radio-primary-test', 'radio-backup-test',
    ]);
    assert.ok(calls.slice(0, 3).every(c => c.body.tools || c.body.response_format));
  });
});

test(`${provider}: deadline cancels the request without format recovery or fallback`, async () => {
  configure(true, provider, 100);
  let aborts = 0;
  await capturing(call => new Promise<Response>((_, reject) => {
    assert.ok(call.signal);
    const abort = () => { aborts++; reject(call.signal!.reason); };
    if (call.signal.aborted) abort(); else call.signal.addEventListener('abort', abort, { once: true });
  }), async calls => {
    await assert.rejects(generate, { name: 'LlmDeadlineError' });
    // Allow the cancelled transport/failover to unwind before restoring fetch.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(aborts, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, 'radio-primary-test');
  });
});
}

test('a cancelled caller makes no provider request', async () => {
  configure(true);
  const controller = new AbortController();
  const reason = new Error('Synthetic caller cancellation');
  controller.abort(reason);
  await capturing(call => completion(call.body), async calls => {
    await assert.rejects(generate({ signal: controller.signal }), error => error === reason);
    assert.equal(calls.length, 0);
  });
});
