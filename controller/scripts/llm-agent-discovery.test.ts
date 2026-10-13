// Real SDK cascade, synthetic HTTP only. A configured but stopped backup must
// never be contacted for a semantic discovery miss.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-agent-discovery-'));
const { getDefaults, setCache } = await import('../src/settings/store.js');
const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
const { defineAgent } = await import('../src/llm/internal/agent-factory.js');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');
const schema = z.object({ id: z.string(), reason: z.string() });
type Call = { body: any; signal?: AbortSignal };
const answer = { id: 'candidate-001', reason: 'Fits the programme.' };

function completion(body: any, name?: string, object: unknown = answer) {
  return Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: name ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: name ? null : JSON.stringify(object),
      ...(name ? { tool_calls: [{ id: 'call-'+name, type: 'function', function: {
        name, arguments: JSON.stringify(name === 'findTracks' ? { query: 'jazz' } : object),
      } }] } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
}

async function fixture(mode: 'skip' | 'empty' | 'tool-error' | 'recover' | 'near-miss' | 'terminal' | 'slow', check: (calls: Call[], run: () => Promise<any>) => Promise<void>) {
  const defaults = getDefaults();
  setCache({ ...defaults, llm: { ...defaults.llm, provider: 'openai-compatible',
    model: 'synthetic-agent', baseUrl: 'https://agent.invalid/v1', reasoning: false,
    fallback: { ...defaults.llm.fallback, enabled: true, provider: 'ollama',
      ollamaUrl: 'http://stopped-backup.invalid', model: 'synthetic-backup' },
  } });
  recentCalls.length = 0;
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const seen = new Set<string>();
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://agent.invalid/v1/chat/completions', 'no backup or real network');
    const call = { body: JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    if (mode === 'slow') return new Promise<Response>((_, reject) => {
      const abort = () => reject(call.signal?.reason);
      if (call.signal?.aborted) abort(); else call.signal?.addEventListener('abort', abort, { once: true });
    });
    // OpenAI-compatible uses forced-tool mode, not native Output.object.
    if (mode === 'skip') return completion(call.body);
    if (calls.length === 1) return completion(call.body, 'findTracks');
    if (mode === 'near-miss') return completion(call.body, 'done', { ...answer, id: 'candidate-00' });
    if (calls.length === 2 || (mode === 'terminal' && calls.length === 3)) return completion(call.body);
    return completion(call.body, call.body.tools?.some((t: any) => t.function.name === 'emit') ? 'emit' : 'done');
  }) as typeof fetch;
  const agent = defineAgent({ kind: 'test.discovery', schema, timeoutMs: 5000,
    buildSystem: () => 'Find an eligible track before choosing.',
    buildTools: () => ({ tools: { findTracks: tool({ description: 'Search candidates',
      inputSchema: z.object({ query: z.string() }), execute: async () => {
        if (mode === 'tool-error') throw new Error('Synthetic discovery service failure');
        if (mode !== 'empty') seen.add(answer.id);
        return mode === 'empty' ? [] : [answer];
      } }) }, extras: seen }),
    hasDiscoveryResults: (extras: Set<string>) => extras.size > 0,
    validateObject: (object, extras: Set<string>) => extras.has(object.id),
  });
  try { await check(calls, () => agent.run({ messages: [{ role: 'user', content: 'Pick the next song.' }] })); }
  finally { globalThis.fetch = original; setCache(null); }
}

test('skipped discovery fails before done-only recovery and is recorded as failure', async () => {
  await fixture('skip', async (calls, run) => {
    await assert.rejects(run, (err: any) => err.name === 'AgentDiscoveryError' && err.discoveryCalls === 0);
    assert.equal(calls.length, 1, 'main only; no forced completion recovery');
    assert.equal(recentCalls.at(-1)?.ok, false);
    assert.equal(recentCalls.at(-1)?.usage?.total, 15);
  });
});
test('executed empty discovery is distinct from skipped discovery', async () => {
  await fixture('empty', async (calls, run) => {
    await assert.rejects(run, (err: any) => err.name === 'AgentDiscoveryError' && err.discoveryCalls === 1);
    assert.equal(calls.length, 2, 'no done-only recovery after an empty search');
  });
});
test('a failed tool execution does not masquerade as an empty library result', async () => {
  await fixture('tool-error', async (calls, run) => {
    await assert.rejects(run, (err: any) => err.name === 'AgentDiscoveryError' && err.discoveryCalls === 0);
    assert.equal(calls.length, 2);
  });
});
test('nonempty discovery retains done-only recovery and cumulative steps', async () => {
  await fixture('recover', async (calls, run) => {
    const result = await run();
    assert.deepEqual(result.object, answer);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.steps, calls.length);
    assert.equal(calls.length, 3);
  });
});
test('a near-miss id remains available for the caller repair contract', async () => {
  await fixture('near-miss', async (calls, run) => {
    const result = await run();
    assert.equal(result.object.id, 'candidate-00');
    assert.equal(result.extras.has(answer.id), true);
    assert.equal(calls.length, 2);
  });
});
test('nonempty discovery retains terminal collapse with its candidate trail', async () => {
  await fixture('terminal', async (calls, run) => {
    const result = await run();
    assert.deepEqual(result.object, answer);
    assert.match(JSON.stringify(calls.at(-1)?.body.messages), /candidate-001/);
    assert.equal(result.steps, calls.length);
  });
});
test('outer deadline aborts the transport without a new discovery or backup request', async () => {
  const { withinOperation } = await import('../src/llm/internal/core/operation.js');
  await fixture('slow', async (calls, run) => {
    await assert.rejects(() => withinOperation(30, run), { name: 'LlmDeadlineError' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal?.aborted, true);
  });
});
test('agents without discovery keep their schema-only behaviour', async () => {
  const original = globalThis.fetch;
  const defaults = getDefaults();
  setCache({ ...defaults, llm: { ...defaults.llm, provider: 'openai-compatible', model: 'synthetic-no-tools', baseUrl: 'https://agent.invalid/v1' } });
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://agent.invalid/v1/chat/completions');
    return completion(JSON.parse(init.body), 'emit');
  }) as typeof fetch;
  try { assert.deepEqual((await djAgent({ system: 'Choose', messages: [{ role: 'user', content: 'Choose.' }], schema })).object, answer); }
  finally { globalThis.fetch = original; setCache(null); }
});
test('an opted-in picker with no available discovery tools fails without spending a request', async () => {
  const original = globalThis.fetch;
  const defaults = getDefaults();
  setCache({ ...defaults, llm: { ...defaults.llm, provider: 'openai-compatible', model: 'synthetic-empty-tools', baseUrl: 'https://agent.invalid/v1' } });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('No request permitted'); }) as typeof fetch;
  try {
    await assert.rejects(() => djAgent({ system: 'Choose', messages: [{ role: 'user', content: 'Choose.' }], schema, tools: {}, discoveryReady: () => false }),
      (err: any) => err.name === 'AgentDiscoveryError' && err.discoveryCalls === 0);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; setCache(null); }
});
