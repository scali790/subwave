# Touch feedback undo contract

25 October 2026. Additive House-Control capability; no public/admin deletion proxy.

- A like receipt identifies one apparent listener's exact airing record. Undo
  removes that record only, preserving other listeners, operator likes and stars.
  New listener records have a random revision, so an old receipt cannot remove
  a later re-like even if timestamps happen to coincide.
- A Never-Play receipt is issued only when this House-Control action creates a
  new exact-track block. A random revision survives restart. Undo compares this
  revision; replacement/admin/artist/album/rule blocks are never removed.
- Receipts are AES-256-GCM sealed using a domain-separated key derived from the
  existing House-Control secret. No raw track ID in the browser, no extra secret.
  Expire after 30 minutes; action type bound; reject tampering and oversized data.
- Authenticated fixed POST `/house-control/undo-feedback` accepts only action and
  opaque receipt. No caller-selectable ID/type/URL. Undo can target the receipted
  previous track after a skip; it never changes the on-air track or sends a skip.
- Replayed completed undo is idempotent; an intervening new like/block is not
  removed. No Navidrome unstar on listener undo. Restore eligibility, not queue history.
- Existing APIs remain compatible. Deployment/rebuild is a separate production
  step; tests use isolated state, never real listener/library mutations.

Validation: focused store and real HTTP-route tests pass, including wrong/missing
authorization, action mismatch, changed block, idempotent repeat and later re-like.
TypeScript passes; full ESLint has zero errors and 788 warnings. The full Windows
suite ran 273 files (1775 pass, 73 fail, one skipped); all 28 failing files also fail
on unchanged `bf5eb905` with the same Node 22.23.4 / SQLite 11.10.0 dependencies.
This is not a clean full-suite result. Target any PR at `develop`, never `main`.
