# Banter quality and agent completion

Status, 11 October 2026: **source candidate; Banter live acceptance pending;
not deployed**. This branch includes the structured-output recovery prerequisite
from PR #7 (`e16d80e`). Both changes target `develop`, before a separate release
and production rollout.

## Problem and resulting behavior

A schema-valid Banter exchange could still repeat an excluded opening, invent a
sunrise from a song title, or contain disconnected German. Agent picks sometimes
continued the previous presenter dialogue instead of completing the tool task.
When terminal recovery also failed, diagnostics lost earlier discovery steps.
These are separate from an unavailable provider or stopped notebook.

The initial change contract required a bounded whole-dialogue gate and validated
agent completion. It was recorded before implementation; this audit records
what actually passed and what remains unproven.

German Banter now follows this path:

1. Select an editorial dialogue spine about music preferences, avoiding obvious
   topics present in the recent recap. If all six are exhausted, abstain. The
   writer adapts three turns to the cast, preserving question, answer and response.
   Song titles do not establish weather or room facts.
2. Generate a structured exchange with exact cast IDs. Deterministic checks
   require 3–6 lines, at least two voices, no repeated recent opener or identical
   line, no speaker-label prefix, and bounded length (240 characters per line,
   900 per exchange). Known stage directions and unsupported scene claims drop.
3. Only a draft passing those checks reaches one local-Ollama review of the
   entire exchange. The reviewer returns `PASS` or `DROP` with a reason; it does
   not rewrite. Missing reviewer, malformed review or refusal drops the beat.
   A pass is checked again before returning lines to the caller.

Writer and reviewer share the existing operation deadline (45 seconds by
default). There is no additional per-speaker call or rewrite loop. A deterministic
failure uses **zero** reviewer inference. Literal excluded openers stay with the
gate/reviewer because the small writer repeatedly copied phrases from a negative
prompt. Non-German exchanges retain their existing writer and use the structural
gate, without a German editorial reviewer.

The spines are writing scaffolds, not a canned emergency broadcast. They are
never sent directly to TTS. The existing scheduler rejects a null exchange before
`queue.announceExchange`. Humor and different voices remain required. Regex checks
alone do not prove semantic grounding, and a same-model reviewer is not an
independent human editorial acceptance. Diversity beyond six topics and the final
spines' live quality are still unqualified.

Agent completion keeps the existing main → done-only → terminal sequence:

- The tool instruction separates the current task from prior on-air dialogue.
- Every final completion channel runs schema and caller validation. Picker IDs
  must be present in actual discovery results. A legitimate request response of
  `kind: chat, id: null` remains valid.
- Terminal recovery can use schema-valid JSON from the response it already
  received when the model did not call `emit`. Prose is not guessed into a pick;
  invented IDs are refused. This adds no model call.
- The main/recovery/terminal failure trail and available token usage are retained.
  Cancellation propagates into terminal generation; no fourth recovery leg or
  longer deadline is introduced.

## Offline validation

Tests use the real AI SDK with intercepted synthetic HTTP responses and isolated
state. No broadcast, TTS, notebook model or hosted provider is contacted.

```sh
cd controller
npm test -- llm-banter-agent-reliability
npm run lint
npm test
```

Linux reference: Node 22.23.3/npm 10.9.9, repository-lock dependencies reused from
the previous isolated `npm ci`, and repository-pinned NumPy 2.5.2 supplied only
through a test `PYTHONPATH`. Export the reference with LF endings; a Windows CRLF
archive produces unrelated Linux shell-test failures.

| Check | Result |
| --- | --- |
| New behavior regressions against pre-repair `e16d80e` | 4 passed / 16 failed |
| Candidate regressions | 20 passed / 0 failed |
| Full offline suite | 1,822 passed / 0 failed / 0 skipped |
| Controller lint and TypeScript | 0 errors; 780 existing ESLint warnings |

The fixtures cover editorial refusal/malformed output, bounded calls, repeated
openers, deadlines, real discovery, prose instead of `done`/`emit`, terminal JSON,
fabricated IDs, valid chat, recovery transport failure, aggregate token usage and
cancellation. An earlier full run hit the pre-existing millisecond-sensitive queue
clock assertion (`334.749` versus `334.75`); its focused rerun and subsequent full
runs passed. No production acceptance is inferred from these tests.

`family-radio-quality-runtime.test.ts` was a real-provider acceptance operator
accidentally discovered by the offline suite. It is retained as
`family-radio-quality-runtime.ts`, with an explicit opt-in and isolated state:

```sh
FAMILY_RADIO_QUALITY_ACCEPTANCE=1 STATE_DIR=/path/to/isolated-state \
  node --import tsx scripts/family-radio-quality-runtime.ts
```

That command can consume real inference and requires separately authorized
capacity. Renaming it does not mark its live checks passed. Historical results
remain in [structured-output recovery](llm-structured-recovery.md).

## Real-model qualification and stop condition

Before the owner stopped Ollama, isolated Raspy trials used warm `qwen3.5:9b`,
context 8192, through the actual controller SDK. The primary was a synthetic HTTP
424 delayed six seconds; no hosted API was called. Synthetic personas/music
candidates and fresh state replaced household data. No live queue or TTS call
occurred.

- Initial writer/rewriter: one of three exchanges returned, but contradictory
  wording failed human editorial review. It was not an accepted broadcast.
- Conservative reviewer iterations: zero of three Banters accepted. Rejections
  included awkward/unrelated wording, invented setting and deadline exhaustion.
- Revised agent instruction/validation completed three of three real-model picks
  in each of two runs, grounded in supplied discovery results. The final recorded
  run completed at `2026-10-11T09:45:14.547Z`. This is a bounded tool-path result,
  not proof of long-term reliability under desktop contention.
- The final editorial dialogue spines could not be model-qualified: Ollama was
  stopped at 11:55 Europe/Zurich. The owner confirmed stopping it because notebook
  load prevented normal work. It must remain stopped; do not restart, preload or
  bypass cooldown to complete this acceptance.

The manual `scripts/qualify-banter-agent.mjs` requires
`SUBWAVE_LOCAL_AI_QUALIFICATION=1`, its fixed isolated `/tmp` source path and an
already warm model. It allows only synthetic primary and the existing local
Qwen endpoint, runs three cases per selected `QUALIFY_PHASE` (`banter`, `agent`,
or `all`), and records source hashes/timings. A dropped exchange now makes the
run exit nonzero; early exploratory runs' exit codes were not acceptance proof.
Do not run it until notebook capacity is explicitly available again.

## Current production and next gates

Production still runs the previous image. With NIM returning HTTP 424 and the
Legion container deliberately stopped, no configured text provider is available.
Read-only logs on 11 October show continued queued/playing music from the pool,
with optional AI segments skipped. Piper is a speech renderer, not a third text
generator. A working music fallback does not establish AI continuity.

Keep this candidate in draft until a bounded, owner-compatible compute window or
approved alternative capacity can qualify final Banter spines. Require coherent
accepted dialogues across synthetic cases, no repeated openings or invented
setting, acceptable latency, and no interference with notebook work. Separately
resolve primary availability/shared budget. If useful, extract the isolated
agent/diagnostic fixes into their own reviewed delivery.

After acceptance: review/merge into `develop`, release through `main`, rebuild
the production controller image, and verify text → queue acceptance → TTS →
audible output. A container restart alone reruns the old baked source.
