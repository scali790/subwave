// Multi-voice banter — a short scripted exchange between the show's host and
// guest co-hosts, aired between tracks. One structured-output call writes the
// WHOLE exchange (a per-line call would multiply latency and lose the
// back-and-forth); each line is then rendered in its speaker's own TTS voice
// and aired back-to-back through the serialized voice chain
// (queue.announceExchange). Speaker ids ride a per-call Zod enum, so the model
// can't invent a voice we can't render — and that enum stays STRICT: a speaker
// repaired into whichever persona looks closest airs the line in the wrong
// voice, which is worse than losing the beat. settings.castSpeakerIdRule() is
// the prompt-side mitigation for the rejections that follow from that (#1512);
// it lowers the odds of a rejected exchange and cannot rule one out.

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { soulBrief } from '../core/pure.js';
import { djObject } from '../strategy/object.js';
import { buildContextLines } from './context.js';
import { withinOperation } from '../core/operation.js';
import { isGermanPersona } from './german-on-air.js';
import { banterTopic, banterViolations, reviewBanter } from './banter-quality.js';

// Same field set as the free-text script generators (scripts.ts): ambient
// weather stays out (issue #471 — it dominated every segment); the dedicated
// weather skill owns that beat.
const BANTER_CONTEXT_FIELDS = ['date', 'clock', 'time', 'festival', 'show', 'listeners'];

// The exchange stays short by construction: radio banter that runs past ~6
// lines stops being a break and starts being a podcast.
const MIN_LINES = 3;
const MAX_LINES = 6;

// Souls ride as briefs, not in full: this block repeats once per cast member
// (host + up to GUESTS_PER_SHOW guests), and it exists to tell the model who
// is in the room, not to hand each one their whole character document.
function castBlock(host: any, guests: any[]): string {
  const entry = (p: any, role: string) =>
    `- ${p.id} — ${p.name} (${role}): ${soulBrief(p.soul) || 'no notes'}`;
  return [entry(host, 'HOST'), ...guests.map((g: any) => entry(g, 'GUEST'))].join('\n');
}

// The exchange's system prompt. Exported pure for the same reason as
// programme.ts's exchangeSystem: the station house rules have to be PROVABLY
// on this path (issue #1420 — they weren't), and a test that only asserts the
// block builder exists is exactly the regression it fails to catch.
export function banterSystem({ host, guests, show = null }: any): string {
  const showClause = show?.name ? ` of "${show.name}"` : '';
  const lang = String(host?.language || '').trim() || 'English';
  const langClause = ` Everyone speaks ${lang} on air. ${settings.spokenProperNounDirective(host)}`;
  if (isGermanPersona(host)) return `Schreibe einen kurzen, natürlichen deutschen Radiodialog während der laufenden Sendung${showClause}.
Besetzung (ID — Name und Charakter):
${castBlock(host, guests)}

Drei bis vier kurze Zeilen, mindestens zwei Sprecher. Jeder Satz muss sofort verständlich sein. Wähle EINE kleine Frage oder Vorliebe, über die man freundlich unterschiedlicher Meinung sein kann. Der zweite Sprecher antwortet konkret; der dritte Beitrag reagiert auf diese Antwort. Humor entsteht aus den unterschiedlichen Haltungen, nicht aus seltsamen Wortbildern. Schreibe direkt auf Deutsch.
Beginne sofort mit einer inhaltlichen Frage oder Beobachtung, ohne einleitende Füllphrase. Verwende den Rückblick nur, um Themenwiederholungen zu vermeiden. Songtitel sind keine Fakten über Wetter oder Umgebung. Keine erfundenen Ereignisse, Hörerreaktionen, Handlungen oder Musikdetails. Keine Begrüssung, Verabschiedung, Uhrzeit, Stationskennung oder Ankündigung eines nächsten Titels. Keine Regieanweisungen, Sprecherlabels, Emojis oder Sternchen.
Jede Zeile höchstens 240 Zeichen, insgesamt höchstens 900. Die speaker-ID muss exakt aus der Besetzung stammen; text enthält nur die gesprochenen Worte.
${settings.castSpeakerIdRule()}${langClause}${settings.castHouseRulesBlock()}`;
  return `You write short on-air exchanges between the hosts${showClause} on a personal internet radio station, mid-show. This is people who know each other talking in one studio: quick, warm, a little loose — real speech, not sketch comedy or a scripted bit.

The cast (persona id — name (role): voice notes):
${castBlock(host, guests)}

Rules:
- ${MIN_LINES} to ${MAX_LINES} lines total, at least two different speakers. Let the turn-taking breathe — it doesn't have to alternate mechanically, but nobody monologues.
- ${settings.castSpeakerIdRule()}
- Each speaker stays in THEIR OWN character per the voice notes. The host carries the room; guests chip in as themselves.
- Ground it in the moment you're given (the track playing, the hour, the show) — react, riff, disagree gently, tease. One thread, not a topic list.
- This is a conversation, NOT a link: do not introduce, back-announce, or name-drop the next track, do not read a station ident, do not announce the time.
- No greetings or sign-offs — the show is already rolling. No invented listener messages, callers, or events.
- No invented weather, sunrise, room, physical activity or song facts. Use one concrete conversational idea, with each line responding to the previous one. Avoid generic coffee and vibe filler. At most 240 characters per line and 900 for the exchange.
- Plain spoken words only: no stage directions, no asterisks, no emoji. Speaker names in supplied recap are reference-only: never prefix a spoken line with any speaker name or a name-and-colon label; the separate speaker field already routes each line to the right voice.${langClause}${settings.castHouseRulesBlock()}`;
}

