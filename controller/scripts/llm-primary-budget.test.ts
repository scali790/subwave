import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-primary-budget-'));
const { getDefaults, setCache } = await import('../src/settings/store.js');
const { djObject } = await import('../src/llm/internal/strategy/object.js');
const { withinOperation, withProviderBudget, operationSignal, currentOperation } = await import('../src/llm/internal/core/operation.js');
const { configuredUpstreamBudgetMs } = await import('../src/llm/internal/provider/upstream-budget.js');
const { withTransientRetry } = await import('../src/llm/internal/core/retry.js');
const { agentPlan } = await import('../src/llm/internal/strategy/plan.js');
const { prefersJsonObjectMode } = await import('../src/llm/internal/provider/capabilities.js');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const schema = z.object({ say: z.string() });

test('primary budget is explicit, finite, compatible-provider-only and case insensitive', () => {
  const cfg = (value: string) => ({ provider: 'openai-compatible', headers: { 'X-Homelab-Upstream-Budget-Seconds': value } });
  assert.equal(configuredUpstreamBudgetMs(cfg('20')), 20000);
  for (const value of ['NaN', 'Infinity', '-1', '0', '4.9', '']) assert.equal(configuredUpstreamBudgetMs(cfg(value)), undefined);
  assert.equal(configuredUpstreamBudgetMs({ ...cfg('20'), provider: 'ollama' }), undefined);
  assert.equal(configuredUpstreamBudgetMs({ provider: 'openai-compatible' }), undefined);
});

test('nested phase cannot reset deadline; timeout leaves parent usable', async () => {
  await withinOperation(1000, async () => {
    const parent = currentOperation();
    let childSignal: AbortSignal | undefined;
    const started = performance.now();
    await assert.rejects(withProviderBudget(80, async () => {
      childSignal = operationSignal();
      const deadline = currentOperation()!.providerDeadline;
      await sleep(40);
      return withProviderBudget(500, async () => {
        assert.equal(currentOperation()!.providerDeadline, deadline);
        return new Promise(() => {}); // provider ignores cancellation
      });
    }), { name: 'LlmProviderDeadlineError' });
    assert.ok(performance.now() - started < 300);
    assert.equal(childSignal?.aborted, true);
    assert.equal(operationSignal()?.aborted, false);
    assert.equal(currentOperation(), parent);
    assert.equal(await withProviderBudget(80, async () => 'backup'), 'backup');
  });
});

test('provider budget includes retry backoff and starts no ghost attempt', async () => {
  let attempts = 0;
  await withinOperation(1000, async () => {
    await assert.rejects(withProviderBudget(80, () => withTransientRetry('fixture', async () => {
      attempts++;
      throw Object.assign(new Error('upstream timeout'), { statusCode: 504 });
    })), { name: 'LlmProviderDeadlineError' });
    await sleep(100);
    assert.equal(attempts, 1);
  });
});

test('outer deadline outranks provider deadline', async () => {
  await assert.rejects(withinOperation(40, () => withProviderBudget(500, () => new Promise(() => {}))), { name: 'LlmDeadlineError' });
});

function configure(backup = true, budget = '6', total = 45000) {
  setCache({ ...getDefaults(), llm: { ...getDefaults().llm, provider: 'openai-compatible', model: 'primary-fixture', baseUrl: 'https://primary.invalid/v1', reasoning: false, agentTimeoutMs: total,
    headers: { 'X-Homelab-Upstream-Budget-Seconds': budget }, fallback: { enabled: backup, provider: 'openai-compatible', model: 'backup-fixture', baseUrl: 'https://backup.invalid/v1', reasoning: false } } });
}
type Call = { url: string; body: any; signal?: AbortSignal; budget: number | null };
function completion(call: Call, malformed = false) {
  const tools = call.body.tools?.length;
  const message = tools && !malformed
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-emit', type: 'function', function: { name: 'emit', arguments: JSON.stringify({ say: 'Musik bleibt.' }) } }] }
    : { role: 'assistant', content: malformed ? 'not valid output' : JSON.stringify({ say: 'Musik bleibt.' }) };
  return new Response(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: call.body.model,
    choices: [{ index: 0, finish_reason: tools && !malformed ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'content-type': 'application/json' } });
}
async function transport(run: (calls: Call[]) => Promise<void>, respond: (call: Call, calls: Call[]) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const headers = new Headers(init?.headers);
    const call: Call = { url: String(input), body: JSON.parse(init.body), signal: init.signal, budget: headers.has('x-homelab-upstream-budget-seconds') ? Number(headers.get('x-homelab-upstream-budget-seconds')) : null };
    assert.match(call.url, /^https:\/\/(primary|backup)\.invalid\/v1\/chat\/completions$/);
    calls.push(call);
    return respond(call, calls);
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; setCache(null); }
}
const generate = (extra = {}) => djObject({ system: 'Synthetic fixture', prompt: 'One short line', schema, ...extra });

