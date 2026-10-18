import { BASE_COINS, getAllCoins as getAllCoinsLogic, getActiveCoins, escapeMarkup, formatPrice as formatPriceLogic, formatMarketCap as formatMarketCapLogic, formatChange as formatChangeLogic } from "./extension-logic.js";
import { createMarketDataView, marketFreshness, MARKET_REQUEST, MARKET_UPDATED } from "./market-data.js";
import { buildRadarPresentation, nextRadarExpiry, createRadarSeenState } from "./radar-ui.js";

const FALLBACK_ICON = "icons/icon32.png";
const COINGECKO_SEARCH_URL =
  "https://api.coingecko.com/api/v3/search";

// ========= DOM ELEMENTS =========
const list              = document.getElementById("coins-list");
const time              = document.getElementById("update-time");
const refreshBtn        = document.getElementById("refresh-btn");
const settingsBtn       = document.getElementById("settings-btn");
const settingsPanel     = document.getElementById("settings-panel");
const settingsCoins     = document.getElementById("settings-coins");
const settingsClose     = document.getElementById("settings-close-btn");
const searchInput       = document.getElementById("search-input");
const searchBtn         = document.getElementById("search-btn");
const searchResults     = document.getElementById("search-results");
const shortcutDisplay   = document.getElementById("shortcut-display");
const shortcutChangeBtn = document.getElementById("shortcut-change-btn");
const currencySelect    = document.getElementById("currency-select");
const radar             = document.getElementById("radar");
const radarMessage      = document.getElementById("radar-message");
const radarFeature      = document.getElementById("radar-feature");
const radarMore         = document.getElementById("radar-more");
const radarMoreLabel    = document.getElementById("radar-more-label");
const radarExtra        = document.getElementById("radar-extra");
const radarNote         = document.getElementById("radar-note");
const radarContext      = document.getElementById("radar-context");
const radarToggle       = document.getElementById("radar-toggle");
const radarContent      = document.getElementById("radar-content");
const radarNew          = document.getElementById("radar-new");

const zmetricsXLink       = document.getElementById("zmetrics-x-link");
const exclusivePanels     = [
  ...new Set([
    ...Array.from(document.querySelectorAll("[data-exclusive-panel]")),
    settingsPanel
  ])
].filter(Boolean);

// ========= STATE =========
let enabledCoinIds = BASE_COINS.map(c => c.id);
let customCoins    = [];
let deletedBaseIds = [];
let coinOrder      = [];
let selectedCurrency = "usd";
let activePanelId  = null;
let preferencesLoaded = false;
let initialPreferenceChanges = {};
let searchRevision = 0;
let radarLoading = false;
let radarLoadRevision = 0;
let radarExpiryTimer = null;
let radarPresentationKey = "";
let radarExpanded = false;
let radarObservationKeys = [];
const radarSeen = createRadarSeenState({
  read: keys => new Promise((resolve, reject) => chrome.storage.local.get(keys, values => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error("Local display state unavailable")) : resolve(values);
  })),
  write: values => new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error("Local display state unavailable")) : resolve();
  })),
  onChange: unread => {
    const hasNew = !!unread.length;
    radarNew?.classList.toggle("hidden", !hasNew);
    if (radarToggle) {
      radarToggle.dataset.new = String(hasNew);
      radarToggle.setAttribute("aria-label", hasNew ? "Radar, new observations available" : "Radar");
    }
    if (radarMore) radarMore.dataset.new = String(radarObservationKeys.slice(1).some(key => unread.includes(key)));
  }
});
const marketView = createMarketDataView({ request: requestMarkets, onChange: renderTable });

function requestMarkets(currency, ids, force) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: MARKET_REQUEST, currency, ids, force }, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !response?.snapshot) {
        reject(new Error(runtimeError?.message || response?.error || "Market data unavailable"));
      } else {
        resolve(response.snapshot);
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === MARKET_UPDATED && sender.id === chrome.runtime.id) {
    marketView.accept(message.snapshot);
  }
});

