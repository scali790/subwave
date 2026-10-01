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

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { djObject } from '../strategy/object.js';
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

const reviewSchema = z.object({
  verdict: z.enum(['pass', 'rewrite', 'drop']),
  text: z.string().max(700),
  reason: z.string().max(240),
});

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

    const out = await djObject({
      system: REVIEW_SYSTEM,
      prompt: germanQualityReviewPrompt({ ...args, draft }),
      schema: reviewSchema,
      temperature: 0.1,
      maxOutputTokens: 320,
      kind: `onAirQuality.${args.kind}`,
      // Family Radio uses local Ollama/Qwen as the editorial leg. Resolve by
      // provider role rather than hard-coding "fallback", because Qwen may be
      // promoted to primary after acceptance.
      leg,
    });

    const verdict = out?.verdict === 'pass' || out?.verdict === 'rewrite' ? out.verdict : 'drop';
    const text = verdict === 'pass'
      ? draft
      : verdict === 'rewrite'
        ? String(out?.text || '').replace(/\s+/g, ' ').trim()
        : '';
    const finalVerdict = text ? verdict : 'drop';
    const reason = String(out?.reason || '').trim().slice(0, 240);
    logEvent('speech.quality', {
      kind: args.kind,
      verdict: finalVerdict,
      reason,
      reviewer: 'local-ollama',
    });
    return {
      text,
      verdict: finalVerdict,
      reason,
    };
  } catch (err: any) {
    const reason = `review failed: ${String(err?.message || err).slice(0, 180)}`;
    logEvent('speech.quality', {
      kind: args.kind,
      verdict: 'drop',
      reason,
      reviewer: 'local-ollama',
    });
    return {
      text: '',
      verdict: 'drop',
      reason,
    };
  }
}
