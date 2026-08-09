# Changelog

Format: one entry per meaningful deploy, tagged with the version that matches
`sw.js`'s `CACHE` constant, so "what code is this device running" is always
answerable by comparing the tag to the version shown in that file.

## v15 — 2026-08-08

- Fixed service worker offline cache: precached paths were absolute
  (`/index.html`), resolving to the wrong origin on this subpath-hosted site.
  Switched to relative paths — offline support had likely been silently
  broken this entire time.
- Extracted per-base config into `baseConfig.js` (Firebase project, VAPID
  key, PINs, crew car roster, aircraft fleet, address, company name) —
  first step of the multi-base (YAV/YQT/YXL) rollout. No behavior change
  for YKF; verified locally and against the live URL before and after push.
- Made all 7 audit "mark as done" flows wait for their PDF upload to finish
  and show a visible "Saving PDF…" state, instead of silently continuing
  while the upload runs unguarded in the background.
- Added a self-healing pass that runs at boot: checks every current-month
  audit for "done but missing a PDF" and silently backfills it.
- Fixed a real, separate bug found while building the above: `loadCarAudits()`
  ran before Firebase initialized, so cars never got live cross-device sync.
- Added "Share all" — bundles every saved audit + a freshly-built flagged-
  items summary into real PDFs (via html2canvas + jsPDF, with manual page
  slicing since jsPDF's own pagination badly over-estimated page count) and
  hands them to the device's native share sheet.
- Fixed facility PDF logos using a relative URL that only resolved when
  printed directly from the app, not when opened from Records.
- Wrote and tested (21/21 checks passing against a real staging project)
  `firestore.rules` and `storage.rules` — not yet applied to any production
  project. See `project_multibase_rollout` memory for full detail.

## Earlier (pre-changelog)

Everything before this point — the August 5 data-loss incident and its
fix (permanent per-month audit docs, no more automatic wiping), lock-on-done,
auto-PDF-to-records, the Records rebuild, and the initial PDF/Storage path
fixes — happened without formal version tags. See `project_audit_status_states`
memory for that history.