function syncMarketQuery() {
  const ids = getActiveCoins(getAllCoins(), enabledCoinIds).map(coin => coin.id);
  marketView.setQuery(selectedCurrency, ids);
}

function applyPreferences(values) {
  if ("enabledCoinIds" in values) enabledCoinIds = Array.isArray(values.enabledCoinIds) ? values.enabledCoinIds : BASE_COINS.map(c => c.id);
  if ("customCoins" in values) customCoins = Array.isArray(values.customCoins) ? values.customCoins : [];
  if ("deletedBaseIds" in values) deletedBaseIds = Array.isArray(values.deletedBaseIds) ? values.deletedBaseIds : [];
  if ("coinOrder" in values) coinOrder = Array.isArray(values.coinOrder) ? values.coinOrder : [];
  if ("selectedCurrency" in values) selectedCurrency = values.selectedCurrency === "eur" ? "eur" : "usd";
  syncCoinOrderWithCurrentCoins();
  if (currencySelect) currencySelect.value = selectedCurrency;
  renderSettingsList();
  syncMarketQuery();
  renderTable();
}

// Both surfaces observe the same preferences; a reorder doesn't fetch prices.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") { radarSeen.receive(changes); return; }
  if (area !== "sync") return;
  const values = Object.fromEntries(Object.entries(changes)
    .filter(([key]) => ["enabledCoinIds", "customCoins", "deletedBaseIds", "coinOrder", "selectedCurrency"].includes(key))
    .map(([key, change]) => [key, change.newValue]));
  if (!Object.keys(values).length) return;
  if (!preferencesLoaded) {
    Object.assign(initialPreferenceChanges, values);
    return;
  }
  applyPreferences(values);
  if (marketView.needsData) void fetchPrices();
});

// ========= HELPERS: COIN LISTS / ORDER =========
function getBaseVisible() {
  return BASE_COINS.filter(c => !deletedBaseIds.includes(c.id));
}

function buildAllCoinsUnordered() {
  return getBaseVisible().concat(customCoins);
}

function syncCoinOrderWithCurrentCoins() {
  const currentIds = buildAllCoinsUnordered().map(c => c.id);

  let cleaned = coinOrder.filter(id => currentIds.includes(id));

  currentIds.forEach(id => {
    if (!cleaned.includes(id)) cleaned.push(id);
  });

  coinOrder = cleaned;
}

function getAllCoins() {
  return getAllCoinsLogic(BASE_COINS, customCoins, deletedBaseIds, coinOrder);
}

// ========= DRAG & DROP FOR SETTINGS LIST =========
let draggedElement = null;

function handleDragStart(e) {
  draggedElement = e.currentTarget;
  draggedElement.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}

function handleDragOver(e) {
  e.preventDefault();
  const target = e.currentTarget;
  if (!draggedElement || draggedElement === target) return;

  const items = Array.from(
    settingsCoins.querySelectorAll(".settings-coin-item")
  );
  const draggingIndex = items.indexOf(draggedElement);
  const targetIndex   = items.indexOf(target);

  if (draggingIndex < targetIndex) {
    settingsCoins.insertBefore(draggedElement, target.nextSibling);
  } else {
    settingsCoins.insertBefore(draggedElement, target);
  }
}

function handleDragEnd() {
  if (!draggedElement) return;
  draggedElement.classList.remove("dragging");

  const items = Array.from(
    settingsCoins.querySelectorAll(".settings-coin-item")
  );
  coinOrder = items.map(it => it.dataset.id);

  chrome.storage.sync.set(
    { coinOrder },
    () => {
      renderTable();
    }
  );

  draggedElement = null;
}

function setActivePanel(panelId) {
  activePanelId = panelId;

  exclusivePanels.forEach((panel) => {
    const shouldShow = panel.id === activePanelId;
    panel.classList.toggle("hidden", !shouldShow);
  });
}