test('SDK format recovery receives decreasing budget, not another full allowance', async () => {
  configure();
  await transport(async calls => {
    assert.deepEqual(await generate(), { say: 'Musik bleibt.' });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.body.model === 'primary-fixture'));
    assert.ok(calls[0].budget! <= 6 && calls[0].budget! > 5.8);
    assert.ok(calls[1].budget! < calls[0].budget! - 0.15);
  }, async (call, calls) => { await sleep(200); return completion(call, calls.length === 1); });
});

test('SDK cannot start format recovery below gateway minimum; backup retains time', async () => {
  configure();
  await transport(async calls => {
    assert.deepEqual(await generate(), { say: 'Musik bleibt.' });
    assert.deepEqual(calls.map(c => c.body.model), ['primary-fixture', 'backup-fixture']);
  }, async call => {
    if (call.body.model === 'primary-fixture') { await sleep(1200); return completion(call, true); }
    return completion(call);
  });
});

test('slow SDK 504 retries stay inside phase and cannot consume operation', async () => {
  configure();
  await transport(async calls => {
    const started = performance.now();
    assert.deepEqual(await generate(), { say: 'Musik bleibt.' });
    assert.ok(performance.now() - started < 6500);
    assert.equal(calls.filter(c => c.body.model === 'backup-fixture').length, 1);
    const count = calls.length;
    await sleep(100);
    assert.equal(calls.length, count);
  }, async call => {
    if (call.body.model === 'backup-fixture') return completion(call);
    await sleep(1200);
    return new Response(JSON.stringify({ error: { message: 'Synthetic slow upstream' } }), { status: 504, headers: { 'content-type': 'application/json' } });
  });
});

test('hung primary aborts at phase deadline and synthetic backup succeeds', async () => {
  configure();
  let aborted = false;
  await transport(async calls => {
    const started = performance.now();
    assert.deepEqual(await generate(), { say: 'Musik bleibt.' });
    assert.ok(performance.now() - started < 6500);
    assert.equal(aborted, true);
    assert.deepEqual(calls.map(c => c.body.model), ['primary-fixture', 'backup-fixture']);
  }, call => call.body.model === 'backup-fixture' ? completion(call) : new Promise((_resolve, reject) => {
    call.signal!.addEventListener('abort', () => { aborted = true; reject(call.signal!.reason); }, { once: true });
  }));
});

test('caller cancellation aborts transport and never starts backup', async () => {
  configure(true, '20');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('owner cancelled')), 80);
  let aborted = false;
  try {
    await transport(async calls => {
      await assert.rejects(generate({ signal: controller.signal }), /owner cancelled/);
      await sleep(100);
      assert.equal(aborted, true);
      assert.deepEqual(calls.map(c => c.body.model), ['primary-fixture']);
    }, call => new Promise((_resolve, reject) => {
      call.signal!.addEventListener('abort', () => { aborted = true; reject(call.signal!.reason); }, { once: true });
    }));
  } finally { clearTimeout(timer); }
});

test('pinned primary cannot cross to backup after exhausted recovery budget', async () => {
  configure();
  await transport(async calls => {
    await assert.rejects(generate({ leg: 'primary' }), { name: 'LlmProviderDeadlineError' });
    assert.deepEqual(calls.map(c => c.body.model), ['primary-fixture']);
  }, async call => { await sleep(1200); return completion(call, true); });
});

test('unconfigured backup yields a bounded failure, never a model substitution', async () => {
  configure(false);
  await transport(async calls => {
    await assert.rejects(generate(), { name: 'LlmProviderDeadlineError' });
    assert.equal(calls.length, 1);
  }, async call => { await sleep(1200); return completion(call, true); });
});

test('qualified Nemotron object mode sends JSON and schema; real agent tools stay tools', async () => {
  configure(false, '20');
  const model = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const cfg = { ...getDefaults().llm, provider: 'openai-compatible', model, baseUrl: 'https://primary.invalid/v1', headers: { 'X-Homelab-Upstream-Budget-Seconds': '20' }, reasoning: false, fallback: { enabled: false } };
  setCache({ ...getDefaults(), llm: cfg });
  assert.equal(prefersJsonObjectMode(cfg), true);
  assert.equal(prefersJsonObjectMode({ ...cfg, model: 'other-model' }), false);
  assert.equal(prefersJsonObjectMode({ ...cfg, provider: 'ollama' }), false);
  assert.equal(agentPlan(cfg, schema, 1), 'done-tool');
  await transport(async calls => {
    assert.deepEqual(await generate(), { say: 'Musik bleibt.' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[0].body.tools, undefined);
    assert.match(JSON.stringify(calls[0].body.messages), /JSON Schema/);
    assert.match(JSON.stringify(calls[0].body.messages), /say/);
  }, call => completion(call));
});

test('Nemotron JSON mode still rejects a schema-invalid object', async () => {
  const model = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  setCache({ ...getDefaults(), llm: { ...getDefaults().llm, provider: 'openai-compatible', model, baseUrl: 'https://primary.invalid/v1', reasoning: false, fallback: { enabled: false } } });
  await transport(async calls => {
    await assert.rejects(generate());
    assert.equal(calls.length, 2, 'one schema repair only');
  }, call => new Response(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: call.body.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"wrong":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'content-type': 'application/json' } }));
});
