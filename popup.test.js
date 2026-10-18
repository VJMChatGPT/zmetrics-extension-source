import test from "node:test";
import assert from "node:assert/strict";
import { createMarketDataService, MARKET_REQUEST, MARKET_UPDATED } from "./market-data.js";
import { buildRelease } from "./scripts/build-release.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Minimal DOM/Chrome harness: import the real popup module used by BOTH HTML
// surfaces. No browser, framework or production dependency is required.
class Element {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.rect = { top: 350, bottom: 360, right: 380, width: 270, height: 68 };
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, show) { if (show) classes.add(name); else classes.delete(name); }
    };
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ""; }
  appendChild(child) { this.children.push(child); }
  querySelectorAll(selector) { return this.children.filter(child => `.${child.className}` === selector); }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  getBoundingClientRect() { return this.rect; }
  dispatch(name, values = {}) {
    for (const listener of this.listeners.get(name) || []) {
      listener({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...values });
    }
  }
  click() { this.dispatch("click"); }
}

function makeDocument() {
  const elements = new Map([
    "coins-list", "update-time", "refresh-btn", "settings-btn", "settings-panel",
    "settings-coins", "settings-close-btn", "search-input", "search-btn", "search-results",
    "shortcut-display", "shortcut-change-btn", "currency-select", "zmetrics-x-link",
    "radar", "radar-message", "radar-feature", "radar-more", "radar-more-label", "radar-extra", "radar-note", "radar-context",
    "radar-toggle", "radar-content", "radar-new"
  ].map(id => [id, new Element(id)]));
  elements.get("radar-toggle").setAttribute("aria-expanded", "false");
  const root = new Element();
  return {
    documentElement: { clientWidth: 384, clientHeight: 390 }, defaultView: new Element(),
    getElementById: id => elements.get(id), createElement: () => new Element(),
    querySelectorAll: () => [elements.get("settings-panel")],
    addEventListener: (...args) => root.addEventListener(...args),
    ready: () => root.dispatch("DOMContentLoaded"), dispatch: (...args) => root.dispatch(...args), elements
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const table = document => document.elements.get("coins-list").children.map(row => row.innerHTML).join("");
const checkbox = (document, id) => document.elements.get("settings-coins").children
  .find(row => row.dataset.id === id).children[0].children[0];

for (const surface of ["popup.html", "window.html"]) {
  test(`${surface} keeps one accessible X button beside the timestamp, below assets and above Radar`, async () => {
    const html = await readFile(new URL(surface, import.meta.url), "utf8");
    const header = html.match(/<div class="zm-header-actions">([\s\S]*?)<\/div>/)?.[1];
    const footer = html.match(/<div class="zm-market-footer">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(header && footer);
    assert.doesNotMatch(header, /zmetrics-x-link/);
    assert.equal((html.match(/id="zmetrics-x-link"/g) || []).length, 1);
    assert.equal((html.match(/id="update-time"/g) || []).length, 1);
    assert.match(footer, /<button id="zmetrics-x-link"[^>]*type="button"[^>]*aria-label="Open @zmetrics on X"/);
    assert.match(footer, /<div id="update-time" class="timestamp">/);
    assert.ok(footer.indexOf("zmetrics-x-link") < footer.indexOf("update-time"));
    assert.ok(html.indexOf('id="coins-list"') < html.indexOf('class="zm-market-footer"'));
    assert.ok(html.indexOf('class="zm-market-footer"') < html.indexOf('id="radar"'));
  });
}

test("real popup and floating-window module synchronizes prices, currency and preferences", async (t) => {
  const original = { chrome: globalThis.chrome, document: globalThis.document, fetch: globalThis.fetch, setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const originalNow = Date.now;
  t.after(() => { Object.assign(globalThis, original); Date.now = originalNow; });
  const messages = [], changes = [], writes = [], polls = [], searches = [];
  const preferences = {};
  const localPreferences = {}, openedTabs = [];
  let marketRequests = 0;
  const marketUrls = [];
  let failPrices = false;
  let clock = Date.parse("2026-10-08T10:01:00Z");
  let quoteTime = Date.parse("2026-10-08T10:00:00Z");
  let marketChanges = {};
  const timers = new Map();
  let nextTimer = 1;
  globalThis.setTimeout = (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  Date.now = () => clock;
  const providerTime = "2026-10-08T10:00:00Z";
  const service = createMarketDataService({
    now: () => clock,
    fetchImpl: async url => {
      marketRequests++;
      marketUrls.push(url);
      if (failPrices) return { ok: false, status: 429 };
      const query = new URL(url).searchParams;
      const price = query.get("vs_currency") === "eur" ? 90 : 100;
      return { ok: true, json: async () => query.get("ids").split(",").map(id => ({
        id, current_price: price, market_cap: 1000000,
        price_change_percentage_24h: 3, price_change_percentage_24h_in_currency: marketChanges[id] ?? -2,
        last_updated: new Date(quoteTime).toISOString()
      })) };
    },
    onSnapshot: snapshot => messages.forEach(listener => listener({ type: MARKET_UPDATED, snapshot }, { id: "test-extension" }))
  });
  globalThis.chrome = {
    runtime: {
      id: "test-extension", onMessage: { addListener: listener => messages.push(listener) },
      sendMessage(message, callback) {
        assert.equal(message.type, MARKET_REQUEST);
        service.load(message.currency, message.ids, message.force)
          .then(snapshot => callback({ snapshot }), () => callback({ error: "Market data unavailable" }));
      }
    },
    storage: {
      onChanged: { addListener: listener => changes.push(listener) },
      local: {
        get(keys, callback) { const result = Object.fromEntries(keys.map(key => [key, localPreferences[key]])); queueMicrotask(() => callback(result)); },
        set(values, callback) {
          Object.assign(localPreferences, values);
          changes.forEach(listener => listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), "local"));
          callback?.();
        }
      },
      sync: {
        get(defaults, callback) {
          const stored = structuredClone({ ...defaults, ...preferences });
          queueMicrotask(() => callback(stored));
        },
        set(values, callback) {
          const next = structuredClone(values);
          writes.push(next);
          const diff = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, { oldValue: preferences[key], newValue: value }]));
          Object.assign(preferences, next);
          changes.forEach(listener => listener(structuredClone(diff), "sync"));
          callback?.();
        }
      }
    },
    commands: { getAll: callback => callback([]) }, tabs: { create: options => openedTabs.push(options) }
  };
  globalThis.setInterval = callback => { polls.push(callback); return polls.length; };
  globalThis.fetch = url => new Promise((resolve, reject) => searches.push({ url, resolve, reject }));
  const popup = makeDocument();
  globalThis.document = popup;
  await import(`./popup.js?popup-test=${Date.now()}`);
  popup.ready();
  // A change arriving after get() starts must not be lost to its older snapshot.
  chrome.storage.sync.set({ coinOrder: ["ethereum", "bitcoin", "ripple", "solana"] });
  const floating = makeDocument();
  globalThis.document = floating;
  await import(`./popup.js?window-test=${Date.now()}`);
  floating.ready();
  await flush();

  await t.test("both surfaces share initial data and preserve negative changes", () => {
    assert.equal(marketRequests, 1);
    assert.equal(table(popup), table(floating));
    assert.match(table(popup), /\$100\.00/);
    assert.match(table(popup), /-2\.00%/);
    assert.match(table(popup), /cell-change down/);
    assert.match(popup.elements.get("coins-list").children[0].innerHTML, /ETH/);
    assert.equal(polls.length, 2);
    assert.equal(popup.elements.get("radar").dataset.state, "quiet");
    assert.equal(floating.elements.get("radar").dataset.state, "quiet");
  });

  await t.test("reordering syncs without fetching or refreshing the timestamp", async () => {
    const timestamp = popup.elements.get("update-time").textContent;
    assert.equal(timestamp, "Updated: " + new Date(providerTime).toLocaleTimeString());
    chrome.storage.sync.set({ coinOrder: ["solana", "bitcoin", "ethereum", "ripple"] });
    await flush();
    assert.equal(marketRequests, 1);
    assert.equal(table(popup), table(floating));
    assert.match(popup.elements.get("coins-list").children[0].innerHTML, /SOL/);
    assert.equal(floating.elements.get("update-time").textContent, timestamp);
  });

  await t.test("currency switching clears wrong-currency prices and updates both surfaces", async () => {
    const currency = popup.elements.get("currency-select");
    currency.value = "eur";
    currency.dispatch("change");
    assert.doesNotMatch(table(popup), /\$100\.00/);
    assert.doesNotMatch(table(floating), /\$100\.00/);
    assert.equal(popup.elements.get("radar").dataset.state, "loading");
    assert.equal(floating.elements.get("radar").dataset.state, "loading");
    await flush();
    assert.equal(marketRequests, 2);
    assert.equal(floating.elements.get("currency-select").value, "eur");
    assert.match(table(popup), /€90\.00/);
    assert.equal(table(popup), table(floating));
  });

  await t.test("watchlist changes sync and only write the modified preference", async () => {
    const input = checkbox(popup, "bitcoin");
    input.checked = false;
    input.dispatch("change");
    await flush();
    assert.equal(checkbox(floating, "bitcoin").checked, false);
    assert.deepEqual(Object.keys(writes.at(-1)), ["enabledCoinIds"]);
    assert.doesNotMatch(table(floating), /coin-symbol">BTC/);
    assert.equal(marketRequests, 2);
    const restored = checkbox(floating, "bitcoin");
    restored.checked = true;
    restored.dispatch("change");
    await flush();
    assert.equal(checkbox(popup, "bitcoin").checked, true);
    assert.equal(marketRequests, 2);
  });

  await t.test("refresh errors preserve quotes and do not invent a new timestamp", async () => {
    failPrices = true;
    popup.elements.get("refresh-btn").click();
    await flush();
    assert.match(table(popup), /€90\.00/);
    assert.equal(popup.elements.get("update-time").textContent, "Error updating. Showing last available data.");
    assert.equal(popup.elements.get("radar").dataset.state, "error");
    chrome.storage.sync.set({ coinOrder: ["bitcoin", "ethereum", "ripple", "solana"] });
    assert.equal(popup.elements.get("update-time").textContent, "Error updating. Showing last available data.");
    // Reordering does not mask an unsuccessful refresh as successful.
    failPrices = false;
  });

  await t.test("a stale search success or error never replaces newer results", async () => {
    const input = popup.elements.get("search-input");
    const button = popup.elements.get("search-btn");
    input.value = "old"; button.click();
    input.value = "new"; button.click();
    searches[1].resolve({ ok: true, json: async () => ({ coins: [{ id: "new-coin", symbol: "NEW", name: "New coin" }] }) });
    await flush();
    const results = popup.elements.get("search-results");
    assert.equal(results.children[0].children[1].children[0].textContent, "NEW");
    searches[0].reject(new Error("late failure"));
    await flush();
    assert.equal(results.children[0].children[1].children[0].textContent, "NEW");
    input.value = "obsolete"; button.click();
    input.value = "latest"; button.click();
    searches[3].resolve({ ok: true, json: async () => ({ coins: [{ id: "new-coin", symbol: "NEW", name: "New coin" }] }) });
    await flush();
    searches[2].resolve({ ok: true, json: async () => ({ coins: [{ id: "wrong", symbol: "WRONG" }] }) });
    await flush();
    assert.equal(results.children[0].children[1].children[0].textContent, "NEW");
  });

  await t.test("adding a coin loads its quote once and updates both watchlists", async () => {
    const before = marketRequests;
    popup.elements.get("search-results").children[0].children[2].children[0].click();
    await flush();
    assert.equal(marketRequests, before + 1);
    assert.match(table(popup), /coin-symbol">NEW/);
    assert.equal(table(popup), table(floating));
    assert.equal(checkbox(floating, "new-coin").checked, true);
  });

  await t.test("deleting base/custom assets syncs without fetching or overwriting unrelated preferences", async () => {
    const before = marketRequests;
    const remove = (document, id) => document.elements.get("settings-coins").children
      .find(row => row.dataset.id === id).children[1].children[1].click();
    remove(popup, "bitcoin");
    await flush();
    assert.deepEqual(Object.keys(writes.at(-1)).sort(), ["coinOrder", "deletedBaseIds", "enabledCoinIds"]);
    assert.doesNotMatch(table(floating), /coin-symbol">BTC/);
    remove(floating, "new-coin");
    await flush();
    assert.deepEqual(Object.keys(writes.at(-1)).sort(), ["coinOrder", "customCoins", "enabledCoinIds"]);
    assert.doesNotMatch(table(popup), /coin-symbol">NEW/);
    assert.equal(marketRequests, before);
  });

  await t.test("hidden BTC is still fetched as a benchmark but never displayed or saved as selected", async () => {
    const before = marketRequests;
    const beforePreferences = structuredClone(preferences);
    floating.elements.get("refresh-btn").click();
    await flush();
    assert.equal(marketRequests, before + 1);
    const requested = new URL(marketUrls.at(-1)).searchParams.get("ids").split(",");
    assert.equal(requested.filter(id => id === "bitcoin").length, 1);
    assert.ok(!preferences.enabledCoinIds.includes("bitcoin"));
    assert.ok(!preferences.customCoins.some(coin => coin.id === "bitcoin"));
    assert.deepEqual(preferences, beforePreferences);
    assert.doesNotMatch(table(popup), /coin-symbol">BTC/);
    assert.doesNotMatch(table(floating), /coin-symbol">BTC/);
  });

  await t.test("Radar highlights the top signal on both surfaces and uses a native disclosure for the rest", async () => {
    marketChanges = { bitcoin: 20, ethereum: 16, ripple: 4, solana: 4 };
    floating.elements.get("refresh-btn").click();
    await flush();
    for (const document of [popup, floating]) {
      assert.equal(document.elements.get("radar").dataset.state, "observations");
      const featured = document.elements.get("radar-feature");
      assert.equal(featured.children[0].className, "radar-observation-top");
      assert.equal(featured.children[0].children[0].textContent, "XRP trails BTC");
      const metric = featured.children[0].children[1];
      assert.equal(metric.textContent, "-16.00 pp");
      assert.match(metric.children[0].textContent, /percentage points/);
      assert.equal(metric.title, undefined);
      assert.equal(metric.children[0].className, "radar-sr-only");
      assert.match(featured.children[1].textContent, /XRP \+4\.00% · BTC \+20\.00%/);
      assert.equal(document.elements.get("radar-extra").children.length, 2);
      assert.equal(document.elements.get("radar-more-label").textContent, "Show 2 more observations");
      assert.equal(document.elements.get("radar")["aria-busy"], "false");
    }
    const more = floating.elements.get("radar-more");
    more.open = true;
    more.dispatch("toggle");
    assert.equal(floating.elements.get("radar-more-label").textContent, "Show fewer observations");
    const before = marketRequests;
    chrome.storage.sync.set({ coinOrder: ["solana", "ripple", "ethereum"] });
    await flush();
    assert.equal(more.open, true);
    assert.equal(floating.elements.get("radar-more-label").textContent, "Show fewer observations");
    assert.equal(marketRequests, before);
    more.open = false;
    more.dispatch("toggle");
    assert.equal(floating.elements.get("radar-more-label").textContent, "Show 2 more observations");
  });

  await t.test("percentage-point help is shared, focusable and present only on pp comparisons in both views", () => {
    for (const document of [popup, floating]) {
      const tooltip = document.elements.get("radar").children.find(child => child.id === "radar-pp-tooltip");
      assert.equal(tooltip.role, "tooltip");
      assert.equal(tooltip.hidden, true);
      assert.equal(tooltip.textContent, "pp = percentage points. The difference between two percentage changes. For example, +11% vs +3% = +8 pp.");
      const observations = [document.elements.get("radar-feature"), ...document.elements.get("radar-extra").children];
      assert.deepEqual(observations.map(item => item.children[0].children[1].textContent.endsWith(" pp")), [true, false, true]);
      for (const item of observations) {
        const metric = item.children[0].children[1];
        const help = metric.children.find(child => child.className === "radar-metric-help");
        if (!metric.textContent.endsWith(" pp")) { assert.equal(help, undefined); continue; }
        assert.equal(help.type, "button");
        assert.equal(help.textContent, "ⓘ");
        assert.equal(help["aria-label"], "About percentage points");
        assert.equal(help["aria-describedby"], tooltip.id);
      }
    }
  });

  await t.test("pp tooltip stays within the viewport, persists on focus/hover, dismisses with Escape and never fetches", () => {
    const before = marketRequests;
    for (const document of [popup, floating]) {
      const tooltip = document.elements.get("radar").children.find(child => child.id === "radar-pp-tooltip");
      const help = document.elements.get("radar-feature").children[0].children[1].children[1];
      help.dispatch("mouseenter");
      assert.equal(tooltip.hidden, false);
      assert.equal(tooltip.style.left, "106px");
      assert.equal(tooltip.style.top, "276px"); // Flip above near the bottom edge.
      help.dispatch("mouseleave");
      tooltip.dispatch("mouseenter"); // Pointer may move onto the explanatory text.
      assert.ok(![...timers.values()].some(timer => timer.delay === 120));
      tooltip.dispatch("mouseleave");
      for (const [id, timer] of [...timers]) if (timer.delay === 120) { timers.delete(id); timer.callback(); }
      assert.equal(tooltip.hidden, true);
      document.activeElement = help;
      help.rect = { ...help.rect, top: 2, bottom: 12, right: 10 };
      help.dispatch("focus");
      assert.equal(tooltip.style.left, "8px");
      assert.equal(tooltip.style.top, "18px"); // Below, without clipping the top/left.
      help.dispatch("mouseleave");
      for (const [id, timer] of [...timers]) if (timer.delay === 120) { timers.delete(id); timer.callback(); }
      assert.equal(tooltip.hidden, false); // Keyboard focus wins over pointer exit.
      help.rect = { ...help.rect, top: 350, bottom: 360, right: 380 };
      document.dispatch("scroll");
      assert.equal(tooltip.style.top, "276px");
      document.dispatch("keydown", { key: "Escape" });
      assert.equal(tooltip.hidden, true);
      assert.equal(document.activeElement, help);
      help.dispatch("focus");
      document.activeElement = null;
      help.dispatch("blur");
      for (const [id, timer] of [...timers]) if (timer.delay === 120) { timers.delete(id); timer.callback(); }
      assert.equal(tooltip.hidden, true);
    }
    assert.equal(marketRequests, before);
  });

  await t.test("Radar defaults closed, acknowledges only visible signals, shares local seen state and preserves the X action", async () => {
    globalThis.document = popup;
    const p = popup.elements, f = floating.elements;
    assert.equal(p.get("radar-toggle")["aria-expanded"], "false");
    assert.equal(p.get("radar-toggle").dataset.new, "true");
    popup.visibilityState = "hidden";
    p.get("radar-toggle").click();
    await flush();
    assert.equal(Object.keys(localPreferences).length, 0);
    popup.visibilityState = "visible";
    popup.dispatch("visibilitychange");
    await flush();
    assert.equal(p.get("radar-toggle")["aria-expanded"], "true");
    assert.equal(Object.keys(localPreferences).length, 1);
    assert.equal(p.get("radar-more").dataset.new, "true");
    assert.equal(f.get("radar-toggle").dataset.new, "true"); // Secondary signals remain unseen.
    p.get("radar-more").open = true;
    p.get("radar-more").dispatch("toggle");
    await flush();
    assert.equal(Object.keys(localPreferences).length, 3);
    assert.equal(p.get("radar-toggle").dataset.new, "false");
    assert.equal(f.get("radar-toggle").dataset.new, "false");
    p.get("radar-toggle").click();
    assert.equal(p.get("radar-toggle")["aria-expanded"], "false");
    p.get("refresh-btn").click();
    await flush();
    assert.equal(p.get("radar-toggle").dataset.new, "false");
    p.get("zmetrics-x-link").click();
    assert.deepEqual(openedTabs.at(-1), { url: "https://x.com/zmetrics_net" });
    f.get("zmetrics-x-link").click();
    assert.deepEqual(openedTabs.at(-1), { url: "https://x.com/zmetrics_net" });
    assert.ok(!Object.keys(preferences).some(key => key.startsWith("zmetrics_radar_seen")));
  });

  await t.test("Radar expiry removes stale observations without making a request", async () => {
    const before = marketRequests;
    clock = quoteTime + 5 * 60000 + 1;
    // Execute only expiry callbacks (not the refresh spinner/HTTP timeout).
    for (const [id, timer] of [...timers]) {
      if (timer.delay > 60000) { timers.delete(id); timer.callback(); }
    }
    await flush();
    for (const document of [popup, floating]) {
      assert.equal(document.elements.get("radar").dataset.state, "stale");
      assert.equal(document.elements.get("radar-feature").children.length, 0);
      assert.equal(document.elements.get("radar-more").open, false);
    }
    assert.equal(marketRequests, before);
    quoteTime = clock;
    floating.elements.get("refresh-btn").click();
    await flush();
    assert.equal(popup.elements.get("radar").dataset.state, "observations");
  });

  await t.test("an empty watchlist stays empty during polls and stale broadcasts", async () => {
    chrome.storage.sync.set({ enabledCoinIds: [] });
    await flush();
    const before = marketRequests;
    polls.forEach(poll => poll());
    await flush();
    assert.match(popup.elements.get("coins-list").innerHTML, /No assets selected/);
    assert.match(floating.elements.get("coins-list").innerHTML, /No assets selected/);
    assert.equal(popup.elements.get("update-time").textContent, "");
    assert.equal(popup.elements.get("radar").dataset.state, "empty");
    assert.equal(floating.elements.get("radar").dataset.state, "empty");
    assert.equal(marketRequests, before);
  });

  await t.test("packaged production UI restores pre-Radar preferences without rewriting them", async t => {
    const directory = await mkdtemp(join(tmpdir(), "zmetrics-upgrade-test-"));
    t.after(async () => {
      const path = resolve(directory), prefix = resolve(tmpdir());
      assert.ok(path.startsWith(prefix + "\\zmetrics-upgrade-test-") || path.startsWith(prefix + "/zmetrics-upgrade-test-"));
      await rm(path, { recursive: true, force: true });
    });
    const release = await buildRelease({ output: join(directory, "release") });
    // This is the existing storage schema, not a new migration or a real CWS update.
    const saved = {
      enabledCoinIds: ["solana", "cardano", "ethereum"],
      customCoins: [{ id: "cardano", symbol: "ADA", icon: "https://coin-images.coingecko.com/coins/images/975/small/cardano.png" }],
      deletedBaseIds: ["bitcoin"],
      coinOrder: ["cardano", "solana", "ripple", "ethereum"],
      selectedCurrency: "eur",
      unrelatedPreference: "preserve"
    };
    for (const key of Object.keys(preferences)) delete preferences[key];
    Object.assign(preferences, structuredClone(saved));
    const beforeWrites = writes.length;
    const openProductionView = async label => {
      const view = makeDocument();
      globalThis.document = view;
      await import(`${pathToFileURL(join(release.directory, "popup.js")).href}?upgrade=${label}`);
      view.ready();
      await flush();
      return view;
    };
    for (const label of ["popup", "floating", "reopened"]) {
      const view = await openProductionView(label);
      assert.equal(view.elements.get("currency-select").value, "eur");
      assert.equal(checkbox(view, "ripple").checked, false);
      assert.equal(checkbox(view, "cardano").checked, true);
      assert.deepEqual(view.elements.get("settings-coins").children.map(row => row.dataset.id), saved.coinOrder);
      const rows = view.elements.get("coins-list").children;
      assert.equal(rows.length, 3);
      assert.match(rows[0].innerHTML, /coin-symbol">ADA/);
      assert.match(rows[1].innerHTML, /coin-symbol">SOL/);
      assert.match(rows[2].innerHTML, /coin-symbol">ETH/);
      assert.match(table(view), /€90\.00/);
      assert.doesNotMatch(table(view), /coin-symbol">BTC|coin-symbol">XRP/);
      assert.deepEqual(preferences, saved);
      assert.equal(writes.length, beforeWrites);
    }
    // An intentional empty selection must not be replaced by defaults on update.
    preferences.enabledCoinIds = [];
    const beforeRequests = marketRequests;
    const empty = await openProductionView("empty");
    assert.match(empty.elements.get("coins-list").innerHTML, /No assets selected/);
    assert.equal(empty.elements.get("radar").dataset.state, "empty");
    assert.deepEqual(preferences, { ...saved, enabledCoinIds: [] });
    assert.equal(writes.length, beforeWrites);
    assert.equal(marketRequests, beforeRequests);
  });
});
