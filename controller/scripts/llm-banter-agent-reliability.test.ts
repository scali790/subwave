import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-banter-agent-'));
const { getDefaults, setCache } = await import('../src/settings/store.js');
const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
const { generateBanter } = await import('../src/llm/internal/prompts/banter.js');
const { banterViolations, banterTopic } = await import('../src/llm/internal/prompts/banter-quality.js');
const { failureDiagnostics } = await import('../src/llm/internal/core/pure.js');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');
const host = { id: 'host', name: 'Ada', language: 'German', soul: 'Trocken, neugierig.' };
const guest = { id: 'guest', name: 'Ben', language: 'German', soul: 'Warm, verspielt.' };
const clean = [
  { speaker: 'host', text: 'Eine Pause ist auch ein Plan.' },
  { speaker: 'guest', text: 'Dann bin ich heute erstaunlich gut organisiert.' },
  { speaker: 'host', text: 'Solange du sie nicht mit Terminen füllst.' },
];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function configure(review = false, timeoutMs = 5000) {
  recentCalls.length = 0;
  setCache({ ...getDefaults(), llm: { ...getDefaults().llm, provider: 'openai-compatible',
    model: 'fixture', baseUrl: 'https://writer.invalid/v1', reasoning: false, agentTimeoutMs: timeoutMs,
    fallback: { enabled: review, provider: 'ollama', model: 'fixture-review', ollamaUrl: 'http://review.invalid:11434', reasoning: false },
  } });
}
function response(body: any, name: string | null, value: unknown) {
  return json({ id: 'fixture', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: name ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: name ? null : String(value),
      ...(name ? { tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(value) } }] } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}
