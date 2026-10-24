# House-Control shared-stream Skip

GET /house-control/skip-current?songId=... and POST /house-control/skip-current with {songId} require the existing HOUSE_CONTROL_TOKEN bearer. No admin credentials reach the touch client. Routes remain blocked at the external radio.local edge by the existing /api/house-control* deny rule.

Skip uses the same queue.commitBeforeSkip() then skipTrack() sequence as admin /dj/skip, with expected-song checks before/after preparation and an in-flight lock. It affects all listeners and neither likes nor blocks a song. Status never writes; failures never retry. Preparation can take twenty seconds, plus client buffering before audible change.

## Completed isolated verification

- Full controller lint and TypeScript check passed (zero errors, 784 existing warnings).
- Application image built on the exact installed TTS runtime base; locked dependencies installed, development packages pruned. This is an application build, not a new download/rebuild of unchanged TTS/model assets.
- Authenticated HTTP tests passed against the actual application image with a fake loopback mixer: bad/missing bearer, absent configuration, read-only status, stale song, valid one-command skip, duplicate requests and a song change during preparation.
- Full suite completed: 271 files, 1,829 checks, 1,784 passed and 45 failed. The suite is not green. All observed failures were reproduced without this change: 44 baseline failures in CRLF-sensitive text/shell tests and Python setup, plus one 1-ms clock-sensitive queue forecast assertion reproduced on both base and candidate.
- Actual running controller source comparison differs only in routes/house-control.ts and new skip-current.ts; no dependency version changes.

Detailed provenance, checks, Dockerfile and reproducible HTTP check scripts are in [companion PR #287](https://github.com/scali790/raspy-homelab/pull/287), docs/changes/evidence/family-radio-skip/. The new discoverable controller/scripts/house-skip-current.test.ts also passes.

## Production boundary

Draft candidate only: no live Skip, rating, block, deployment or restart. Existing full-suite failures remain unresolved. Deploy this narrow capability before the companion Music Proxy and isolated Pi 5 overlay, only after review and separate production approval. The existing admin Skip is unchanged. Actual audible Skip acceptance is still pending.
