# Agent discovery acceptance

Prepared 13 October 2026 after the isolated 12 October rollout acceptance
returned an id without executing discovery. The actual radio caller already
rejected unknown ids before enqueue; this is a completion/recovery reliability
repair, not evidence that a fabricated track aired.

Pick and request definitions opt into caller-owned `hasDiscoveryResults`.
Native output needs both discovery and an accepted id. After the gated run,
an empty candidate map throws `AgentDiscoveryError` before done-only recovery,
terminal collapse, text salvage or success recording. Generic segment/no-tool
agents remain outside that gate. The picker retains the existing distinction
between no discovery (breaker failure) and executed empty discovery (breaker
exempt); both reach the existing pool fallback. A discovery semantic failure
does not activate the stopped Ollama backup.

A nonempty map preserves the caller's near-miss and constrained re-pick paths.
`validate` remains native-only; applying it to every final id would discard
those intentional salvage paths. Done input is schema-parsed. Recovery counts
accumulate instead of replacing main-step counts. Agent calls inherit the
operation/provider abort signal; an expired phase cannot start recovery.

Offline verification: `npm test -- llm-agent-discovery`, relevant picker
fallback/repair regressions, full `npm test`, and `npm run lint`, using isolated
Linux state and synthetic intercepted provider responses. No live credentials,
queue, TTS or Legion are used.

## New bounded hosted qualification protocol

This allocation is separate from the completed 11/12 October allocations and
must not be renewed on failure. Define and persist its ledger before generation:
maximum **12 HTTP chat requests**, sequential, exact Raspy gateway
`http://nim-gateway:8000/v1`, exact catalog-verified
`nvidia/nemotron-3.5-lightning-30b-a3b`. Maximum **2,048 requested output tokens
per call**, **20-second primary phase**, **45-second outer operation**. Stop on
401/403/429, a target/model mismatch, exhausted cap, or a failed fixture. Count
every SDK step/retry, including failed calls, before sending it. No automatic
retry of this allocation. No Dell NIM pilot, Ollama, queue injection or TTS.

Fixtures: exact-model 16-token smoke, short German text, schema object, then two
tool-loop picks with realistic programme context and synthetic candidate data.
Use 2,048 tokens for agents rather than the previous artificial 320-token cap.
Accept each pick only when actual discovery executed and the returned id belongs
to its candidate map. Editorial sentence quality is assessed separately and does
not follow from HTTP/schema success. Qualification must run on the candidate
source; a controller-only rollout requires the exact reviewed main tree and a
fresh baseline/backup, unchanged broadcast/web/gateway, stream probe and rollback
receipt. Any failed acceptance stops the rollout. Legion remains off.

## Hosted result, 13 October

Five operations passed using **7/12** allowed HTTP requests, all HTTP 200.
Both daytime/evening agents executed discovery, then selected `fixture-a` /
`fixture-b` from their actual result maps in 2,269 / 2,222 ms. Each used two
steps and a 2,048 output-token ceiling. Remaining request headers decreased
within each phase (19.994 to 18.673; 19.997 to 19.048 seconds).
The allocation is complete; unused capacity is not permission to rerun it.
No production state, queue, TTS or Legion was touched by qualification.

This establishes transport/schema/discovery grounding, not sustained uptime or
spoken editorial quality. The object invitation remained generic and formal;
agent explanations included unsupported instrumental-stack claims. Banter and
the local German-review dependency remain separate open work. The scratch
container's requested memory limit was ignored by the host kernel; no effective
memory-limit claim is made.

## Offline result, 13 October

Linux Node 22.23.3: **1,828/1,828 tests passed**, no failures, skips or
cancellations, 233.155 seconds. The thirteen new behavior cases include the real
radio pool/near-miss/repick/enqueue path. Lint and TypeScript passed with zero
errors and 784 warnings (the baseline had 782 warnings).
The eight-case regression on the unrepaired strategy had five failures and
three passes, showing that its missing-discovery, empty-result, execution-error,
step-count and transport-cancellation checks detect the old behavior.

Two preliminary full runs had 43 text/compose guard failures because the
Windows checkout and then its default Git archive contained CRLF. The final
archive used `git -c core.autocrlf=false archive`; LF was verified on Linux
before the successful full run. No tests were disabled or skipped.

Status: offline and hosted grounding qualified. Source merge/deployment and
production stream acceptance are recorded separately in the Homelab receipt.