async function transport<T>(respond: (url: string, body: any, signal?: AbortSignal) => Response | Promise<Response>, run: () => Promise<T>) {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    assert.match(String(url), /^https?:\/\/(writer|review)\.invalid(?::11434)?\//);
    return respond(String(url), init?.body ? JSON.parse(String(init.body)) : {}, init?.signal);
  }) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = saved; setCache(null); }
}
const banter = () => generateBanter({ host, guests: [guest], recentOpeners: ['Also ehrlich'], context: null });
test('Banter: topic framing avoids recently discussed subjects and abstains when exhausted', () => {
  assert.doesNotMatch(banterTopic('Lieblingssong nochmal hören', () => 0)!, /Lieblingssong/);
  assert.equal(banterTopic('Lieblingssong Playlist mitsingen Album Intro Empfehlungen'), null);
});
for (const [label, draft, decision, accepted] of [
  ['coherent dialogue passes', clean, { verdict: 'PASS', reason: 'Zusammenhängend und verständlich.' }, true],
  ['repeated opener cannot be waved through', [{ ...clean[0], text: 'Also ehrlich, eine Pause ist gut.' }, ...clean.slice(1)], { verdict: 'PASS', reason: 'Zusammenhängend und verständlich.' }, false],
  ['unreviewed rewrite is rejected', clean, { verdict: 'REWRITE', lines: clean }, false],
  ['rewrite cannot invent a speaker', clean, { verdict: 'REWRITE', lines: [{ ...clean[0], speaker: 'invented' }, ...clean.slice(1)] }, false],
  ['rewrite cannot repeat excluded opener', clean, { verdict: 'REWRITE', lines: [{ ...clean[0], text: 'Also ehrlich, hallo.' }, ...clean.slice(1)] }, false],
  ['reviewer rejects incoherent dialogue', clean, { verdict: 'DROP', reason: 'Nicht verständlich.' }, false],
  ['malformed reviewer output drops', clean, 'not JSON', false],
] as const) {
  test(`Banter: ${label}`, async () => {
    configure(true);
    let reviews = 0;
    await transport((url, body) => {
      if (url.endsWith('/api/tags')) return json({ models: [{ name: 'fixture-review' }] });
      if (url.includes('review.invalid')) {
        reviews++;
        return json({ model: 'fixture-review', created_at: new Date().toISOString(), message: { role: 'assistant', content: typeof decision === 'string' ? decision : JSON.stringify(decision) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 10 });
      }
      return response(body, 'emit', { lines: draft });
    }, async () => {
      const result = await banter();
      assert.equal(Boolean(result), accepted);
      assert.equal(reviews, label === 'repeated opener cannot be waved through' ? 0 : 1,
        'at most one editorial call; deterministic failures spend no reviewer inference');
      if (result) assert.deepEqual(result.map((l: any) => l.text), clean.map(l => l.text));
    });
  });
}
test('Banter: no configured local reviewer means no acceptance', async () => {
  configure();
  await transport((_url, body) => response(body, 'emit', { lines: clean }), async () => assert.equal(await banter(), null));
});
test('Banter: deterministic gates preserve humor and reject labels, repeats, scene claims and long speech', () => {
  assert.deepEqual(banterViolations(clean, [host, guest]), []);
  for (const text of ['Ada: Hallo.', 'Die Sonne kommt gerade auf.', '[lacht] Genau.', 'x'.repeat(241)]) {
    assert.ok(banterViolations([{ ...clean[0], text }, ...clean.slice(1)], [host, guest]).length, text);
  }
  assert.ok(banterViolations([clean[0], clean[1], clean[1]], [host, guest]).includes('repeated line'));
});
test('Banter: writer and editor share the deadline; cancelled editor cannot accept', async () => {
  configure(true, 120);
  let aborted = false;
  await transport(async (url, body, signal) => {
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'fixture-review' }] });
    if (url.includes('review.invalid')) return new Promise<Response>((_resolve, reject) => {
      const stop = () => { aborted = true; reject(signal!.reason); };
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    return response(body, 'emit', { lines: clean });
  }, async () => {
    await assert.rejects(banter(), { name: 'LlmDeadlineError' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(aborted, true);
  });
});

function agent() {
  const seen = new Set<string>();
  return djAgent({ system: 'You select tracks. Prior speech is only context.',
    messages: [{ role: 'assistant', content: 'Hier kommt ein guter Song!' }, { role: 'user', content: 'Pick the next discovered track.' }],
    tools: { discover: tool({ description: 'Find eligible library tracks', inputSchema: z.object({}), execute: async () => { seen.add('real-123'); return [{ id: 'real-123', title: 'Pause', artist: 'Fixture Band' }]; } }) },
    schema: z.object({ id: z.string() }), validate: (o: any) => seen.has(o.id), kind: 'test.agentCompletion', timeoutMs: 5000,
  });
}
for (const terminal of ['emit', 'json', 'prose', 'invented'] as const) {
  test(`Agent: discovery then declined done/recovery, terminal ${terminal}`, async () => {
    configure();
    let calls = 0;
    await transport((_url, body) => {
      calls++;
      const name = body.tools?.[0]?.function.name;
      if (name === 'discover') {
        return response(body, 'discover', {});
      }
      if (name === 'done') return response(body, null, 'Hier kommt ein wunderbarer Song!');
      assert.equal(name, 'emit');
      assert.match(body.messages.at(-1).content, /real-123/);
      return response(body, terminal === 'emit' ? 'emit' : null,
        terminal === 'prose' ? 'Hier kommt Musik!' : terminal === 'emit' ? { id: 'real-123' } : JSON.stringify({ id: terminal === 'invented' ? 'fake-999' : 'real-123' }));
    }, async () => {
      if (terminal === 'emit' || terminal === 'json') {
        const result = await agent();
        assert.deepEqual(result.object, { id: 'real-123' });
        assert.equal(result.toolCalls[0].name, 'discover');
        assert.equal(result.steps, 4);
      } else {
        await assert.rejects(agent(), (err: any) => {
          const diagnostics = failureDiagnostics(err) as any;
          assert.equal(diagnostics.toolCalls[0].name, 'discover');
          assert.equal(diagnostics.usage.total, 60, 'all four responses are counted');
          return terminal === 'prose' ? /did not call/.test(err.message) : /caller validation/.test(err.message);
        });
      }
      assert.equal(calls, 4, 'discovery, done, recovery, terminal; no extra retry');
    });
  });
}
test('Agent: a made-up done ID cannot bypass caller validation', async () => {
  configure();
  await transport((_url, body) => body.tools[0].function.name === 'discover' ? response(body, 'discover', {}) : response(body, 'done', { id: 'fake' }),
    async () => assert.rejects(agent(), /caller validation/));
});

test('Agent: a recovery transport failure retains completed discovery and usage', async () => {
  configure();
  let calls = 0;
  await transport((_url, body) => {
    calls++;
    if (calls === 1) return response(body, 'discover', {});
    if (calls === 2) return response(body, null, 'Hier kommt Musik!');
    return json({ error: { message: 'Synthetic auth refusal' } }, 401);
  }, async () => {
    await assert.rejects(agent(), (err: any) => {
      const diagnostics = failureDiagnostics(err) as any;
      assert.equal(diagnostics.toolCalls[0].name, 'discover');
      assert.equal(diagnostics.usage.total, 30);
      return err.statusCode === 401;
    });
    assert.equal(calls, 3);
  });
});

test('Agent: an explicitly classified chat can complete without a track', async () => {
  configure();
  await transport((_url, body) => response(body, body.tools[0].function.name === 'discover' ? 'discover' : 'done',
    body.tools[0].function.name === 'discover' ? {} : { kind: 'chat', id: null }), async () => {
    const out = await djAgent({ system: 'Classify the greeting.', messages: [{ role: 'user', content: 'Hallo!' }],
      tools: { discover: tool({ inputSchema: z.object({}), execute: async () => [] }) },
      schema: z.object({ kind: z.literal('chat'), id: z.null() }), validate: (obj: any) => obj.kind === 'chat' && obj.id === null });
    assert.deepEqual(out.object, { kind: 'chat', id: null });
  });
});

test('Agent: plausible terminal JSON without any discovery is rejected', async () => {
  configure();
  await transport((_url, body) => response(body, null, body.tools[0].function.name === 'emit' ? '{"id":"real-123"}' : 'Ein guter Song!'),
    async () => assert.rejects(agent(), /caller validation/));
});

test('Agent: cancelled terminal call cannot be salvaged or retried', async () => {
  configure(false, 120);
  let calls = 0;
  await transport((_url, body, signal) => {
    calls++;
    if (body.tools[0].function.name === 'discover') return response(body, 'discover', {});
    if (body.tools[0].function.name === 'done') return response(body, null, 'Musik!');
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal!.reason);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  }, async () => {
    // A smaller enclosing operation, as used by multi-part caller workflows.
    const { withinOperation } = await import('../src/llm/internal/core/operation.js');
    await assert.rejects(withinOperation(120, agent), { name: 'LlmDeadlineError' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 4);
  });
});
