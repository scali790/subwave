import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('SDK transport: NIM 424 preserves cause, offline backup cools down, deadline aborts transport', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-ai-llm-'));
  process.env.STATE_DIR = dir;
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ llm: {
    provider: 'openai-compatible', model: 'test-model', baseUrl: 'http://nim.test/v1', agentTimeoutMs: 200,
    fallback: { enabled: true, provider: 'ollama', model: 'qwen:9b', ollamaUrl: 'http://ollama.test' },
  } }));
  const original = globalThis.fetch;
  let mode = '424', tags = 0, generations = 0, aborts = 0;
  const ids: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target === 'http://ollama.test/api/tags') { tags++; throw new TypeError('fetch failed'); }
    if (target.startsWith('http://ollama.test')) { generations++; throw new Error('offline backup must never generate'); }
    assert.ok(target.startsWith('http://nim.test/v1/'));
    ids.push(new Headers(init?.headers).get('x-request-id')!);
    if (mode === 'slow') return new Promise<Response>((_, reject) => {
      const abort = () => { aborts++; reject(init?.signal?.reason); };
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    });
    if (mode === 'ok') return Response.json({ id: 'fake-completion', object: 'chat.completion', created: 1, model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Guten Abend.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } });
    return Response.json({ error: 'upstream failure', last_error: { error: 'upstream_timeout' },
      elapsed_seconds: 6, attempted_keys: 1 }, { status: 424 });
  }) as typeof fetch;
  try {
    const settings = await import('../src/settings.js');
    await settings.load();
    // Production settings clamp the operator range to >= 5s; shorten only
    // this in-memory synthetic test budget, after normal config loading.
    settings.get().llm.agentTimeoutMs = 200;
    const { djText } = await import('../src/llm/internal/strategy/text.js');
    const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');
    const args = { system: 'Test', prompt: 'Hello', kind: 'radio-reliability' };
    for (let i = 0; i < 2; i++) await assert.rejects(djText(args), { name: 'FallbackUnavailableError' });
    assert.equal(tags, 1);
    assert.equal(generations, 0);
    assert.equal(recentCalls.find(c => c.upstream?.httpStatus === 424)?.upstream.upstreamCode, 'upstream_timeout');
    assert.ok(ids.every(id => /^[a-f0-9-]{36}$/.test(id)));
    mode = 'ok';
    assert.equal(await djText(args), 'Guten Abend.');
    mode = 'slow';
    const started = performance.now();
    await assert.rejects(djText(args), { name: 'LlmDeadlineError' });
    assert.ok(performance.now() - started < 600);
    assert.equal(aborts, 1);
    assert.equal(tags, 1, 'no fallback after the total deadline');
    // The pinned German reviewer used to bypass ordinary primary/fallback
    // admission. Its unavailable host must now share this same cooldown.
    const { reviewGermanOnAirText } = await import('../src/llm/internal/prompts/german-on-air.js');
    const reviewed = await reviewGermanOnAirText({ kind: 'link', draft: 'Guten Abend.', context: {} });
    assert.equal(reviewed.verdict, 'drop');
    assert.match(reviewed.reason, /reviewer unavailable/);
    assert.equal(tags, 1);
    assert.equal(generations, 0);
  } finally {
    globalThis.fetch = original;
    // Observability writes are asynchronous and best effort.
    await new Promise(resolve => setTimeout(resolve, 30));
    rmSync(dir, { recursive: true, force: true });
  }
});
