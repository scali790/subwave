// German on-air prompt + editorial quality layer for Family Radio.
//
// Purpose: keep the DJ creative while refusing incoherent or fact-drifting copy
// before it reaches TTS. This is deliberately scoped to German personas so the
// upstream/default prompt behaviour remains unchanged for other stations.
//
// The writer and reviewer are separate jobs:
//   1. the writer gets one compact, German-native task prompt;
//   2. the reviewer is pinned to the configured fallback leg (Family Radio:
//      local Qwen) and may PASS, safely REWRITE from supplied facts, or DROP.
//
// Reviewer failure is fail-silent. Music continues; bad speech is cheaper than
// a guessed repair.

import * as settings from '../../../settings.js';
import { djText } from '../strategy/text.js';
import { trackEraYear } from '../../../music/show-filter.js';
import { stripRecapSpokenTags, stripSpokenTags } from './recent-speech.js';
import { logEvent } from '../../../observability/events.js';

const WEEKDAYS: Record<string, string> = {
  Sunday: 'Sonntag', Monday: 'Montag', Tuesday: 'Dienstag',
  Wednesday: 'Mittwoch', Thursday: 'Donnerstag', Friday: 'Freitag',
  Saturday: 'Samstag',
};

const MONTHS: Record<string, string> = {
  January: 'Januar', February: 'Februar', March: 'März', April: 'April',
  May: 'Mai', June: 'Juni', July: 'Juli', August: 'August',
  September: 'September', October: 'Oktober', November: 'November', December: 'Dezember',
};

const HOUR_WORDS = [
  'zwölf', 'eins', 'zwei', 'drei', 'vier', 'fünf',
  'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf',
];

export function isGermanPersona(persona: any): boolean {
  return String(persona?.language || '').trim().toLowerCase() === 'german';
}

function clockParts(context: any): { hour: number; minute: number } | null {
  const raw = String(context?.clock?.hhmm || context?.clock?.display || '').trim();
  const m = raw.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function bareHourWord(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return HOUR_WORDS[h % 12];
}

function landmarkHourPhrase(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return 'Mitternacht';
  if (h === 12) return 'Mittag';
  return `${bareHourWord(h)} Uhr`;
}

export function germanDaypartForHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h < 6) return 'Nacht';
  if (h < 12) return 'Vormittag';
  if (h < 14) return 'Mittag';
  if (h < 18) return 'Nachmittag';
  if (h < 22) return 'Abend';
  return 'Nacht';
}

// Semantic anchor, not final copy. The model may phrase it naturally but may
// not change its meaning.
export function germanTimeAnchor(context: any): string | null {
  const p = clockParts(context);
  if (!p) return null;
  const { hour, minute } = p;
  const daypart = germanDaypartForHour(hour).toLowerCase();

  if (minute === 0) return `gerade ${landmarkHourPhrase(hour)} (${daypart})`;
  if (minute <= 14) return `kurz nach ${landmarkHourPhrase(hour)} (${daypart})`;
  if (minute <= 24) return `etwa Viertel nach ${landmarkHourPhrase(hour)} (${daypart})`;
  if (minute <= 39) return `etwa halb ${bareHourWord(hour + 1)} (${daypart})`;
  if (minute <= 49) return `etwa Viertel vor ${landmarkHourPhrase(hour + 1)} (${daypart})`;
  return `kurz vor ${landmarkHourPhrase(hour + 1)} (${daypart})`;
}

function germanDate(context: any): string | null {
  const d = context?.date;
  if (!d) return null;
  const day = WEEKDAYS[String(d.dayLabel || '')] || String(d.dayLabel || '').trim();
  const month = MONTHS[String(d.monthLabel || '')] || String(d.monthLabel || '').trim();
  const dom = Number(d.dayOfMonth);
  if (!day && !month) return null;
  return [day, Number.isFinite(dom) && dom > 0 ? `${dom}.` : '', month].filter(Boolean).join(' ');
}