function togglePanel(panelId) {
  if (!panelId) return;
  const nextPanelId = activePanelId === panelId ? null : panelId;
  setActivePanel(nextPanelId);
}

// ========= INIT =========
document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(
    {
      enabledCoinIds: BASE_COINS.map(c => c.id),
      customCoins: [],
      deletedBaseIds: [],
      coinOrder: [],
      selectedCurrency: "usd"
    },
    (res) => {
      applyPreferences({ ...res, ...initialPreferenceChanges });
      initialPreferenceChanges = {};
      preferencesLoaded = true;
      fetchPrices();
      setInterval(() => fetchPrices(), 60000);

      if (shortcutDisplay && chrome.commands && chrome.commands.getAll) {
        chrome.commands.getAll((commands) => {
          const cmd = commands.find((c) => c.name === "open_window_popup");
          if (cmd && cmd.shortcut) {
            shortcutDisplay.textContent = cmd.shortcut;
          } else {
            shortcutDisplay.textContent = "Ctrl + Shift + Z / Command + Shift + Z";
          }
        });
      }
    }
  );
});

// ========= EVENT LISTENERS =========
// Refresh
if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    refreshBtn.classList.add("spin");
    fetchPrices(true).finally(() => {
      setTimeout(() => refreshBtn.classList.remove("spin"), 600);
    });
  });
}

// Settings toggle
if (settingsBtn && settingsPanel) {
  settingsBtn.addEventListener("click", () => {
    togglePanel(settingsPanel?.id);
  });
}

if (settingsClose && settingsPanel) {
  settingsClose.addEventListener("click", () => {
    setActivePanel(null);
  });
}

// Search coins
if (searchBtn) {
  searchBtn.addEventListener("click", () => {
    const q = searchInput.value.trim();
    if (q.length < 2) {
      searchRevision++;
      searchResults.innerHTML =
        `<div class="search-info">Type at least 2 characters.</div>`;
      return;
    }
    searchCoins(q);
  });
}

if (searchInput) {
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchBtn.click();
    }
  });
}

// Shortcut change: opens Chrome shortcut settings
if (shortcutChangeBtn) {
  shortcutChangeBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}

// Currency selector
if (currencySelect) {
  currencySelect.addEventListener("change", () => {
    selectedCurrency = currencySelect.value === "eur" ? "eur" : "usd";
    syncMarketQuery();
    void fetchPrices();
    chrome.storage.sync.set({
      selectedCurrency
    });
  });
}

if (zmetricsXLink) {
  zmetricsXLink.addEventListener("click", () => {
    chrome.tabs.create({
      url: "https://x.com/zmetrics_net"
    });
  });
}

// ========= PRICE FETCHING =========
function fetchPrices(force = false) {
  syncMarketQuery();
  const revision = ++radarLoadRevision;
  radarLoading = true;
  renderRadar();
  return marketView.refresh(force).finally(() => {
    if (revision === radarLoadRevision) {
      radarLoading = false;
      renderRadar();
    }
  });
}

// ========= SEARCH COINS =========
async function searchCoins(query) {
  const revision = ++searchRevision;
  searchResults.innerHTML = `<div class="search-info">Searching…</div>`;

  try {
    const url =
      COINGECKO_SEARCH_URL + "?query=" + encodeURIComponent(query);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (revision !== searchRevision) return;

    const results = (data.coins || []).slice(0, 10);

    if (results.length === 0) {
      searchResults.innerHTML =
        `<div class="search-info">No coins found for "${query}".</div>`;
      return;
    }

    renderSearchResults(results);
  } catch (err) {
    if (revision !== searchRevision) return;
    console.error("Error searching coins:", err);
    searchResults.innerHTML =
      `<div class="search-info">Error while searching. Please try again.</div>`;
  }
}

