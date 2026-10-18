import { analyzeWatchlist, RADAR_DEFAULTS } from "./radar-engine.js";
import { formatChange } from "./extension-logic.js";
import { BTC_BENCHMARK_ID } from "./market-data.js";

// Presentation only: engine facts remain unrounded; text is safely rendered with
// textContent. No Chrome APIs, fetching or threshold overrides here.
function observationText(observation, symbols) {
  const symbol = symbols.get(observation.assetId) || observation.assetId;
  const pp = value => `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2)} pp`;
  switch (observation.type) {
    case "btc-relative":
      return {
        headline: `${symbol} ${observation.gapPp > 0 ? "outpaces" : "trails"} BTC`,
        metric: pp(observation.gapPp),
        metricLabel: "24h change gap vs BTC, in percentage points",
        detail: `24h: ${symbol} ${formatChange(observation.change24h)} · BTC ${formatChange(observation.btcChange24h)}`,
        tone: observation.gapPp > 0 ? "up" : "down"
      };
    case "peer-divergence":
      return {
        headline: `${symbol} ${observation.gapPp > 0 ? "above" : "below"} peers`,
        metric: pp(observation.gapPp),
        metricLabel: "24h change gap vs other assets’ equal-weight average, in percentage points",
        detail: `Other assets’ equal-weight 24h avg: ${formatChange(observation.peersAverage24h)}`,
        tone: observation.gapPp > 0 ? "up" : "down"
      };
    case "strongest-performer":
    case "weakest-performer":
      return {
        headline: `${symbol} ${observation.type === "strongest-performer" ? "leads" : "trails"} watchlist`,
        metric: formatChange(observation.change24h),
        metricLabel: "Asset’s 24h price change, in percent",
        detail: `Watchlist equal-weight 24h avg: ${formatChange(observation.averageChange24h)}`,
        tone: observation.change24h > 0 ? "up" : observation.change24h < 0 ? "down" : "flat"
      };
    case "watchlist-move":
      return {
        headline: "Watchlist average",
        metric: formatChange(observation.averageChange24h),
        metricLabel: "Watchlist’s equal-weight average 24h change, in percent; not portfolio return",
        detail: `Equal-weight 24h average · ${observation.assetCount} assets`,
        tone: observation.averageChange24h > 0 ? "up" : "down"
      };
    default: return null;
  }
}

export function buildRadarPresentation({ snapshot, coins, now, loading = false, error = null }) {
  const state = (status, message) => ({ status, message, note: "", observations: [] });
  if (!coins.length) return state("empty", "Choose assets to see watchlist observations.");
  if ((!snapshot && !error) || loading) {
    return state("loading", "Reading your market data…");
  }
  if (error) return state("error", "Couldn’t refresh market data. Try the refresh button.");
  const result = analyzeWatchlist(snapshot, coins.map(coin => coin.id), { now });
  if (result.status === "empty") return state("empty", "Choose assets to see watchlist observations.");
  const issues = [...result.coverage.excluded, result.coverage.benchmark];
  const stale = issues.some(issue => issue.reason === "stale-snapshot" || issue.reason === "stale-market");
  if (result.status === "insufficient-data") {
    return stale ? state("stale", "Market data is too old for Radar. Refresh to update.")
      : state("insufficient-data", "Not enough fresh, comparable data for Radar yet.");
  }
  if (result.status === "quiet") {
    const quiet = state("quiet", "No notable differences in your watchlist right now.");
    if (result.coverage.benchmark.reason) quiet.note = "BTC comparison unavailable.";
    return quiet;
  }
  const symbols = new Map(coins.map(coin => [coin.id, coin.symbol || coin.id]));
  return {
    status: "observations", message: "",
    note: !result.coverage.complete ? "Some assets lack fresh data; showing available comparisons."
      : result.coverage.benchmark.reason ? "BTC comparison unavailable."
      : !result.coverage.coherent ? "Watchlist-wide comparisons unavailable." : "",
    observations: result.observations.map(observation => {
      const text = observationText(observation, symbols);
      return text && { ...text, seenKey: radarSeenKey(observation) };
    }).filter(Boolean)
  };
}

// Semantic UI state, not market history or a user identifier. Price/timestamp,
// currency, rank ordering and label changes deliberately do not produce alerts.
// Separate true-only local keys avoid read/modify/write races between surfaces.
export const RADAR_SEEN_PREFIX = "zmetrics_radar_seen_v1:";
export function radarSeenKey(observation) {
  return RADAR_SEEN_PREFIX + JSON.stringify([
    observation.type, observation.assetId || "",
    observation.direction || Math.sign(observation.change24h)
  ]);
}

// Injected persistence keeps browser access in popup.js and failures out of Radar.
// Only current observation keys are read; no scan of other extension storage.
export function createRadarSeenState({ read, write, onChange }) {
  const known = new Set(), seen = new Set(), pending = new Set();
  let keys = [], visible = [], unavailable = false;
  function reconcile() {
    if (unavailable) { onChange([]); return; }
    const viewed = visible.filter(key => known.has(key) && !seen.has(key));
    if (viewed.length) {
      viewed.forEach(key => seen.add(key));
      Promise.resolve().then(() => write(Object.fromEntries(viewed.map(key => [key, true]))))
        .catch(() => { unavailable = true; onChange([]); });
    }
    onChange(keys.filter(key => known.has(key) && !seen.has(key)));
  }
  return {
    update(nextKeys, visibleKeys = []) {
      keys = [...new Set(nextKeys)];
      visible = visibleKeys.filter(key => keys.includes(key));
      const missing = keys.filter(key => !known.has(key) && !pending.has(key));
      if (missing.length && !unavailable) {
        missing.forEach(key => pending.add(key));
        Promise.resolve().then(() => read(missing)).then(values => {
          missing.forEach(key => {
            pending.delete(key); known.add(key);
            if (values?.[key] === true) seen.add(key);
          });
          reconcile();
        }, () => { unavailable = true; onChange([]); });
      }
      reconcile();
    },
    receive(changes) {
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith(RADAR_SEEN_PREFIX) && change.newValue === true) {
          known.add(key); seen.add(key);
        }
      }
      reconcile();
    }
  };
}

// Local expiry scheduling keeps a frozen/open/offline view honest without polling
// more often or making any requests. The engine's inclusive age limit expires +1ms.
export function nextRadarExpiry(snapshot, coins, now) {
  if (!snapshot || !coins.length) return null;
  const times = [snapshot.fetchedAt, ...[...coins.map(coin => coin.id), BTC_BENCHMARK_ID]
    .map(id => snapshot.markets?.[id]?.updatedAt)];
  const deadlines = times.filter(value => Number.isFinite(value) && value >= 0)
    .map(value => value + RADAR_DEFAULTS.maxDataAgeMs + 1).filter(value => value > now);
  return deadlines.length ? Math.min(...deadlines) : null;
}