function verifiedMomentLines(
  context: any,
  {
    includeExactClock = false,
    includeDaypart = true,
  }: { includeExactClock?: boolean; includeDaypart?: boolean } = {},
): string[] {
  const out: string[] = [];
  const date = germanDate(context);
  if (date) out.push(`- Datum: ${date}.`);
  const p = clockParts(context);
  if (p) {
    if (includeDaypart) out.push(`- Tageszeit: ${germanDaypartForHour(p.hour)}.`);
    if (includeExactClock) {
      out.push(`- Exakte lokale Uhrzeit: ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} Uhr.`);
    }
  }
  const show = String(context?.activeShow?.name || '').trim();
  if (show) out.push(`- Aktuelle Sendung: "${show}".`);
  const topic = String(context?.activeShow?.topic || '').trim();
  if (topic) out.push(`- Sendungsbriefing: ${topic}`);
  return out;
}

function antiRepeat(recap: any, recentOpeners: any): string {
  const blocks: string[] = [];
  if (recap) {
    blocks.push('Kürzlich gesendete Moderationen – weder Formulierung noch Thema wiederholen:\n'
      + stripRecapSpokenTags(String(recap)));
  }
  if (Array.isArray(recentOpeners) && recentOpeners.length) {
    blocks.push('Nicht mit diesen kürzlich verwendeten Anfängen beginnen:\n'
      + recentOpeners.slice(0, 6).map((x: string) => `- ${stripSpokenTags(x)}`).join('\n'));
  }
  return blocks.length ? '\n\n' + blocks.join('\n\n') : '';
}

export function germanRadioSystem(persona: any): string {
  const s = settings.get();
  const name = String(persona?.name || 'der Moderator').trim();
  const station = String(s.station || 'SUB/WAVE').trim();
  const location = String(settings.resolveOnAirLocation(s) || '').trim();
  const house = String(s.djHouseRules || '').trim();
  return [
    `Du bist ${name}, der Moderator von ${station}${location ? `, einem privaten Radiosender aus ${location}` : ''}.`,
    '',
    'Stil:',
    '- warm, leicht zurückhaltend und konkret;',
    '- gelegentlich trockener Humor;',
    '- Persönlichkeit und kleine Bilder sind willkommen, solange die Aussage verständlich bleibt;',
    '- Musik und natürlicher Radioton stehen vor Showeffekten.',
    '',
    'Grundregeln:',
    '- Sprich und schreibe ausschliesslich natürliches Hochdeutsch.',
    '- Gib nur Wörter aus, die tatsächlich gesprochen werden sollen.',
    '- Formuliere vollständige, verständliche Sätze statt Wortfragmenten oder surrealem Wortsalat.',
    '- Erfinde keine überprüfbaren Fakten, Orte, Ereignisse, Personen oder konkrete Szenerien.',
    '- Kreative subjektive Reaktionen sind erlaubt, wenn sie klar als Eindruck und nicht als Fakt formuliert sind.',
    '- Künstlernamen, Songtitel, Sender- und Ortsnamen aus den Fakten müssen exakt geschrieben werden.',
    house ? `\nVerbindliche Senderregeln:\n${house}` : '',
  ].filter(Boolean).join('\n');
}

export function germanHourlyPrompt({ context, recap = null, recentOpeners = null }: any): string {
  const anchor = germanTimeAnchor(context);
  const lines = [
    'Verifizierter Kontext:',
    ...verifiedMomentLines(context, { includeExactClock: true }),
    '',
    'Aufgabe:',
    'Formuliere eine kurze natürliche Zeitansage fürs Radio in genau einem vollständigen Satz.',
    anchor
      ? `Die korrekte zeitliche Bedeutung lautet: "${anchor}". Bewahre genau diese Bedeutung; sage niemals eine andere Uhrzeit.`
      : 'Es wurde keine verlässliche Uhrzeit geliefert. Nenne keine Uhrzeit.',
    'Eine kleine persönliche oder trockene Bemerkung ist erlaubt, aber erfinde keine Routine des Hörers (Arbeit, Kaffee, Schule, Pendeln usw.).',
  ];
  return lines.join('\n') + antiRepeat(recap, recentOpeners);
}

