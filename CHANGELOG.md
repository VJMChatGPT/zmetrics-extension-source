# Changelog

## 1.4.8 — published Chrome Web Store reference

Owner reports publication; Google delivered version 1.4.8 on October 18, 2026.
This snapshot records the actual delivered application payload: popup/floating
window, configurable watchlist, USD/EUR, local Smart Market Radar with hidden BTC
benchmark and local read-state. There is no favorite badge or alarms permission.

Source-only notices, tests, standalone deterministic packaging and verification
documentation are added for transparency; they do not change Store runtime bytes.
Later favorite/alarms, attribution and legal-page preparation are excluded.
The retrieval date is not asserted to be the exact publication date.

## Public source release preparation

- Reserved-rights notices and owner identity finalized for transparency publication.
- Standalone build tools handle Windows temporary roots on another volume or a
  junction, while preserving containment and symlink checks. Two regression tests
  added; extension runtime and version unchanged.
- 92 tests, clean builds and reference checks pass on Windows and Linux CI.
- Release checksums bind complete source, deterministic package and Store evidence
  to the exact v1.4.8 source commit. No website/backend or later features are included.
