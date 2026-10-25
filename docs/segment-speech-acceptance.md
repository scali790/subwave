# Generated segment speech acceptance

19 October 2026: fail closed on oversized single-speaker skill copy.
The 14 October real NIM shortening sample lost required statements and later
exceeded the speech contract (659/600). Automatic shortening is removed from
this candidate. This source change is not a deployment.

## Contract

- Director, pool and forced prompts retain the live advertised budget with
  pronunciation headroom. An absent persona slot follows station defaults.
  No limit is invented for an unadvertised backend contract.
- Before queue.announce, generated text passes the dispatcher's final
  pronunciation normalization, live corrections, script/language policy,
  voice and Unicode codepoint/whitespace validation.
- Text within the known contract keeps its display wording, except for the
  existing markup/whitespace cleanup. Exactly 600 characters pass when 600 is
  advertised. Names, numbers, negation, qualifications and attribution are
  not rewritten.
- Oversized or otherwise invalid text throws before queueing or synthesis.
  There is no shortening callback, extra model call, substring cut, budget
  reset or validation-triggered Piper escape. The worker ceiling is unchanged.
- Preflight rejection marks the active trace failed and emits speech.rejected
  with stage preflight. queue.announce still marks caught delivery failures.
  The existing withTrace marker ensures handled exceptions cannot become a
  misleading trace.end ok:true. Deliberate silence/scheduling/ownership
  stand-downs remain ordinary outcomes.
- Successful delivery alone reserves segment cooldowns. The curiosity ledger
  still waits for delivery.completed; rejected text does not enter it.

The initial generated copy's factual quality remains a separate responsibility.
An unchanged admissible text is not automatically fact-checked. LLM success,
logical trace outcome, accepted/deferred/completed delivery and physical
listening remain separate.

## Tests and qualification

scripts/segment-speech-acceptance.test.ts contains 25 regressions. The actual
autonomous/forced callers are exercised in agent and pool modes with synthetic
HTTP and a fake mixer handoff in isolated state. Rejected text causes no TTS
POST/handoff and no additional model call. Acceptable text preserves its
wording. Late backend rejection and trace-scope isolation remain covered.

The eight frozen 14 October synthetic sources are retained in
controller/scripts/fixtures/segment-speech-semantics.json; all are now
rejected on length instead of being rewritten. The 601/632/659 boundaries,
Unicode codepoints and pronunciation expansion are also covered.

The prior 13 October rewrite candidate passed 1843 synthetic tests but was not
editorially qualified. The real 14 October allocation closed at 7/20 and must
not be replayed. Removing rewriting requires no new hosted allocation; this
revision uses offline regressions only.

Any future shortening implementation must establish an explicit verifiable
source-proposition contract, including names/numbers, attribution, negation
and uncertainty, and qualify the revised output before admission. No such
semantic approval mechanism or bypass is implemented here. Until it exists,
free-form oversized copy stays rejected. Banter/local German review,
co-hosted exchange limits and physical on-air acceptance remain open.