export function germanStationIdPrompt({ context, persona, recap = null, recentOpeners = null }: any): string {
  const s = settings.get();
  const station = String(s.station || 'SUB/WAVE').trim();
  const name = String(persona?.name || '').trim();
  const location = String(settings.resolveOnAirLocation(s) || '').trim();
  const lines = [
    'Verifizierter Kontext:',
    ...verifiedMomentLines(context),
    `- Sender: ${station}.`,
    ...(name ? [`- Moderator: ${name}.`] : []),
    ...(location ? [`- Standort: ${location}.`] : []),
    '',
    'Aufgabe:',
    'Formuliere eine kurze Station-ID in genau einem vollständigen Satz.',
    `${station} muss natürlich als Sender erkennbar sein.`,
    'Charmant, eigenwillig, humorvoll oder leicht poetisch ist ausdrücklich erlaubt.',
    'Die Aussage muss trotzdem als normaler deutscher Satz verständlich sein.',
    'Erfinde keine Raum-, Strassen-, Brücken-, Stadt-, Wetter- oder sonstige Szenerie.',
    'Wenn du einen Ort nennst, verwende nur den verifizierten Standort.',
    'Wenn du die Tageszeit erwähnst, verwende nur die oben genannte Tageszeit.',
  ];
  return lines.join('\n') + antiRepeat(recap, recentOpeners);
}

export function germanLinkPrompt({
  current,
  context,
  clockIsAirTime = false,
  recap = null,
  recentOpeners = null,
}: any): string {
  const title = String(current?.title || '').trim();
  const artist = String(current?.artist || '').trim();
  const album = String(current?.album || '').trim();
  const year = trackEraYear(current);
  const lines = [
    'Verifizierte Fakten:',
    ...verifiedMomentLines(context, { includeDaypart: clockIsAirTime }),
    ...(title ? [`- Jetzt läuft: "${title}"${artist ? ` von ${artist}` : ''}.`] : []),
    ...(album ? [`- Katalog-Albumangabe: "${album}".`] : []),
    ...(year ? [`- Katalog-Jahresangabe: ${year}. Diese Angabe ist kein Beleg für die Original- oder Erstveröffentlichung des Songs.`] : []),
    '',
    'Aufgabe:',
    'Formuliere eine kurze natürliche Moderation zum laufenden Titel, ein oder zwei vollständige Sätze.',
    'Eine subjektive Reaktion auf die Musik ist willkommen, solange sie als persönlicher Eindruck formuliert ist.',
    'Erfinde keine Instrumentierung, Produktion, Lyrics, Charts, Bedeutung, Reputation, Musikgeschichte oder Credits.',
    'Werte Katalogangaben nicht auf: aus einer Jahresangabe wird keine Behauptung über die offizielle oder ursprüngliche Veröffentlichung.',
    'Erfinde kein Wetter und keine lokale oder zeitliche Szenerie.',
    clockIsAirTime
      ? 'Wenn du Tag oder Tageszeit erwähnst, müssen sie exakt zum verifizierten Kontext passen.'
      : 'Für diesen Link wurde keine verlässliche Air-Time geliefert. Behaupte keine konkrete Uhrzeit oder Tageszeit.',
    'Schreibe Künstler- und Songnamen exakt wie oben.',
  ];
  return lines.join('\n') + antiRepeat(recap, recentOpeners);
}

const DAYPART_WORDS = /\b(vormittag|morgen|morgens|mittag|nachmittag|abend|abends|nacht|nachts)\b/i;

