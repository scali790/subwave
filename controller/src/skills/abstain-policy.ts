// When a FORCED skill run may stand down instead of speaking (issue #1412).
//
// The autonomous director has always been able to choose silence — `air: false`
// is a first-class outcome of both segmentSchema and simpleSegmentSchema. The
// FORCED path (runCapability: the operator's Run-now button, a skill's own cron
// timer, the programme feature beat) had no such option: forcedSystem said
// "silence is not an option" and an empty line threw. That is right for a
// segment written from the moment itself, and wrong the instant the segment is
// supposed to be ABOUT something the skill went and fetched.
//
// The reported failure is the sharp version: web-search searched "Cue musician
// latest news", got an empty answer and three sources about other things
// entirely, and was then told it must produce a line. Its own SKILL.md says
// "use only what the search returned; if it surfaced nothing solid, say
// nothing" — so the two instructions could not both be obeyed, and the model
// resolved the contradiction by recycling a hallucination from an earlier
// break. A model handed no facts and ordered to speak can only invent.
//
// So: a skill that speaks FROM fetched data stands down when that data comes
// back unusable. The policy decisions stay here rather than at the call sites
// because the forced path reaches them from three callers and the pool/agent
// paths each ask again:
//
//   requiresGrounding(cap)                    — may this forced run stand down?
//   forcedRunUsesDirectDataPath(cap, agent)   — who fetches deterministic data?
//   unusableDataReason(data)                  — is the fetched data usable?
//
// Deliberately NOT a gate in the CLAUDE.md sense ("manual operator triggers are
// exempt from every automatic gate"): nothing here decides whether the operator
// is ALLOWED a segment. It decides whether there are facts to write one from,
// and the operator hears about it — POST /dj/skill answers `aired: false` with
// the reason rather than a fabricated line.

// A skill data tool's return value, as far as this policy cares. Everything
// else in it is the skill's own business.
export type SkillData = { error?: unknown; available?: unknown } | null | undefined;

// Skills whose tool treats "no external item" as a cue to write one from its
// own knowledge rather than as a reason to stay quiet. curiosity is the shipped
// example: its `{ available: false }` is the designed hand-off to free
// generation (see skills/curiosity.ts), so standing it down would silence a
// skill that works exactly as intended.
//
// Keyed by kind in code, not read from the skill's files, because state/skills
// is seeded ONCE and never re-seeded: an upgraded station keeps the SKILL.md and
// tool.mjs it was first booted with, so a declaration shipped in a new image
// would not reach the installs this fixes. A skill may still override the
// default for itself — see requiresGrounding.
const FREE_GENERATION_KINDS = new Set(['curiosity']);

// Read a frontmatter/tool-module boolean. Frontmatter values arrive as strings
// (skills/loader.ts flattens every YAML scalar), a tool.mjs export arrives as a
// real boolean, and anything unrecognised means "not declared" — which falls
// through to the default rather than guessing a direction.
export function declaredBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  return undefined;
}

interface GroundedCap {
  kind?: string;
  toolFn?: unknown;
  cronOnly?: unknown;
  toolInputs?: unknown;
  // tool.mjs `export const requiresData = true|false` — the skill author's
  // declaration, for custom skills that don't want the kind default.
  requiresData?: unknown;
  // The skill's own frontmatter, so an operator can settle it per install with
  // a `requiresData:` line in SKILL.md. Operator wins over skill author, same
  // precedence as every other knob that appears in both places.
  config?: Record<string, unknown>;
}

// True when this capability's forced run must not speak without usable data.
//
// A skill with no data tool is never grounded — it writes from the moment and
// its brief, which is all it ever had, so there is nothing for missing data to
// invalidate. Everything else defaults to grounded: the generated tool
// description already promises callers that `{ available: false }` means
// "nothing fresh worth airing", and airing anyway is precisely the bug.
export function requiresGrounding(cap: GroundedCap | null | undefined): boolean {
  if (!cap || typeof cap.toolFn !== 'function') return false;
  const operator = declaredBool(cap.config?.requiresData);
  if (operator !== undefined) return operator;
  const author = declaredBool(cap.requiresData);
  if (author !== undefined) return author;
  return !FREE_GENERATION_KINDS.has(String(cap.kind || ''));
}

// Agent mode normally lets the model call the skill tool so it can choose any
// declared tool inputs. A cron-only grounded skill with no tool inputs has no
// such choice to make: its scheduled data fetch is deterministic. Fetching that
// data directly preserves the forced-run {aired:false} contract even when a
// model never makes the tool call, while input-driven and ordinary skills keep
// their existing agent loop.
export function forcedRunUsesDirectDataPath(
  cap: GroundedCap | null | undefined,
  pickerAgent: boolean,
): boolean {
  if (!pickerAgent) return true;
  if (!requiresGrounding(cap) || cap?.cronOnly !== true) return false;

  const inputs = cap.toolInputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return true;
  return Object.keys(inputs as Record<string, unknown>).length === 0;
}

// Why the fetched data can't be written from, or null when it can.
//
// `null` data is NOT unusable: that is what fetchSegmentData returns for a
// capability with no tool at all, and a skill without a data tool has nothing
// to be ungrounded about (requiresGrounding already returns false for it, so
// this only matters for a caller asking directly).
export function unusableDataReason(data: SkillData): string | null {
  if (data == null) return null;
  if (typeof data !== 'object') return null;
  if (data.error) return `data fetch failed (${String(data.error).slice(0, 120)})`;
  if (data.available === false) return 'the skill found nothing fresh worth airing';
  return null;
}

// The two decisions together: the reason this forced run should stand down, or
// null to go ahead and speak.
export function standDownReason(cap: GroundedCap | null | undefined, data: SkillData): string | null {
  if (!requiresGrounding(cap)) return null;
  return unusableDataReason(data);
}
