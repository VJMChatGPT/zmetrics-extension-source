export const RUNTIME_FILES = Object.freeze([
  "manifest.json", "background.js", "popup.js", "popup.html", "window.html", "styles.css",
  "extension-logic.js", "market-data.js", "radar-engine.js", "radar-ui.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png", "icons/zmetrics-logo.png",
  "fonts/manrope-400.ttf", "fonts/manrope-600.ttf", "fonts/OFL.txt"
]);
export const RELEASE_FILES = Object.freeze([...RUNTIME_FILES].sort());
export const SOURCE_FILES = Object.freeze([...RELEASE_FILES, "COPYRIGHT.txt", "NOTICE", "THIRD_PARTY_NOTICES.md", "docs/LICENSING.md", "docs/store-verification.json", "scripts/verify-store.js", "scripts/verify-store.test.js", "scripts/verify-crx.js",
  ".gitignore", ".gitattributes", ".github/workflows/validate.yml", "package.json", "README.md",
  "SECURITY.md", "PRIVACY.md", "CHANGELOG.md", "CONTRIBUTING.md",
  "background.test.js", "zmetrics-extension.test.js", "market-data.test.js", "popup.test.js",
  "radar-engine.test.js", "radar-ui.test.js", "scripts/build-release.test.js",
  "scripts/release-files.js", "scripts/build-release.js", "scripts/check-source.js",
  "scripts/zip.js", "scripts/verify-reference.js", "scripts/verify-release.js",
  "docs/RELEASING.md", "docs/release-reference.json", "docs/screenshots/popup.png", "docs/screenshots/radar.png"
].sort());
export const PRODUCTION_CSP = "script-src 'self'; object-src 'none'; connect-src https://api.coingecko.com; img-src 'self' https://assets.coingecko.com https://coin-images.coingecko.com; style-src 'self'; font-src 'self'";