function renderSearchResults(results) {
  const allCoins = getAllCoins();
  searchResults.innerHTML = "";

  results.forEach((coin) => {
    const alreadyExists = allCoins.some(c => c.id === coin.id);

    const item = document.createElement("div");
    item.className = "search-result-item";

    const icon = document.createElement("img");
    icon.className = "search-result-icon";
    icon.src = coin.thumb || coin.large || FALLBACK_ICON;
    icon.alt = coin.symbol || "";

    const textWrap = document.createElement("div");
    textWrap.className = "search-result-text";

    const line1 = document.createElement("div");
    line1.className = "search-result-symbol";
    line1.textContent = (coin.symbol || "").toUpperCase();

    const line2 = document.createElement("div");
    line2.className = "search-result-name";
    line2.textContent = coin.name || "";

    textWrap.appendChild(line1);
    textWrap.appendChild(line2);

    const action = document.createElement("div");
    action.className = "search-result-action";

    const btn = document.createElement("button");

    if (alreadyExists) {
      btn.textContent = "Already added";
      btn.disabled = true;
      btn.classList.add("already");
    } else {
      btn.textContent = "Add";
      btn.addEventListener("click", () => {
        addCustomCoinFromSearch(coin);
      });
    }

    action.appendChild(btn);

    item.appendChild(icon);
    item.appendChild(textWrap);
    item.appendChild(action);
    searchResults.appendChild(item);
  });
}

function addCustomCoinFromSearch(coin) {
  const allCoins = buildAllCoinsUnordered();
  if (allCoins.some(c => c.id === coin.id)) return;

  const newCoin = {
    id: coin.id,
    symbol: (coin.symbol || "").toUpperCase(),
    icon: coin.thumb || coin.large || FALLBACK_ICON
  };

  customCoins.push(newCoin);

  if (!enabledCoinIds.includes(newCoin.id)) {
    enabledCoinIds.push(newCoin.id);
  }

  if (!coinOrder.includes(newCoin.id)) {
    coinOrder.push(newCoin.id);
  }

  chrome.storage.sync.set(
    { customCoins, enabledCoinIds, coinOrder },
    () => {
      syncCoinOrderWithCurrentCoins();
      if (currencySelect) {
        currencySelect.value = selectedCurrency;
      }
      renderSettingsList();
      syncMarketQuery();
      fetchPrices();
      searchResults.innerHTML =
        `<div class="search-info">Added ${escapeMarkup(newCoin.symbol)} to your list.</div>`;
    }
  );
}

// ========= REMOVE COIN =========
function removeCoin(id) {
  const isBaseCoin = BASE_COINS.some(c => c.id === id);
  if (isBaseCoin) {
    if (!deletedBaseIds.includes(id)) {
      deletedBaseIds.push(id);
    }
  } else {
    customCoins = customCoins.filter(c => c.id !== id);
  }

  enabledCoinIds = enabledCoinIds.filter(cid => cid !== id);
  coinOrder      = coinOrder.filter(cid => cid !== id);

  chrome.storage.sync.set(
    { ...(isBaseCoin ? { deletedBaseIds } : { customCoins }), enabledCoinIds, coinOrder },
    () => {
      syncCoinOrderWithCurrentCoins();
      if (currencySelect) {
        currencySelect.value = selectedCurrency;
      }
      renderSettingsList();
      syncMarketQuery();
      renderTable();
    }
  );
}

