import assert from 'node:assert/strict';

import * as settings from '../src/settings.js';
import { setCache } from '../src/settings/store.js';
import { getFullContext } from '../src/context.js';
import {
  generateHourlyTime,
  generateLink,
  generateStationId,
} from '../src/llm/internal/prompts/scripts.js';
import { reviewGermanOnAirText } from '../src/llm/internal/prompts/german-on-air.js';
import { recentCalls } from '../src/llm/dj.js';

function fail(message: string): never {
  throw new Error(message);
}

function assertGermanPersona(persona: any) {
  assert.equal(
    String(persona?.language || '').toLowerCase(),
    'german',
    'Family Radio acceptance requires a German persona',
  );
}

function assertFinalOutput(row: { kind: string; text: string }) {
  const text = String(row.text || '');
  const lc = text.toLowerCase();

  if (row.kind === 'hourly' && text) {
    assert.match(text, /\bzehn\b/i, 'hourly output lost required hour');
    assert.doesNotMatch(
      text,
      /\b(vor zehn|nach neun|halb zehn|viertel vor zehn)\b/i,
      'hourly output changed 10:00 semantics',
    );
  }

  if (row.kind === 'station-id' && text) {
    assert.ok(lc.includes('sub/wave'), 'station ID lost SUB/WAVE identity');
  }

  if (row.kind === 'link' && text) {
    assert.doesNotMatch(
      text,
      /\b(vormittag|morgen|morgens|mittag|nachmittag|abend|abends|nacht|nachts)\b/i,
      'link invented a daypart without verified air-time',
    );
    assert.doesNotMatch(
      text,
      /led zeppeling|led zeppelines/i,
      'link mutated artist name',
    );
    assert.doesNotMatch(
      text,
      /offiziell .*1999.*veröffentlicht|1999 offiziell veröffentlicht/i,
      'link upgraded catalogue year to release fact',
    );
  }
}

await settings.load();

const loaded = settings.get();
const fb = loaded.llm?.fallback;

if (!fb?.enabled || fb.provider !== 'ollama' || !String(fb.model || '').trim()) {
  fail('Expected configured Ollama/Qwen fallback in isolated Family Radio settings');
}

// Process-local only: promote Qwen/Ollama to primary for this acceptance
// process. setCache() never persists settings.json.
setCache({
  ...loaded,
  llm: {
    ...loaded.llm,
    ...fb,
    provider: 'ollama',
    fallback: {
      ...loaded.llm.fallback,
      enabled: false,
    },
  },
});

const persona = settings.getEffectivePersona();
assertGermanPersona(persona);

console.log('=== FAMILY RADIO QUALITY V1 RUNTIME ACCEPTANCE ===');
console.log(`TEST_MODEL=${settings.get().llm.provider}:${settings.get().llm.model}`);
console.log(`TEST_PERSONA=${persona?.name}`);
console.log(`TEST_LANGUAGE=${persona?.language}`);
console.log('NO_TTS=true');
console.log('NO_QUEUE=true');
console.log('NO_STREAM_MUTATION=true');
console.log('PRODUCTION_STATE_MUTATION=false');

const hourlyContext = await getFullContext(new Date('2026-10-01T08:00:00Z'));
const identContext = await getFullContext(new Date('2026-10-01T08:45:00Z'));
const linkContext = await getFullContext(new Date('2026-10-01T08:52:00Z'));

const track = {
  title: 'Black Dog',
  artist: 'Led Zeppelin',
  album: 'Best Hits',
  year: 1999,
};

const outputs: Array<{ kind: string; iteration: number; text: string }> = [];

for (let i = 1; i <= 3; i++) {
  const text = await generateHourlyTime({ context: hourlyContext, persona });
  const row = { kind: 'hourly', iteration: i, text: String(text || '') };
  assertFinalOutput(row);
  outputs.push(row);
  console.log(`FINAL hourly #${i} :: ${row.text || '[DROPPED]'}`);
}

for (let i = 1; i <= 3; i++) {
  const text = await generateStationId({ context: identContext, persona });
  const row = { kind: 'station-id', iteration: i, text: String(text || '') };
  assertFinalOutput(row);
  outputs.push(row);
  console.log(`FINAL ident #${i} :: ${row.text || '[DROPPED]'}`);
}

for (let i = 1; i <= 3; i++) {
  const text = await generateLink({
    current: track,
    context: linkContext,
    clockIsAirTime: false,
    persona,
    recap: null,
    recentOpeners: null,
    lastLink: null,
    currentIsOnAir: true,
  });
  const row = { kind: 'link', iteration: i, text: String(text || '') };
  assertFinalOutput(row);
  outputs.push(row);
  console.log(`FINAL link #${i} :: ${row.text || '[DROPPED]'}`);
}

console.log('');
console.log('=== OBSERVED REGRESSION GATE ===');

const badHourly = await reviewGermanOnAirText({
  kind: 'hourly',
  draft: 'Zehn vor zehn morgens.',
  context: hourlyContext,
});
console.log('REGRESSION hourly_wrong_time :: ' + JSON.stringify(badHourly));
assert.notEqual(badHourly.verdict, 'pass', 'wrong 10:00 time was passed');

const badIdent = await reviewGermanOnAirText({
  kind: 'station-id',
  draft: 'still im stillen der brücke, frühes wien.',
  context: identContext,
});
console.log('REGRESSION incoherent_ident :: ' + JSON.stringify(badIdent));
assert.notEqual(badIdent.verdict, 'pass', 'incoherent ident was passed');

const badLink = await reviewGermanOnAirText({
  kind: 'link',
  draft: 'Am Donnerstag Abend läuft Black Dog von Led Zeppeling, offiziell 1999 veröffentlicht.',
  context: linkContext,
  current: track,
  clockIsAirTime: false,
});
console.log('REGRESSION grounded_link :: ' + JSON.stringify(badLink));
assert.notEqual(badLink.verdict, 'pass', 'fact-drifting link was passed');

const qualityCalls = recentCalls
  .filter((c: any) => String(c.kind || '').startsWith('onAirQuality.'))
  .map((c: any) => ({
    kind: c.kind,
    model: c.model,
    via: c.via,
    ms: c.ms,
    ok: c.ok,
    response: c.response,
  }));

assert.ok(qualityCalls.length >= 12, 'expected reviewer calls for 9 outputs + 3 regressions');

console.log('');
console.log('=== FINAL OUTPUTS ===');
console.log(JSON.stringify(outputs, null, 2));

console.log('');
console.log('=== QUALITY REVIEW CALLS ===');
console.log(JSON.stringify(qualityCalls, null, 2));

console.log('');
console.log('FAMILY_RADIO_QUALITY_V1_NO_AIR=PASS');
