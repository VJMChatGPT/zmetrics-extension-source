# Extension privacy

Prepared October 18, 2026 for the **published 1.4.8 payload** retrieved from Google's
update service and matched against this source. Later Store releases may differ.
The separately operated website has its own [privacy policy](https://zmetrics.net/privacy).
Website visits and user-requested external navigation are separate from extension
market-data processing. Keeping website source private does not remove the duty to
disclose website processing.

## What is stored

| Location | Data | Purpose and lifetime |
| --- | --- | --- |
| `chrome.storage.sync` | `enabledCoinIds`, `customCoins`, `deletedBaseIds`, `coinOrder`, `selectedCurrency` | Restore watchlist, custom IDs/symbols/icon URLs, removed defaults, order and USD/EUR preference. Chrome may synchronize these values across a signed-in profile, subject to Chrome settings. |
| `chrome.storage.local` | True-only keys starting `zmetrics_radar_seen_v1:` containing observation type, asset ID and direction | Remember which semantic Radar observations were viewed. Shared between extension views, not Chrome-synced or transmitted by ZMetrics. No price history, timestamp, account ID or full watchlist snapshot is stored in these keys. They remain until extension data is cleared/removed. |
| `chrome.storage.session` | `zmetrics_floating_window_id` | Find/toggle the floating window during the browser session. Uses `chrome.storage.local` as a fallback when session storage is unavailable. |
| Process memory | Provider responses, shared market cache, current rendered observations | Display quotes and avoid duplicate requests. Not a durable historical price database; lost when the relevant process ends. |

Chrome controls its Sync service, account behavior and retention. A local reset
is not a promise to erase every synced or provider-side copy.

## What leaves the browser

- **Markets:** HTTPS requests to `api.coingecko.com/api/v3/coins/markets` include
  requested asset IDs, quote currency and market-data parameters. The same nonempty
  query includes `bitcoin` for local BTC comparisons, even when BTC is hidden from
  the saved watchlist. It does not silently select BTC. An empty watchlist makes
  no market request. Active views normally refresh on a 60-second interval; requests
  are shared/cached and can also follow manual refresh or preference changes.
- **Search:** submitted search text goes to CoinGecko's `/api/v3/search` endpoint.
  Selected results may become synced custom asset IDs, symbols and image URLs.
- **Images:** coin images are requested from CoinGecko's allowed image hosts,
  `assets.coingecko.com` and `coin-images.coingecko.com`.
- **Ordinary metadata:** providers may receive IP address, browser/network metadata
  and request times. HTTPS protects transport; it does not hide the request from its recipient.
- **Chrome Sync:** Google may process synced preference values under Chrome's settings
  and policies. These preferences are not sent to a ZMetrics backend by this extension.

CoinGecko processes requests under its [privacy policy](https://www.coingecko.com/en/privacy).
ZMetrics does not control CoinGecko or Chrome retention. There are no remote fonts.
Opening the X button or Chrome shortcut settings is a user-requested browser
navigation; the extension does not read the destination page or browsing history.
The destination service may process that visit independently.

## Local processing and access

Radar computes descriptive comparisons on-device from CoinGecko responses. It
sends no observations, read-state, model prompts or watchlist analysis to an AI
provider or ZMetrics server. There is no extension telemetry or marketing tracking.
The extension creates no analytics identifier and reads no page content, tab URLs,
browsing history, cookies, wallet balances, wallet addresses or account credentials.
It declares no content scripts, `tabs` or history permission.
`chrome.tabs.create` is used only to open user-requested destinations and does not
require the `tabs` permission. `chrome.windows` manages the extension's own floating
window and requires no separate `windows` permission.

## Choices, deletion and security

Change or remove assets/preferences in Settings. To clear all extension-owned
storage, use the extension's service-worker developer console while inspecting
this extension:

```js
await chrome.storage.sync.clear();
await chrome.storage.local.clear();
await chrome.storage.session.clear();
```

These commands reset preferences and local read-state; close/reopen the extension
afterward. Removing the extension removes its local data subject to Chrome's
behavior. Consult Chrome settings for Sync deletion; provider logs may require a
separate request. ZMetrics cannot promise deletion from third-party systems.
Anyone with access to your Chrome profile may access extension storage; it is not
a vault. There are no passwords or secret API keys in the package.

For privacy questions contact **support@zmetrics.net**. Do not email credentials
or wallet secrets. Material changes to data handling require a corresponding
source, policy and Store disclosure review before release. Extension use of user
data is limited to its disclosed price-tracking purpose and the Chrome Web Store
User Data Policy, including Limited Use requirements.
