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
  germanHardViolations,
  germanQualityReviewPrompt,
  germanRadioSystem,
  germanStationIdPrompt,
  germanTimeAnchor,
  isGermanPersona,
  localOllamaReviewLeg,
  parseGermanQualityDecision,
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

test('reviewer follows the local Ollama role and otherwise fails closed', () => {
  assert.equal(localOllamaReviewLeg({
    provider: 'openai-compatible',
    fallback: { enabled: true, provider: 'ollama' },
  }), 'fallback');
  assert.equal(localOllamaReviewLeg({
    provider: 'ollama',
    fallback: { enabled: true, provider: 'openai-compatible' },
  }), 'primary');
  assert.equal(localOllamaReviewLeg({
    provider: 'openai-compatible',
    fallback: { enabled: true, provider: 'openai-compatible' },
  }), null);
});

test('German clock semantics anchor 10:00 as exactly ten, not before ten', () => {
  assert.equal(germanDaypartForHour(10), 'Vormittag');
  assert.equal(germanTimeAnchor(context), 'gerade zehn Uhr (vormittag)');
  const prompt = germanHourlyPrompt({ context });
  assert.match(prompt, /Exakte lokale Uhrzeit: 10:00 Uhr/);
  assert.match(prompt, /gerade zehn Uhr \(vormittag\)/);
  assert.doesNotMatch(prompt, /ten in the morning|Local time:|Task:/);
});