// ========= RENDER MAIN TABLE =========
function renderTable() {
  list.innerHTML = "";

  const allCoins   = getAllCoins();
  const activeList = getActiveCoins(allCoins, enabledCoinIds);
  renderRadar();

  if (activeList.length === 0) {
    list.innerHTML =
      `<div class="zm-empty">No assets selected. Open settings to choose what to track.</div>`;
    time.textContent = "";
    return;
  }

  const snapshot = marketView.snapshot;
  if (!snapshot && marketView.error) {
    list.innerHTML = `<div class="zm-error">Error loading prices. Please try again.</div>`;
    time.textContent = "";
    return;
  }

  activeList.forEach((coin) => {
    const m = snapshot?.markets[coin.id];
    const price  = m?.price ?? null;
    const mcap   = m?.marketCap ?? null;
    const change = m?.change24h ?? null;

    const row = document.createElement("div");
    row.className = "zm-row";

    const direction =
      typeof change === "number"
        ? change > 0
          ? "up"
          : change < 0
          ? "down"
          : "flat"
        : "flat";

    const iconUrl = (coin.icon || m?.image || FALLBACK_ICON);

    row.innerHTML = `
      <div class="cell-asset">
        <img class="coin-icon" src="${escapeMarkup(iconUrl)}" alt="${escapeMarkup(coin.symbol)}">
        <div class="coin-text">
          <div class="coin-symbol">${escapeMarkup(coin.symbol)}</div>
        </div>
      </div>

      <div class="cell-marketcap">
        ${mcap != null ? formatMarketCap(mcap) : "-"}
      </div>

      <div class="cell-price">
        ${price != null ? formatPrice(price) : "-"}
      </div>

      <div class="cell-change ${direction}">
        ${formatChange(change)}
      </div>
    `;

    list.appendChild(row);
  });

  const updatedAt = marketFreshness(snapshot, activeList.map(coin => coin.id));
  time.textContent = marketView.error
    ? "Error updating. Showing last available data."
    : updatedAt === null ? "" : "Updated: " + new Date(updatedAt).toLocaleTimeString();
}

// ========= RENDER RADAR =========
// One shared tooltip per view, outside normal flow so popup height stays compact.
const radarHelpDocument = document;
const radarHelp = document.createElement("span");
radarHelp.id = "radar-pp-tooltip";
radarHelp.className = "radar-metric-tooltip";
radarHelp.setAttribute("role", "tooltip");
radarHelp.textContent = "pp = percentage points. The difference between two percentage changes. For example, +11% vs +3% = +8 pp.";
radarHelp.hidden = true;
radar?.appendChild(radarHelp);
let radarHelpAnchor = null;
let radarHelpHovered = false;
let radarHelpTimer = null;

function hideRadarHelp() {
  clearTimeout(radarHelpTimer);
  radarHelp.hidden = true;
  radarHelpAnchor = null;
  radarHelpHovered = false;
}

function positionRadarHelp() {
  if (!radarHelpAnchor) return;
  const anchor = radarHelpAnchor.getBoundingClientRect();
  const tip = radarHelp.getBoundingClientRect();
  const { clientWidth: width, clientHeight: height } = radarHelpDocument.documentElement;
  const clamp = (value, max) => Math.max(8, Math.min(value, max - 8));
  radarHelp.style.left = `${clamp(anchor.right - tip.width, width - tip.width)}px`;
  const below = anchor.bottom + 6;
  radarHelp.style.top = `${clamp(below + tip.height <= height - 8 ? below : anchor.top - tip.height - 6, height - tip.height)}px`;
}

function showRadarHelp(anchor) {
  clearTimeout(radarHelpTimer);
  radarHelpAnchor = anchor;
  radarHelp.hidden = false;
  positionRadarHelp();
}

function scheduleRadarHelpHide() {
  clearTimeout(radarHelpTimer);
  // Allow moving the pointer onto the tooltip; keyboard focus keeps it open.
  radarHelpTimer = setTimeout(() => {
    if (!radarHelpHovered && radarHelpDocument.activeElement !== radarHelpAnchor) hideRadarHelp();
  }, 120);
}

radarHelp.addEventListener("mouseenter", () => { radarHelpHovered = true; clearTimeout(radarHelpTimer); });
radarHelp.addEventListener("mouseleave", () => { radarHelpHovered = false; scheduleRadarHelpHide(); });
radarHelpDocument.addEventListener("keydown", event => {
  if (event.key === "Escape" && radarHelpAnchor) {
    hideRadarHelp();
    event.preventDefault();
    event.stopPropagation();
  }
});
radarHelpDocument.addEventListener("scroll", positionRadarHelp, true);
radarHelpDocument.defaultView?.addEventListener("resize", positionRadarHelp);

