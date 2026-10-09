# Family Radio AI reliability repair — 2026-10-09

Status: implementation candidate; production acceptance is separate.
Base: `3a0703e9bc7222c58bff2334ea9a7542c79853d7` (FR002.5).

## Incident

A styled instruction below the UI's 500-character input limit generated 615
characters. Qwen accepts 600 normalized Unicode codepoints. HTTP 413 incorrectly
triggered Piper. Separately the old gateway requested wake while Qwen was rendering.
NIM returned bounded HTTP 424 failures while the configured Ollama backup was
unreachable. NIM catalogue success did not establish successful generation.

## Speech contract

Remote TTS may advertise `health.capabilities` with `schema_version: 1`,
`max_text_chars`, `text_normalization: python-whitespace-codepoints-v1`,
`voices` and `default_voice`. Generic endpoints without this optional contract
retain their behavior. Metadata is keyed by endpoint and retained through
temporary failures; a successful health response without it clears the cache.

The dispatcher validates the final normalized, pronunciation-corrected text
before engine substitution. The gateway remains authoritative. Both count Unicode
codepoints with Python whitespace semantics (U+0085/U+001C–001F included, FEFF
excluded). Voice validation uses the resolved persona slot, including inheritance.
Prompt guidance reserves one sixth of the advertised allowance for corrections;
the final validation remains necessary even if the model ignores the instruction.

HTTP 400/413/422 and local validation failures are permanent: no retry, clipping
or Piper rescue. `/dj/say` returns a useful 422 and no longer clips input. Manual
queue calls propagate failures; automatic speech remains fail-silent. Real
outages still use the established rescue chain. `GET /settings` exposes
`tts.remoteConstraints`. Long-text splitting is deferred; shorten manual text.

## Model deadlines and backup

`operation.ts` owns the monotonic deadline and cancellation signal shared by
text/object/agent calls, retries, schema/tool recovery and optional failover.
Track decisions and listener request resolution share it across agent-to-pool
recovery. Only model calls race cancellation; deterministic music selection and
queue writes remain awaited, preventing detached late enqueue work. The budget
uses `llm.agentTimeoutMs` (default 45s). Pinned bulk/editorial calls retain their
existing policy unless already inside a shared operation. HTTP cancellation
cannot establish that a remote provider stopped inference or billing.

Ollama backups require `/api/tags` 200 with the configured model. Failed/absent
models open a 60s cooldown; success caches for 15s. After expiry the next callers
share one 3s probe. Newer generation failure wins over an older probe. A catalogue
probe is not inference acceptance. No periodic scheduler was added.

Primary model, six-second NIM header, fallback endpoint and voices remain existing
operator configuration. Deterministic music fallback and voice policy are retained.

## Evidence

LLM records/durable events carry request ID and allowlisted upstream HTTP/code/
status/time/attempt metadata. 424 means dependency failure, not assumed overload.
TTS records/durable events carry requested/rendered engine and original failure;
the TTS ID reaches the gateway. LLM and TTS IDs identify separate stages; existing
event trace IDs provide decision context, not a global distributed-trace guarantee.

New tests: `radio-ai-reliability`, `radio-ai-llm-integration`,
`radio-ai-tts-integration`, `radio-ai-manual-error`, `radio-ai-piper-rescue`.
They use synthetic transports/subprocesses and temporary state. They do not
prove voice quality, physical wake, real NIM inference or listener audibility.
The matching Homelab receipt contains the consolidated results and rollout plan.
Deploy gateway v0.4.0 first, then controller. Retain FR002.5 for rollback.