test('German clock anchors stay natural at noon and midnight edges', () => {
  assert.equal(germanTimeAnchor({ clock: { hhmm: '00:00' } }), 'gerade Mitternacht (nacht)');
  assert.equal(germanTimeAnchor({ clock: { hhmm: '12:00' } }), 'gerade Mittag (mittag)');
  assert.equal(germanTimeAnchor({ clock: { hhmm: '23:30' } }), 'etwa halb zwölf (nacht)');
  assert.equal(germanTimeAnchor({ clock: { hhmm: '23:45' } }), 'etwa Viertel vor Mitternacht (nacht)');
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

test('hard gates catch the observed production regressions', () => {
  assert.deepEqual(
    germanHardViolations({
      kind: 'hourly',
      text: 'Zehn vor zehn morgens.',
      context,
    }),
    ['top-of-hour-offset'],
  );

  assert.deepEqual(
    germanHardViolations({
      kind: 'link',
      text: 'Am Donnerstag Abend läuft Black Dog von Led Zeppeling, offiziell 1999 veröffentlicht.',
      context,
      current: {
        title: 'Black Dog',
        artist: 'Led Zeppelin',
        album: 'Best Hits',
        year: 1999,
      },
      clockIsAirTime: false,
    }).sort(),
    [
      'artist-name-missing-or-changed',
      'catalogue-year-upgraded',
      'daypart-without-airtime',
    ].sort(),
  );

  assert.deepEqual(
    germanHardViolations({
      kind: 'link',
      text: 'Black Dog von Led Zeppelin klingt genau wie er gemeint war.',
      context,
      current: {
        title: 'Black Dog',
        artist: 'Led Zeppelin',
        album: 'Best Hits',
        year: 1999,
      },
      clockIsAirTime: false,
    }),
    ['creator-intent-invented'],
  );
});

test('hard gates reject unsupported music facts but preserve subjective reaction', () => {
  const base = {
    kind: 'link' as const,
    context,
    current: {
      title: 'Black Dog',
      artist: 'Led Zeppelin',
      album: 'Best Hits',
      year: 1999,
    },
    clockIsAirTime: false,
  };

  assert.ok(
    germanHardViolations({
      ...base,
      text: 'Black Dog von Led Zeppelin – die Gitarrenlinie und der Rhythmus tragen klar Blues und Rock n Roll.',
    }).includes('unsupported-music-fact'),
  );

  assert.ok(
    germanHardViolations({
      ...base,
      text: 'Black Dog von Led Zeppelin ist ein alter Klassiker mit zeitlosem Sound.',
    }).includes('unsupported-music-fact'),
  );

  assert.deepEqual(
    germanHardViolations({
      ...base,
      text: 'Black Dog von Led Zeppelin wirkt auf mich heute schwer und hat ordentlich Energie.',
    }),
    [],
  );
});

test('station ID hard gate rejects invented concrete scenery but not abstract style', () => {
  assert.ok(
    germanHardViolations({
      kind: 'station-id',
      text: 'SUB/WAVE serviert klare Musik in der Vormittagssonne.',
      context,
    }).includes('invented-scenery'),
  );

  assert.ok(
    germanHardViolations({
      kind: 'station-id',
      text: 'SUB/WAVE begleitet Sie von der Couch durch den Vormittag.',
      context,
    }).includes('invented-scenery'),
  );

  assert.deepEqual(
    germanHardViolations({
      kind: 'station-id',
      text: 'SUB/WAVE aus Zofingen – klein, eigenwillig und heute ziemlich wach.',
      context,
    }),
    [],
  );
});

test('station scenery detector handles German linking-s compounds', () => {
  for (const phrase of [
    'Morgensonne',
    'Vormittagssonne',
    'Mittagssonne',
    'Nachmittagssonne',
    'Abendsonne',
  ]) {
    assert.ok(
      germanHardViolations({
        kind: 'station-id',
        text: `SUB/WAVE aus Zofingen in der ${phrase}.`,
        context,
      }).includes('invented-scenery'),
      phrase,
    );
  }
});

test('grounded artist matching uses exact token boundaries', () => {
  const base = {
    kind: 'link' as const,
    context,
    current: {
      title: 'Black Dog',
      artist: 'Led Zeppelin',
      album: 'Best Hits',
      year: 1999,
    },
    clockIsAirTime: false,
  };

  assert.deepEqual(
    germanHardViolations({
      ...base,
      text: 'Black Dog von Led Zeppelin läuft jetzt.',
    }),
    [],
  );

  assert.ok(
    germanHardViolations({
      ...base,
      text: 'Black Dog von Led Zeppeling läuft jetzt.',
    }).includes('artist-name-missing-or-changed'),
  );

  assert.ok(
    germanHardViolations({
      ...base,
      text: 'Black Dog von Led Zeppelins läuft jetzt.',
    }).includes('artist-name-missing-or-changed'),
  );
});

test('top-of-hour hard gate does not reject unrelated German prepositions', () => {
  assert.deepEqual(
    germanHardViolations({
      kind: 'hourly',
      text: 'Es ist genau zehn Uhr, und nach diesem Satz geht die Musik weiter.',
      context,
    }),
    [],
  );
});

test('compact reviewer decision format parses without structured-output tooling', () => {
  assert.deepEqual(parseGermanQualityDecision('PASS'), {
    verdict: 'pass',
    text: '',
  });
  assert.deepEqual(parseGermanQualityDecision('PASS.'), {
    verdict: 'pass',
    text: '',
  });
  assert.deepEqual(parseGermanQualityDecision('DROP'), {
    verdict: 'drop',
    text: '',
  });
  assert.deepEqual(parseGermanQualityDecision('DROP.'), {
    verdict: 'drop',
    text: '',
  });
  assert.deepEqual(parseGermanQualityDecision('REWRITE\nHier ist SUB/WAVE aus Zofingen.'), {
    verdict: 'rewrite',
    text: 'Hier ist SUB/WAVE aus Zofingen.',
  });
  assert.deepEqual(parseGermanQualityDecision('REWRITE: Hier ist SUB/WAVE aus Zofingen.'), {
    verdict: 'rewrite',
    text: 'Hier ist SUB/WAVE aus Zofingen.',
  });
  assert.deepEqual(parseGermanQualityDecision('irgendetwas anderes'), {
    verdict: 'drop',
    text: '',
  });
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
