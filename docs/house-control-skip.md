# House-Control shared-stream Skip

GET /house-control/skip-current?songId=... and POST /house-control/skip-current with {songId} require the existing HOUSE_CONTROL_TOKEN bearer. No admin credentials reach the touch client. These routes remain blocked at the external radio.local edge by the existing /api/house-control* deny rule.

Skip calls the same queue.commitBeforeSkip() then skipTrack() sequence as admin /dj/skip, with expected-song checks before and after preparation and an in-flight lock for house skips. It affects all listeners of the shared stream. It neither likes nor blocks a song. Status never writes; failures never retry. The preparation can take twenty seconds, plus client buffering before audible change.

Tests: controller/scripts/house-skip-current.test.ts. Pure equivalent checks passed locally. Full controller lint/typecheck/test suite and container integration remain required before production deployment. No real skip executed. Companion Music Proxy change is required; deploy this narrowly scoped capability first, then Music Proxy, then the isolated Pi 5 touch client. Existing admin Skip remains unchanged. No automatic deployment or release-branch merge is authorised by this candidate.