function updateRadarDisclosureLabel() {
  const count = Number(radarMore.dataset.count) || 0;
  radarMoreLabel.textContent = radarMore.open ? "Show fewer observations"
    : `Show ${count} more observation${count === 1 ? "" : "s"}`;
}

function updateRadarSeen() {
  const visible = !radarExpanded || document.visibilityState === "hidden" ? []
    : radarMore.open ? radarObservationKeys : radarObservationKeys.slice(0, 1);
  radarSeen.update(radarObservationKeys, visible);
}
document.addEventListener("visibilitychange", () => {
  updateRadarSeen();
  if (radarHelpDocument.visibilityState === "hidden") hideRadarHelp();
});
if (radarMore) radarMore.addEventListener("toggle", () => {
  hideRadarHelp();
  updateRadarDisclosureLabel();
  updateRadarSeen();
});
if (radarToggle) radarToggle.addEventListener("click", () => {
  hideRadarHelp();
  radarExpanded = !radarExpanded;
  radarToggle.setAttribute("aria-expanded", String(radarExpanded));
  radarContent.classList.toggle("hidden", !radarExpanded);
  updateRadarSeen();
});

function renderRadar() {
  if (!radar) return;
  clearTimeout(radarExpiryTimer);
  const coins = getActiveCoins(getAllCoins(), enabledCoinIds);
  const now = Date.now();
  let presentation;
  try {
    presentation = buildRadarPresentation({
      snapshot: marketView.snapshot, coins, now, error: marketView.error,
      loading: radarLoading && (marketView.needsData || !!marketView.error)
    });
    const expiry = nextRadarExpiry(marketView.snapshot, coins, now);
    if (expiry !== null) radarExpiryTimer = setTimeout(renderRadar, expiry - now);
  } catch {
    // Radar must never break price rendering or watchlist interactions.
    presentation = { status: "error", message: "Radar is temporarily unavailable.", note: "", observations: [] };
  }
  radar.dataset.state = presentation.status;
  radar.setAttribute("aria-busy", String(presentation.status === "loading"));
  radarContext.textContent = radarLoading && coins.length ? "Updating" : "24h";
  radarObservationKeys = presentation.observations.map(observation => observation.seenKey);
  updateRadarSeen();
  const key = JSON.stringify(presentation);
  if (key === radarPresentationKey) return;
  hideRadarHelp();
  radarPresentationKey = key;
  radarMessage.textContent = presentation.message;
  radarMessage.classList.toggle("hidden", !presentation.message);
  radarNote.textContent = presentation.note;
  radarNote.classList.toggle("hidden", !presentation.note);
  radarFeature.innerHTML = "";
  radarExtra.innerHTML = "";
  const [featured, ...extra] = presentation.observations;
  radarFeature.classList.toggle("hidden", !featured);
  const appendObservation = (container, observation) => {
    container.dataset.tone = observation.tone;
    const top = document.createElement("div");
    top.className = "radar-observation-top";
    const headline = document.createElement("p");
    headline.className = "radar-headline";
    headline.textContent = observation.headline;
    const metric = document.createElement("p");
    metric.className = "radar-metric";
    metric.textContent = observation.metric;
    metric.setAttribute("title", observation.metricLabel);
    // Visible units stay compact; assistive text spells out pp vs percent.
    const metricMeaning = document.createElement("span");
    metricMeaning.className = "radar-sr-only";
    metricMeaning.textContent = ` (${observation.metricLabel})`;
    metric.appendChild(metricMeaning);
    if (observation.metric.endsWith(" pp")) {
      // Avoid competing native title tooltips on the focusable help control.
      metric.removeAttribute("title");
      const help = document.createElement("button");
      help.type = "button";
      help.className = "radar-metric-help";
      help.textContent = "ⓘ";
      help.setAttribute("aria-label", "About percentage points");
      help.setAttribute("aria-describedby", radarHelp.id);
      help.addEventListener("mouseenter", () => { radarHelpHovered = true; showRadarHelp(help); });
      help.addEventListener("mouseleave", () => { radarHelpHovered = false; scheduleRadarHelpHide(); });
      help.addEventListener("focus", () => showRadarHelp(help));
      help.addEventListener("blur", scheduleRadarHelpHide);
      metric.appendChild(help);
    }
    const detail = document.createElement("p");
    detail.className = "radar-detail";
    detail.textContent = observation.detail;
    top.appendChild(headline);
    top.appendChild(metric);
    container.appendChild(top);
    container.appendChild(detail);
  };
  if (featured) {
    appendObservation(radarFeature, featured);
  }
  for (const observation of extra) {
    const item = document.createElement("li");
    appendObservation(item, observation);
    radarExtra.appendChild(item);
  }
  radarMore.classList.toggle("hidden", !extra.length);
  if (!extra.length) radarMore.open = false;
  radarMore.dataset.count = String(extra.length);
  updateRadarDisclosureLabel();
}

