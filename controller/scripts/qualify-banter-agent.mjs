// Manual, bounded local-model qualification. Never discovered by npm test.
// Use an isolated copy inside the Raspy controller's /tmp, not /app source.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
if (process.env.SUBWAVE_LOCAL_AI_QUALIFICATION !== '1') throw Error('Explicit SUBWAVE_LOCAL_AI_QUALIFICATION=1 opt-in required; this run consumes notebook GPU capacity');
if (!root.startsWith('/tmp/subwave-banter-agent-20261011/') || !root.endsWith('/controller')) throw Error('Isolated source root required');
const target = 'http://192.168.68.55:11434';
const model = 'qwen3.5:9b';
const phase = process.env.QUALIFY_PHASE || 'all';
if (!['all', 'banter', 'agent'].includes(phase)) throw Error('Unknown phase');
const originalFetch = globalThis.fetch;
const ps = await originalFetch(target + '/api/ps', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
if (!ps.models?.some(m => m.name === model && m.context_length === 8192)) throw Error('Warm 8192-context Qwen required');
for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASS|STATE_DIR|DEBUG/i.test(key)) delete process.env[key];
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-banter-agent-state-'));
const traces = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (url.origin === 'https://synthetic-primary.invalid') {
    traces.push({ target: 'synthetic-primary', status: 424 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 6000);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    return new Response(JSON.stringify({ error: { code: 'upstream_total_budget_exhausted', message: 'Synthetic primary failure' } }), { status: 424, headers: { 'content-type': 'application/json' } });
  }
  if (url.origin !== target || !['/api/tags', '/api/chat'].includes(url.pathname)) throw Error('Network target rejected');
  if (body.model && body.model !== model) throw Error('Unexpected model');
  const row = { target: 'local-qwen', path: url.pathname, tools: body.tools?.map(t => t.function.name), numCtx: body.options?.num_ctx };
  traces.push(row);
  const response = await originalFetch(input, init);
  row.status = response.status;
  if (url.pathname === '/api/chat') {
    const data = await response.clone().json();
    row.inference = Object.fromEntries(['total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration', 'prompt_eval_count', 'eval_count'].map(k => [k, data[k]]));
  }
  return response;
};
const { getDefaults, setCache } = await import('../src/settings/store.ts');
const { generateBanter } = await import('../src/llm/internal/prompts/banter.ts');
const { djAgent } = await import('../src/llm/internal/strategy/agent.ts');
const { pickSystem, pickSchema } = await import('../src/broadcast/dj-agent/schemas.ts');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.ts');
const { z } = await import('zod');
const { tool } = await import('ai');
const defaults = getDefaults();
setCache({ ...defaults, llm: { ...defaults.llm, keys: {}, provider: 'openai-compatible', model: 'synthetic-primary',
  baseUrl: 'https://synthetic-primary.invalid/v1', headers: {}, reasoning: false, agentTimeoutMs: 45000,
  fallback: { enabled: true, provider: 'ollama', model, ollamaUrl: target, headers: {}, reasoning: false, toolChoice: 'required', numCtx: 8192, repeatPenalty: 1.15, discoverySteps: 1 },
} });
const cast = [
  { id: 'marlowe', name: 'Marlowe', language: 'German', soul: 'Warm, entspannt. Konkrete Alltagsbeobachtungen.' },
  { id: 'hale', name: 'Hale', language: 'German', soul: 'Trockener Humor. Kurz, nie gemein.' },
  { id: 'wren', name: 'Wren', language: 'German', soul: 'Neugierig, verspielt, keine erzwungenen Witze.' },
];
const hashes = Object.fromEntries(['llm/internal/prompts/banter.ts', 'llm/internal/prompts/banter-quality.ts', 'llm/internal/strategy/agent.ts', 'llm/internal/strategy/object-via-tool.ts'].map(p => [p, createHash('sha256').update(readFileSync(join(root, 'src', p))).digest('hex')]));
const results = [];
for (const fixture of (phase === 'agent' ? [] : [
  { name: 'Sunday morning', show: 'Ruhiger Sonntagmorgen', title: 'Lovely Day', artist: 'Bill Withers', recap: 'Aufräumen und Tanzen wurden bereits besprochen.' },
  { name: 'Late evening', show: 'Später Abend', title: 'The Look of Love', artist: 'Diana Krall', recap: 'Kaffee und ein langer Arbeitstag wurden bereits besprochen.' },
  { name: 'Music title is not weather', show: 'Entspannter Nachmittag', title: 'Here Comes the Sun', artist: 'The Beatles', recap: 'Keine Wetterdaten liegen vor. Das Wetter wurde nicht besprochen.' },
])) {
  recentCalls.length = 0; traces.length = 0;
  const started = performance.now();
  let lines = null, error;
  try { lines = await generateBanter({ host: cast[0], guests: cast.slice(1), show: { name: fixture.show }, current: { title: fixture.title, artist: fixture.artist }, recap: fixture.recap, recentOpeners: ['Also ehrlich', 'Ich finde'] }); }
  catch (e) { error = { name: e.name, message: e.message }; }
  const row = { kind: 'banter', fixture: fixture.name, wallMs: Math.round(performance.now() - started), lines: lines?.map(l => ({ speaker: l.persona.id, text: l.text })), error,
    trace: [...traces], calls: recentCalls.map(({ kind, ok, ms, via, response, responseText }) => ({ kind, ok, ms, via, response, responseText })) };
  results.push(row); console.log(JSON.stringify(row));
  await new Promise(resolve => setTimeout(resolve, 1000));
}
for (let i = 0; i < (phase === 'banter' ? 0 : 3); i++) {
  recentCalls.length = 0; traces.length = 0;
  const seen = new Set();
  const started = performance.now();
  let output, error;
  try { output = await djAgent({ system: pickSystem(), schema: pickSchema(), kind: 'qualification.pick', timeoutMs: 45000, providerDiscoveryBudget: true,
    messages: [{ role: 'assistant', content: 'Ein wenig Schwung darf bleiben. Hier kommt der nächste Song!' }, { role: 'user', content: 'Pick the next track after the current track. Use discovery and choose one eligible result. No speech is requested.' }],
    tools: { findTracks: tool({ description: 'Discover eligible candidates for the next song', inputSchema: z.object({ query: z.string() }), execute: async () => {
      const candidates = [{ id: 'fixture-a', title: 'A Quiet Turn', artist: 'Test Ensemble', mood: 'relaxed' }, { id: 'fixture-b', title: 'Side Street', artist: 'Example Quartet', mood: 'warm' }];
      candidates.forEach(t => seen.add(t.id)); return candidates;
    } }) }, validate: obj => seen.has(obj.id),
  }); } catch (e) { error = { name: e.name, message: e.message }; }
  const row = { kind: 'agent', fixture: i + 1, wallMs: Math.round(performance.now() - started), output, error, trace: [...traces], calls: recentCalls.map(({ kind, ok, ms, via, response, responseText }) => ({ kind, ok, ms, via, response, responseText })) };
  results.push(row); console.log(JSON.stringify(row));
  await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ summary: true, at: new Date().toISOString(), sourceHashes: hashes, model, context: 8192, results: results.length,
  phase, acceptedBanter: results.filter(r => r.kind === 'banter' && r.lines?.length).length, acceptedAgents: results.filter(r => r.kind === 'agent' && r.output).length,
  withinDeadline: results.every(r => r.wallMs < 45500), isolatedState: true, noBroadcast: true }));
setCache(null);
process.exitCode = results.some(r => r.error || r.wallMs >= 45500
  || (r.kind === 'banter' ? !r.lines?.length : !r.output)) ? 1 : 0;
