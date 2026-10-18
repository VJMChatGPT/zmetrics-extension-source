# Reproducing and verifying published v1.4.8

This is Public Source Code for Transparency — All Rights Reserved. Technical
instructions do not grant copying/execution/redistribution rights; see COPYRIGHT.txt.

## Independent build

Use only this source directory and Node 24.13.1 (no npm install or environment file).
On a fresh authorized copy run `npm run check`, `npm test`, `npm run package`,
`node scripts/verify-release.js`, then `npm run verify:reference -- dist/extension`.
Build a second fresh copy the same way and compare ZIP, FILES.sha256, SOURCE.sha256,
SHA256SUMS and release.json. The ZIP is deterministic (sorted stored entries, fixed
timestamps), containing exactly 18 files. No private transformations or inputs exist.
Local validation was Windows-only; prepared Linux/Windows CI has not run remotely.

The rebuilt ZIP will not equal the original v5 ZIP container: compression/order/
timestamps differ. Every extracted file equals v5 exactly. Do not re-upload 1.4.8.
Original matching ZIP SHA-256:
`71d184975c8d59a0d229ecbf568826122fa659e8070261445aa6601f65d47918`.
The exact ZIP actually uploaded still requires publisher/upload-record confirmation.

## Store correspondence

1. Obtain the official installed extension from Chrome or a full CRX from Google's
   update service for ID `ipihfpalipjpdoboegoemfhfldcpdeke`. Record URL/time/CRX SHA-256
   and manifest version. Google may deliver a newer version later; never relabel it.
2. For CRX3 run `node scripts/verify-crx.js /absolute/path/package.crx`. This checks
   all archive signatures, extension-ID proof and Chromium's pinned Store publisher
   key. A supported Chrome installation is still recommended for its own validation.
3. Extract the embedded ZIP safely into a fresh directory (CRX3 ZIP offset is
   12 + little-endian uint32 at byte 8). Do not execute the extracted code to compare
   it. Alternatively inspect the Store-installed extension directory without editing it.
4. Run `node scripts/verify-store.js /absolute/path/extracted`. It requires all 18
   payload files, accepts only the exact Google update_url addition in the manifest
   and the recorded `_metadata/verified_contents.json` hash, and rejects unknown files,
   changed permissions or other differences. Locally generated computed_hashes.json
   is not silently ignored: obtain clean Store bytes or review it separately.
5. Archive the evidence and report any exception explicitly. The recorded CRX hash
   and all three signatures were verified on October 18, 2026. Hashes alone do not
   establish where a file came from; signed identity and official retrieval matter.

## Future versions and approval

Freeze production source, scan and build/test it in isolation, review permissions/
privacy/provider terms, then approve the exact ZIP hash. Record the public source
commit, version tag, source/package file hashes and Store upload receipt. After
Store approval verify delivered CRX/payload and publish source tag/release with the
evidence. Never mix unpublished development features into a historical tag.
Do not silently replace this 1.4.8 baseline. Future builds need a separate explicit
inventory/reference review and unused Store version. CI validates only; publication
and the first repository migration require separate owner approval.