// ========= RENDER SETTINGS LIST =========
function renderSettingsList() {
  settingsCoins.innerHTML = "";

  const allCoins = getAllCoins();

  allCoins.forEach((coin) => {
    const wrapper = document.createElement("div");
    wrapper.className = "settings-coin-item";
    wrapper.dataset.id = coin.id;
    wrapper.draggable = true;

    wrapper.addEventListener("dragstart", handleDragStart);
    wrapper.addEventListener("dragover", handleDragOver);
    wrapper.addEventListener("dragend", handleDragEnd);

    const main = document.createElement("label");
    main.className = "settings-coin-main";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = coin.id;
    input.checked = enabledCoinIds.includes(coin.id);
    input.addEventListener("change", onToggleCoin);

    const icon = document.createElement("img");
    icon.src = coin.icon || FALLBACK_ICON;
    icon.alt = coin.symbol;
    icon.className = "settings-coin-icon";

    const text = document.createElement("span");
    text.textContent = coin.symbol;

    main.appendChild(input);
    main.appendChild(icon);
    main.appendChild(text);
    wrapper.appendChild(main);

    const controls = document.createElement("div");
    controls.className = "settings-coin-controls";

    const dragHandle = document.createElement("div");
    dragHandle.className = "settings-coin-drag-handle";
    dragHandle.textContent = "⋮⋮";
    dragHandle.title = "Drag to reorder";

    const delBtn = document.createElement("button");
    delBtn.className = "settings-coin-delete";
    delBtn.textContent = "✕";
    delBtn.title = "Remove from list";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      removeCoin(coin.id);
    });

    controls.appendChild(dragHandle);
    controls.appendChild(delBtn);

    wrapper.appendChild(controls);
    settingsCoins.appendChild(wrapper);
  });
}

function onToggleCoin(e) {
  const id = e.target.value;
  const checked = e.target.checked;

  if (checked) {
    if (!enabledCoinIds.includes(id)) enabledCoinIds.push(id);
  } else {
    enabledCoinIds = enabledCoinIds.filter(cid => cid !== id);
  }

  chrome.storage.sync.set(
    { enabledCoinIds },
    () => {
      syncMarketQuery();
      renderTable();
      if (marketView.needsData) void fetchPrices();
    }
  );
}

// ========= FORMAT HELPERS =========
function formatPrice(value) {
  return formatPriceLogic(value, selectedCurrency);
}

function formatMarketCap(value) {
  return formatMarketCapLogic(value, selectedCurrency);
}

function formatChange(change) {
  return formatChangeLogic(change);
}
