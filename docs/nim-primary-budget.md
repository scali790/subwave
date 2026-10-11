# Internal upstream budget: whole provider phase

Contract recorded before implementation, 11 October 2026. Radio's six-second
gateway header intermittently aborts successful-but-slower inference. Increasing
each request alone leaves SDK retries and format recovery free to consume the
entire 45-second operation, as the earlier fault audit demonstrated.

For the existing opt-in `X-Homelab-Upstream-Budget-Seconds` header on an
OpenAI-compatible/locca leg, enforce one deadline around the whole attempt.
Every SDK retry, agent step, backoff and format recovery shares it. The transport
reduces subsequent gateway headers to remaining phase/operation time. Because
the gateway floors requests at five seconds, refuse a new request below that
remaining window rather than letting the gateway extend it. Other providers and
calls without this header retain their policy. Pinned calls remain pinned.

A provider-phase timeout may enter the configured backup; user cancellation or
the outer operation deadline may not. Backup receives its own configured budget
inside the original operation. No additional model calls or retry counts are
introduced. Client cancellation and gateway request deadlines are measured
separately; they do not prove immediate cancellation inside NVIDIA's server.

Candidate activation is 20 seconds for the phase, with the existing 45-second
total unchanged. This bounds lost-primary latency and leaves up to 25 seconds
for subsequent work, not a guaranteed inference window. Legion is intentionally
stopped: qualification must not contact it, and cannot claim local review or
backup availability. The repair includes the PR #7 structured-recovery fix, but
does not include the unaccepted Banter changes from draft PR #8.

## Structured objects on the qualified Nemotron

For `openai-compatible` and exact model
`nvidia/nemotron-3.5-lightning-30b-a3b`, plain objects use `json_object` mode,
include the JSON Schema in the prompt and retain SDK/Zod validation. The
[model-specific NVIDIA guide](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html)
recommends this shape. Real discovery/done tools retain their existing strategy;
other providers/models are unchanged. Invalid output still has only the existing
bounded format-repair opportunity. JSON syntax is not editorial acceptance.

## Validation, 11 October 2026

Thirteen isolated regressions cover shared deadlines, retry/backoff, decreasing
headers, the gateway minimum, hung upstream, synthetic backup, caller cancellation,
outer-deadline precedence, pinning, unavailable configuration and JSON validation.
The first full suite caught a timer race: a child timer sharing the outer deadline
could label total exhaustion as a provider failure. The corrected implementation
lets the outer signal own that deadline. Final Linux run: **1,815/1,815 tests
passed**, zero skipped/cancelled, 188.083 s. `npm run lint` including TypeScript
passed with zero errors and 782 warnings. Full log SHA-256:
`2ae5b4f616f1e02586613b414ba740ddadb47da6f270b5724a76d2bb4beb4e6b`;
lint log: `cea4bbdcd6ad5fdb1b71bad5723a65c130dc393bd8a84561cb2e30138aea292e`.
Do not substitute the initial failed run.

Real qualification used the deployed Raspy NIM gateway with isolated candidate
source/settings and synthetic context. No local inference or queue/TTS writes.
Catalog contained the exact model; smoke returned HTTP 200 in 724 ms. The initial
SDK matrix passed 3/5: both forced-emit object calls hit 20 seconds. Raw controls
also exposed malformed/truncated tool JSON; they did not establish a schema
length-constraint cause. All twelve diagnostic requests remain in the evidence.

The final candidate passed 5/5 operations at 15:07:23–15:07:38 UTC: text 2.109 s,
objects 1.083/1.612 s, grounded two-step agents 3.172/8.869 s. All seven HTTP calls
returned 200. The slowest first agent step took 7.506 s; its next header decreased
to 12.486 s. Total qualification consumption: 19 requests out of a documented
20-request ceiling; stop there, with no automatic repeat. These small synthetic
samples establish a working transport path, not an uptime SLA or German Banter
acceptance. The generic generated invitations are not approved radio copy.

The budget is per `withFailover` provider attempt. Several separate LLM primitives
inside one decision still share the existing 45-second outer limit; this change
does not promise a fresh 25-second backup window for each primitive.

Run `npm test -- llm-primary-budget`, `npm run lint`, then `npm test` on Linux.
`family-radio-quality-runtime.ts` is deliberately outside test auto-discovery and
requires `FAMILY_RADIO_QUALITY_ACCEPTANCE=1` plus isolated `STATE_DIR`; it contacts
configured real providers and is not authorized while Legion must stay off.

## Activation boundary

Source candidate only. Review/merge through `develop`, then the release merge to
`main`; rebuild the controller from the verified commit. Only then change the
existing primary header from `6` to `20`, retaining all other settings. A restart
of the old image cannot install the fix. Preserve the former image and private
settings backup for rollback. No gateway restart or model replacement is needed.
Production rollout, post-deployment acceptance and physical listening are pending.
Station ID/hourly local-review requirements and draft PR #8's Banter/agent work
remain separate; this repair does not bypass their quality gates.
