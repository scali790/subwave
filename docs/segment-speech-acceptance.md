# Generated segment speech acceptance

13 October 2026: source repair for an autonomous segment rejected at 632
characters against the advertised 600-character limit, followed by a misleading
successful segment trace. Candidate until separately merged, released and deployed.

## Contract

- Director, pool and forced single-speaker prompts include the live advertised
  budget with one-sixth pronunciation headroom. An absent persona slot follows
  the station default. Unadvertised service limits stay unknown.
- Before queue.announce, generated single-speaker skill text passes the
  dispatcher's shared normalization, live pronunciation corrections,
  language/script policy, voice and Unicode codepoint/whitespace validation.
  Exactly 600 characters pass when 600 is advertised. The worker limit stays.
- Only text_too_long permits one logical shortening operation. It requests
  preservation of meaning, qualifications, attribution and names without new
  facts. Output is capped at 1024 tokens and time at the remaining original
  segment deadline. It never receives a fresh 45-second segment window.
  Existing bounded SDK format repair/failover may make multiple HTTP calls
  inside this operation; this is not exactly one HTTP request.
- The revision must be nonempty, have sentence-ending punctuation and pass
  final spoken-text validation. Failure discards it before TTS/handoff.
  No substring truncation, shortening loop or Piper escape is introduced.
- Only accepted revised display text reaches queue/session and curiosity
  bookkeeping; the durable curiosity ledger still waits for delivery.completed.

## Outcomes

markTraceFailure records a handled operational failure in the active scope.
withTrace preserves return/rethrow behavior, but trace.end cannot report
ok:true after this marker. queue.announce marks caught rendering/request/
handoff exceptions and emits speech.rejected. Preflight/rewrite failures and
unexpected autonomous errors also mark the scope. Explicit silence, scheduling
suppression and stale-host ownership remain ordinary stand-downs. Failed speech
does not consume successful segment cooldowns.

LLM ok:true means generation succeeded. An error-free logical trace does not
prove audible speech. Acceptance, deferral, completion and physical listening
remain separate.

## Verification boundary

Final isolated Linux validation: 1843/1843 tests passed, zero failures/skips/
cancellations, 200.326 s. Lint plus TypeScript passed with zero errors and
787 warnings (baseline 784; three added permissive persona-argument types).
The 15 new regressions pass. Restoring the legacy trace.end outcome rule in a
separate copy makes the late rejection regression fail as expected.

scripts/segment-speech-acceptance.test.ts exercises actual autonomous/forced
callers in agent and pool modes, dispatcher/remote client and queue using
synthetic HTTP and fake mixer handoff in isolated state. It covers length
boundaries, normalization expansion, Unicode, invalid revisions, late HTTP
rejection, consumed deadlines and independent trace scopes.

No hosted generation, Legion request/start, production queue write or service
change is needed. This is not NIM editorial, Banter, local German review,
co-hosted exchange or physical on-air acceptance. Sentence-ending punctuation
is a structural check; meaning preservation needs editorial qualification
before production rollout.