// Returns air-ready lines [{ persona, text }] in order, or null when the model
// couldn't produce a usable exchange (fewer than three lines or a single voice
// throughout — a monologue should go through the normal segment paths, not
// masquerade as banter).
export async function generateBanter({
  host, guests, show = null, current = null,
  context = null, recap = null, recentOpeners = null,
}: any) {
  return withinOperation(settings.get().llm?.agentTimeoutMs ?? 45_000, async () => {
    const cast = [host, ...guests];
    const ids = cast.map((p: any) => p.id);
    const schema = z.object({
      lines: z.array(z.object({
        speaker: z.enum(ids as [string, ...string[]]).describe('the persona id of who says this line, from the cast list'),
        text: z.string().min(1).max(400).describe('the spoken line only — one or two short conversational sentences, with no speaker name or label prefix; the separate speaker field selects the voice'),
      })).min(MIN_LINES).max(MAX_LINES).describe('the exchange, in air order'),
    });

    // The host's on-air language governs the room — co-hosts on one show share
    // a broadcast language, same rule as the rest of the station. banterSystem
    // owns the language and spoken-name policy so pure prompt tests cover it.
    const system = banterSystem({ host, guests, show });

    const ctxLines = buildContextLines(context, { contextFields: BANTER_CONTEXT_FIELDS });
    if (current?.title) ctxLines.push(`On air right now: "${current.title}" by ${current.artist || 'unknown'}`);
    if (recap) ctxLines.push(`Already said on air recently (do not repeat these topics or phrasing):\n${recap}`);
    if (isGermanPersona(host)) {
      const topic = banterTopic(String(recap || ''));
      if (!topic) return null;
      ctxLines.push(`Redaktionell vorbereiteter Dialogkern:\n${topic}\nFormuliere diese drei Beiträge behutsam in den Stimmen der Besetzung: Host, EIN Gast, Host. Erhalte Frage, Antwortgrund und Schlussgedanken. Du darfst gute Formulierungen übernehmen. Füge keine Fakten, Handlungen, neuen Themen oder Beschreibung des laufenden Songs hinzu. Die Rollenlabels im Dialogkern gehören NICHT zum gesprochenen Text; verwende die exakten Besetzungs-IDs im speaker-Feld.`);
    }
    // Small writers echoed the literal excluded phrases from this block. Keep
    // them with the independent reviewer/hard gate, not in the writer's context.
    if (recentOpeners?.length && !isGermanPersona(host)) ctxLines.push(`Recent opening words (start the first line differently): ${recentOpeners.join(' | ')}`);
    const prompt = `${ctxLines.join('\n')}\n\n${isGermanPersona(host) ? 'Schreibe jetzt den kurzen Dialog.' : 'Write the exchange.'}`;

    const out = await djObject({
      system,
      prompt,
      schema,
      temperature: 0.7,
      maxOutputTokens: 900,
      kind: 'generateBanter',
    });

    const draft = out.lines.map((l: { speaker: string; text: string }) => ({ ...l, text: l.text.trim() }));
    const checked = isGermanPersona(host)
      ? await reviewBanter({ lines: draft, cast, facts: prompt, recentOpeners: recentOpeners || [] })
      : banterViolations(draft, cast, recentOpeners || []).length ? null : draft;
    if (!checked) return null;
    const byId = new Map(cast.map((p: any) => [p.id, p]));
    const lines = checked
      .map((l: any) => ({ persona: byId.get(l.speaker), text: String(l.text || '').trim() }))
      .filter((l: any) => l.persona && l.text);
    const speakers = new Set(lines.map((l: any) => l.persona.id));
    if (lines.length < MIN_LINES || speakers.size < 2) return null;
    return lines;
  });
}
