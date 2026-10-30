# Starting the scheduled programme after an idle pause

This change is a source candidate, not permission to deploy or restart a station.
The controller and broadcast changes must be reviewed together.

## Behaviour

The existing `stream.idleWhenEmpty` / `stream.idleAfterMinutes` settings still
control the listener-free pause. A short pause within the same programme
continues the frozen track. A changed station-local date or show, at least
30 minutes of pause, a backwards clock, or unknown recovered idle state instead
requires a fresh scheduled start.

Before opening the gate the controller archives the old editorial session,
starts with current station time and a new host-speech revision, rebuilds the
current show's fallback playlist, and publishes its first track. It removes
the old queue and unaired speech/handoff files. Old queued publication callbacks
are invalidated. The watcher and normal drain stay held until the mixer
acknowledges a resolved new request and release.

`idle_reset` and `idle_resume_fresh` clear old music, speech, SFX and manual-jingle
queues and skip the actual frozen music source, not the blank idle source.
Icecast outputs and processes stay up. Preparation failure, an older mixer, or
another show boundary during preparation leaves the gate closed and retries.
An error is logged without a source URI or credentials.

Fresh restart deliberately drops old queued requests, queued programme blocks
and rendered moderation. Track bans, settings and recorded play history remain. First music comes from the current
show's filtered auto-playlist; waking does not require a model call. Normal DJ
work resumes afterwards. Slow library/media resolution can delay this start.
The 30-minute policy is a code constant, not a new user setting.

## Isolated validation

```sh
cd controller
npm ci
npm test -- idle-resume
npm run lint
npm test
cd ..
python3 scripts/test-idle-programme-audio.py --output /tmp/subwave-idle-audio
```

Regressions use an injected clock: Friday 22:00 to Saturday 08:00 in
Europe/Zurich, the real settings resolver and session reset, short/long
same-show pauses, unknown recovery, preparation failure and another boundary
during preparation. Queue tests exercise actual files and cancellation of an
old queued speech publication and an in-flight old now-playing read.

The audio test runs only network-disabled Liquidsoap 2.4.5 containers. Synthetic
evening music, a queued evening title and speech reproduce the defect in the
unchanged frozen-resume baseline. The candidate includes the actual production
`idle-resume.liq` commands: evening tones must disappear and the morning tone
must become audible. [Measured baseline/candidate amplitudes](idle-programme-audio-results.json).
No live station, paid model call or host-clock change.

## Future deployment and rollback — separate approval

Both baked images change. Installing only the new controller is insufficient:
an older mixer rejects fresh-reset commands, leaving a long resume silent.
Validate the broadcast first, then install the reviewed matching pair in an
approved maintenance window via the canonical production procedure. Dev compose
mounts both Liquidsoap files; broadcast and AIO Dockerfiles copy both into
`/etc/liquidsoap`. The embedded CLI dev-compose asset is regenerated as well.

Keep the previous controller/broadcast image digests and state backup. Rollback
uses the matching previous pair. Idle settings are not migrated by this code.
Physical Verbatim Start/Stop, reconnect and audible programme acceptance remain
separate deployment gates. Nothing in these instructions is executed by tests.

## Local validation environment

Tests use Linux Node 22.23.2/Python 3.11 containers on Legion. Source is copied
into the disposable Linux filesystem with LF endings; Windows CRLF shell files
are not valid Linux test inputs. NumPy 2.3.5 is supplied as an offline test wheel
before the network-disabled suite starts; it is not a radio dependency change.
The initial suite exposed two unrelated test-fixture races: a fake Piper exiting
without consuming stdin (EPIPE) and an elapsed-time assertion comparing live
millisecond clocks. Their fixtures now consume stdin and freeze the test clock.
The unchanged develop baseline passes the affected 37 tests when those races do
not occur. No production Piper change is included here.

Broadcast image `local/subwave-broadcast-idle:20261030` was actually built and
the full production Liquidsoap script passed its syntax check with Liquidsoap
2.4.5. The AIO include path is updated and audited; a full AIO image build and
native ARM64 runtime acceptance were not performed in this preparation.

Final local receipt (2026-10-30): full controller suite **1872/1872 PASS**,
including **16 idle-resume regressions**. ESLint/TypeScript PASS with zero errors
and 788 existing warnings. Actual baseline/candidate audio regression PASS.
Paired Verbatim draft: https://github.com/scali790/raspy-homelab/pull/312.
