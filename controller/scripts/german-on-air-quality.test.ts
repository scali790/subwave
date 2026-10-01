import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-german-on-air-'));

const settings = await import('../src/settings.js');
const {
  germanDaypartForHour,
  germanHourlyPrompt,
  germanLinkPrompt,
  germanQualityReviewPrompt,
  germanRadioSystem,
  germanStationIdPrompt,
  germanTimeAnchor,
  isGermanPersona,
} = await import('../src/llm/internal/prompts/german-on-air.js');

await settings.load();
const current = settings.get();
const personas = current.personas.map((p: any) => ({
  ...p,
  language: 'German',
}));
await settings.update({
  station: 'SUB/WAVE',
  weather: {
    ...current.weather,
    locationName: 'Zofingen',
    onAirLocation: 'Zofingen, Schweiz',
  },
  personas,
  djHouseRules: 'FAMILY RADIO DE-CH: Natürliches Hochdeutsch; keine erfundenen Tagesabläufe.',
});

const persona = settings.getEffectivePersona();

const context = {
  date: {
    dayLabel: 'Thursday',
    dayOfMonth: 1,
    monthLabel: 'October',
    season: 'autumn',
  },
  clock: {
    hhmm: '10:00',
    display: '10:00',
  },
  activeShow: {
    name: 'Daytime',
    topic: 'Werktags-Daytime: klarer Musikfokus. Keine künstlichen Tagesgeschichten.',
  },
};

test('German persona recognition is explicit and narrow', () => {
  assert.equal(isGermanPersona(persona), true);
  assert.equal(isGermanPersona({ language: 'English' }), false);
  assert.equal(isGermanPersona({}), false);
});

test('German clock semantics anchor 10:00 as exactly ten, not before ten', () => {
  assert.equal(germanDaypartForHour(10), 'Vormittag');
  assert.equal(germanTimeAnchor(context), 'gerade zehn Uhr (vormittag)');
  const prompt = germanHourlyPrompt({ context });
  assert.match(prompt, /Exakte lokale Uhrzeit: 10:00 Uhr/);
  assert.match(prompt, /gerade zehn Uhr \(vormittag\)/);
  assert.doesNotMatch(prompt, /ten in the morning|Local time:|Task:/);
});

test('German radio system stays German-native and preserves house rules', () => {
  const system = germanRadioSystem(persona);
  assert.match(system, /ausschliesslich natürliches Hochdeutsch/);
  assert.match(system, /Wortfragmenten oder surrealem Wortsalat/);
  assert.match(system, /FAMILY RADIO DE-CH/);
  assert.doesNotMatch(system, /late-night BBC|Hard rules:|You are /);
});

test('German station ident keeps creativity but forbids invented scenery', () => {
  const prompt = germanStationIdPrompt({ context, persona });
  assert.match(prompt, /Charmant, eigenwillig, humorvoll oder leicht poetisch/);
  assert.match(prompt, /normaler deutscher Satz verständlich/);
  assert.match(prompt, /Erfinde keine Raum-, Strassen-, Brücken-, Stadt-, Wetter-/);
  assert.match(prompt, /Standort: Zofingen, Schweiz/);
  assert.doesNotMatch(prompt, /one-room intimacy|Tone for this segment|Task:/);
});

test('German link treats catalogue year as non-authoritative release metadata', () => {
  const prompt = germanLinkPrompt({
    current: {
      title: 'Black Dog',
      artist: 'Led Zeppelin',
      album: 'Best Hits',
      year: 1999,
    },
    context,
  });
  assert.match(prompt, /Jetzt läuft: "Black Dog" von Led Zeppelin/);
  assert.match(prompt, /Katalog-Albumangabe: "Best Hits"/);
  assert.match(prompt, /Katalog-Jahresangabe: 1999/);
  assert.match(prompt, /kein Beleg für die Original- oder Erstveröffentlichung/);
  assert.match(prompt, /Schreibe Künstler- und Songnamen exakt wie oben/);
  assert.doesNotMatch(prompt, /Verified Facts:|Track on air:|Rules:/);
});

test('quality review is an editorial gate, not a style flattener', () => {
  const draft = 'SUB/WAVE aus Zofingen – klein, eigenwillig und heute ziemlich wach.';
  const prompt = germanQualityReviewPrompt({
    kind: 'station-id',
    draft,
    context,
  });
  assert.ok(prompt.includes(draft));
  assert.match(prompt, /Kreativität, Humor, subjektive Eindrücke.*ausdrücklich bestehen lassen/);
  assert.match(prompt, /Stil nicht glätten/);
  assert.match(prompt, /Wortsalat/);
  assert.match(prompt, /erfundener Ort/);
});