function normalizedPhrase(value: string): string {
  return String(value || '')
    .toLocaleLowerCase('de-CH')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsPhrase(text: string, phrase: string): boolean {
  const hay = normalizedPhrase(text);
  const needle = normalizedPhrase(phrase);
  return !!needle && hay.includes(needle);
}

export function germanHardViolations(args: {
  kind: 'hourly' | 'station-id' | 'link';
  text: string;
  context: any;
  current?: any;
  clockIsAirTime?: boolean;
}): string[] {
  const text = String(args.text || '').replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  if (!text) return ['empty'];

  if (args.kind === 'hourly') {
    const p = clockParts(args.context);
    if (p) {
      const expectedHour = bareHourWord(p.hour);
      if (!new RegExp(`\\b${expectedHour}\\b`, 'i').test(text)) {
        out.push('hour-missing-or-changed');
      }
      if (p.minute === 0 && /\b(vor|nach|halb|viertel)\b/i.test(text)) {
        out.push('top-of-hour-offset');
      }
      const expected = germanDaypartForHour(p.hour);
      const wrong = expected === 'Vormittag'
        ? /\b(mittag|nachmittag|abend|abends|nacht|nachts)\b/i
        : expected === 'Mittag'
          ? /\b(vormittag|morgen|morgens|nachmittag|abend|abends|nacht|nachts)\b/i
          : expected === 'Nachmittag'
            ? /\b(vormittag|morgen|morgens|mittag|abend|abends|nacht|nachts)\b/i
            : expected === 'Abend'
              ? /\b(vormittag|morgen|morgens|mittag|nachmittag|nacht|nachts)\b/i
              : /\b(vormittag|morgen|morgens|mittag|nachmittag|abend|abends)\b/i;
      if (wrong.test(text)) out.push('wrong-daypart');
    }
  }

  if (args.kind === 'station-id') {
    const station = String(settings.get().station || '').trim();
    if (station && !containsPhrase(text, station)) out.push('station-name-missing-or-changed');
  }

  if (args.kind === 'link') {
    if (!args.clockIsAirTime && DAYPART_WORDS.test(text)) {
      out.push('daypart-without-airtime');
    }

    const title = String(args.current?.title || '').trim();
    const artist = String(args.current?.artist || '').trim();
    if (title && !containsPhrase(text, title)) out.push('track-title-missing-or-changed');
    if (artist && !containsPhrase(text, artist)) out.push('artist-name-missing-or-changed');

    const year = args.current ? trackEraYear(args.current) : null;
    if (year && new RegExp(`\\b${year}\\b`).test(text)
      && /\b(offiziell|original|ursprünglich|erstveröffentlicht|erstveröffentlichung|veröffentlicht|erschienen|release)\b/i.test(text)) {
      out.push('catalogue-year-upgraded');
    }
  }

  return [...new Set(out)];
}

export function parseGermanQualityDecision(raw: string): {
  verdict: 'pass' | 'rewrite' | 'drop';
  text: string;
} {
  const clean = String(raw || '').replace(/\r/g, '').trim();
  if (!clean) return { verdict: 'drop', text: '' };

  const firstBreak = clean.indexOf('\n');
  const head = (firstBreak === -1 ? clean : clean.slice(0, firstBreak)).trim();
  const upper = head.toUpperCase();

  if (upper === 'PASS' || upper.startsWith('PASS ')) {
    return { verdict: 'pass', text: '' };
  }
  if (upper === 'DROP' || upper.startsWith('DROP ')) {
    return { verdict: 'drop', text: '' };
  }
  if (upper === 'REWRITE' || upper.startsWith('REWRITE:')) {
    let text = firstBreak === -1
      ? head.replace(/^REWRITE\s*:?\s*/i, '')
      : clean.slice(firstBreak + 1).trim();
    text = text.replace(/^["“«]|["”»]$/g, '').trim();
    return text ? { verdict: 'rewrite', text } : { verdict: 'drop', text: '' };
  }

  return { verdict: 'drop', text: '' };
}

function qualityFacts({
  kind,
  context,
  current = null,
  clockIsAirTime = false,
}: {
  kind: string;
  context: any;
  current?: any;
  clockIsAirTime?: boolean;
}): string {
  const s = settings.get();
  const station = String(s.station || '').trim();
  const location = String(settings.resolveOnAirLocation(s) || '').trim();
  const title = String(current?.title || '').trim();
  const artist = String(current?.artist || '').trim();
  const album = String(current?.album || '').trim();
  const year = current ? trackEraYear(current) : null;
  const lines = [
    ...verifiedMomentLines(context, {
      includeExactClock: kind === 'hourly',
      includeDaypart: kind !== 'link' || clockIsAirTime,
    }),
    ...(station ? [`- Sendername: ${station}.`] : []),
    ...(location ? [`- Verifizierter Standort: ${location}.`] : []),
    ...(kind === 'hourly' && germanTimeAnchor(context)
      ? [`- Verbindliche Zeitbedeutung: "${germanTimeAnchor(context)}".`] : []),
    ...(title ? [`- Songtitel: "${title}".`] : []),
    ...(artist ? [`- Künstlername: ${artist}.`] : []),
    ...(album ? [`- Katalog-Albumangabe: "${album}".`] : []),
    ...(year ? [`- Katalog-Jahresangabe: ${year}; kein Beleg für Original- oder Erstveröffentlichung.`] : []),
    ...(kind === 'link' && !clockIsAirTime
      ? ['- Keine verifizierte Air-Time für diesen Link: keine konkrete Uhrzeit oder Tageszeit behaupten.']
      : []),
  ];
  return lines.join('\n');
}

export function germanQualityReviewPrompt(args: {
  kind: string;
  draft: string;
  context: any;
  current?: any;
  clockIsAirTime?: boolean;
}): string {
  return [
    `Segmenttyp: ${args.kind}`,
    '',
    'Verifizierte Fakten:',
    qualityFacts(args),
    '',
    'Zu prüfender Sendetext:',
    args.draft,
    '',
    'Prüfauftrag:',
    '- Kreativität, Humor, subjektive Eindrücke und ungewöhnliche, aber verständliche Formulierungen ausdrücklich bestehen lassen.',
    '- PASS, wenn der Text natürliches, verständliches Deutsch ist und keine verifizierten Fakten verfälscht oder unbelegte konkrete Fakten erfindet.',
    '- REWRITE nur bei einem klaren, sicher reparierbaren Fehler. Dann den vollständigen sendefertigen Text in "text" zurückgeben und ausschliesslich die verifizierten Fakten verwenden.',
    '- DROP, wenn der Text Wortsalat, ein unverständliches Fragment oder ohne neue Annahmen nicht sicher reparierbar ist.',
    '- Falsche Uhrzeit, falscher Wochentag/Tageszeit, erfundener Ort, veränderter Künstler-/Songname oder aufgewertete Katalogangaben sind niemals PASS.',
    '- Stil nicht glätten, nur weil er eigenwillig ist. Das ist eine Qualitätskontrolle, keine Geschmackszensur.',
    ...(germanHardViolations({
      kind: args.kind as 'hourly' | 'station-id' | 'link',
      text: args.draft,
      context: args.context,
      current: args.current,
      clockIsAirTime: args.clockIsAirTime,
    }).length
      ? [
          '',
          'DETERMINISTISCHE HARD-GATE-VERLETZUNGEN:',
          ...germanHardViolations({
            kind: args.kind as 'hourly' | 'station-id' | 'link',
            text: args.draft,
            context: args.context,
            current: args.current,
            clockIsAirTime: args.clockIsAirTime,
          }).map((v) => `- ${v}`),
          'PASS ist für diesen Entwurf verboten. Repariere sicher mit REWRITE oder antworte DROP.',
        ]
      : []),
    '',
    'ANTWORTFORMAT — exakt eines davon, ohne Begründung:',
    'PASS',
    'oder',
    'DROP',
    'oder',
    'REWRITE',
    '<vollständiger sendefertiger Text>',
  ].join('\n');
}

const REVIEW_SYSTEM = [
  'Du bist die letzte redaktionelle Sendefreigabe eines privaten deutschsprachigen Radios.',
  'Deine Aufgabe ist nicht, Persönlichkeit zu entfernen, sondern unverständliche oder faktisch driftende Moderation vom Mikrofon fernzuhalten.',
  'Nutze ausschliesslich die gelieferten verifizierten Fakten.',
].join(' ');

export function localOllamaReviewLeg(llm: any = settings.get().llm): 'primary' | 'fallback' | null {
  if (llm?.provider === 'ollama') return 'primary';
  if (llm?.fallback?.enabled === true && llm?.fallback?.provider === 'ollama') return 'fallback';
  return null;
}

export async function reviewGermanOnAirText(args: {
  kind: 'hourly' | 'station-id' | 'link';
  draft: string;
  context: any;
  current?: any;
  clockIsAirTime?: boolean;
}): Promise<{ text: string; verdict: 'pass' | 'rewrite' | 'drop'; reason: string }> {
  const draft = String(args.draft || '').replace(/\s+/g, ' ').trim();
  if (!draft) return { text: '', verdict: 'drop', reason: 'empty draft' };

  const hardBefore = germanHardViolations({ ...args, text: draft });

  try {
    const leg = localOllamaReviewLeg();
    if (!leg) {
      const reason = 'review failed: no local Ollama leg configured';
      logEvent('speech.quality', {
        kind: args.kind,
        verdict: 'drop',
        reason,
        reviewer: 'local-ollama',
      });
      return { text: '', verdict: 'drop', reason };
    }

    const raw = await djText({
      system: REVIEW_SYSTEM,
      prompt: germanQualityReviewPrompt({ ...args, draft }),
      temperature: 0.1,
      topP: 0.8,
      repeatPenalty: 1.0,
      maxOutputTokens: 220,
      kind: `onAirQuality.${args.kind}`,
      leg,
    });

    const decision = parseGermanQualityDecision(raw);
    let text = decision.verdict === 'pass'
      ? draft
      : decision.verdict === 'rewrite'
        ? String(decision.text || '').replace(/\s+/g, ' ').trim()
        : '';

    let verdict: 'pass' | 'rewrite' | 'drop' = text ? decision.verdict : 'drop';
    const hardAfter = text ? germanHardViolations({ ...args, text }) : [];

    // The reviewer may suggest a repair, but it never outranks deterministic
    // facts. A hard violation surviving PASS/REWRITE fails silent.
    if (hardAfter.length) {
      text = '';
      verdict = 'drop';
    }

    const reason = hardAfter.length
      ? `hard gate after review: ${hardAfter.join(', ')}`
      : verdict === 'rewrite'
        ? `reviewer rewrite${hardBefore.length ? ` after: ${hardBefore.join(', ')}` : ''}`
        : verdict === 'pass'
          ? 'reviewer pass'
          : hardBefore.length
            ? `reviewer drop after: ${hardBefore.join(', ')}`
            : 'reviewer drop';

    logEvent('speech.quality', {
      kind: args.kind,
      verdict,
      reason,
      reviewer: 'local-ollama',
      hardBefore,
      hardAfter,
    });

    return { text, verdict, reason };
  } catch (err: any) {
    const reason = `review failed: ${String(err?.message || err).slice(0, 180)}`;
    logEvent('speech.quality', {
      kind: args.kind,
      verdict: 'drop',
      reason,
      reviewer: 'local-ollama',
      hardBefore,
    });
    return {
      text: '',
      verdict: 'drop',
      reason,
    };
  }
}
