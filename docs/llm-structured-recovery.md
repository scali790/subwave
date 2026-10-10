# Structured-output recovery and upstream failures

`djObject` first requests structured output using the provider's configured
native or forced-tool strategy. A second, plain-text request can repair malformed
output or work around a provider rejecting that output mode.

A transport failure has no model output to repair. Previously the recovery loop
also repeated HTTP 424 dependency failures and authentication refusals. A gateway
with a six-second request budget therefore consumed twelve seconds before the
existing primary-to-fallback policy could run.

The recovery loop now stops after cancellation, transport/transient failures,
authentication/quota refusal, upstream overload/dependency failure or rate
limiting. Existing classifiers in `core/pure.ts` own these decisions. Transient
retries remain the responsibility of `withTransientRetry`; exhausted retries do
not gain another retry sequence merely by switching output format. The original
error and attempted strategy remain available to failover and diagnostics.

Malformed/schema-invalid output and HTTP 400 compatibility recovery retain the
second attempt. Successful structured calls remain single calls. No provider
routing, model choice, sampling defaults, global operation deadline or stored
gateway header is changed by this code fix.

Verification uses the real AI SDK, strategy and failover modules with synthetic
HTTP responses and isolated state:

```sh
cd controller
npm test -- llm-object-recovery
npm run lint
```

The regression exercises both forced-tool output (openai-compatible) and native
JSON output (DeepSeek SDK), with all HTTP requests intercepted. It covers primary
424 followed by successful fallback, no configured fallback, authentication
refusal, invalid output, HTTP 400 compatibility, successful single-call output,
both legs failing, exhausted transient retries and deadline cancellation. A
separate pre-cancelled caller case checks that no provider request starts.
The original upstream code and attempted strategy remain in the failure record.

## Linux validation, 2026-10-10

The reference is `develop` at
`24c5a0ee2b232f6e0d8c5b83f465d67c2b56e9bb`, tree
`aab08364ada4dcf44af22fe95779044dbbb0799c`. The then-current release merge
`f5242f0947a1f59fa566fca0d056074c2310ae7b` had the same tree. The isolated
Linux checkout's full Git tree was verified before dependencies or tests ran.
Runtime: x86-64 Linux, Node 22.23.3, npm 10.9.9, Python 3.14.4, lockfile-based
`npm ci --no-audit --no-fund`. No production state or provider credentials were
copied. The new regression uses only synthetic replies and a fake SDK key.

| Check | Unchanged reference | Recovery correction |
| --- | --- | --- |
| New regression file | 9 passed, 10 failed | 19 passed, 0 failed |
| Full `npm test` | 1782 passed, 2 failed / 1784 | 1801 passed, 2 failed / 1803 |
| Controller `npm run lint` | Not repeated separately | TypeScript passed; 0 ESLint errors, 780 warnings |

The two full-suite failures have the same causes on both trees:

- `analyzer-python.test.ts`: the host Python had neither NumPy nor pip. The
  repository-pinned NumPy 2.5.2 wheel was subsequently provided in an isolated
  test dependency directory. `npm test -- analyzer-python` then passed all ten
  Python suites. No system Python installation changed.
- `family-radio-quality-runtime.test.ts`: this is a real-model acceptance
  harness discovered by `npm test`. It requires an explicitly configured
  Ollama/Qwen fallback and German persona; the isolated empty settings correctly
  failed that prerequisite. No fake live acceptance or skipped test was used to
  turn this into a green full-suite claim.

There are no additional failing tests in the correction. The full suite remains
non-green for the reasons above; unit/regression validation does not establish
live availability, editorial quality or audible acceptance. The original
Windows failures were not used as the Linux baseline.

## Request budget and rollout boundary

This repair removes the extra format attempt after an upstream failure; it does
not make an unavailable fallback available. A primary 424 now reaches existing
fallback admission after one primary attempt. Existing transient retries still
run under their original owner and share the same total operation deadline.

A 20-second gateway request budget is a **qualification candidate**, not a new
default or a value set by this patch. Under a 45-second total deadline it leaves
at most 25 seconds for overhead and fallback; retries and processing also spend
that remainder. Qualify the full dialogue route and failure cases before changing
stored headers. A short availability probe does not establish that budget.

Review and merge through `develop`; production rollout and live text/TTS/listening
acceptance remain separate. No model, gateway header, production settings or
running service was changed during this validation.
