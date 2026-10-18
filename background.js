// background.js - gestiona la ventana flotante de ZMetrics
import { createMarketDataService, MARKET_REQUEST, MARKET_UPDATED } from "./market-data.js";

const marketData = createMarketDataService({
  onSnapshot(snapshot) {
    chrome.runtime.sendMessage({ type: MARKET_UPDATED, snapshot }, () => {
      // There may be no open view when a request finishes.
      void chrome.runtime.lastError;
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type !== MARKET_REQUEST) return;
  // Only fixed CoinGecko market queries are accepted, never arbitrary URLs.
  Promise.resolve()
    .then(() => marketData.load(message.currency, message.ids, message.force === true))
    .then(snapshot => sendResponse({ snapshot }), () => sendResponse({ error: "Market data unavailable" }));
  return true;
});

const OPEN_WINDOW_COMMAND = "open_window_popup";
const WINDOW_ID_STORAGE_KEY = "zmetrics_floating_window_id";
const windowStorage = chrome.storage.session || chrome.storage.local;

let popupWindowId = null;
let toggleOperation = Promise.resolve();

function storageGet(defaults) {
  return new Promise((resolve) => {
    windowStorage.get(defaults, (result) => resolve(result || defaults));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    windowStorage.set(values, () => resolve());
  });
}

function storageRemove(key) {
  return new Promise((resolve) => {
    windowStorage.remove(key, () => resolve());
  });
}

async function getStoredPopupWindowId() {
  if (popupWindowId !== null) return popupWindowId;

  const stored = await storageGet({ [WINDOW_ID_STORAGE_KEY]: null });
  const storedId = stored[WINDOW_ID_STORAGE_KEY];
  if (Number.isInteger(storedId)) {
    popupWindowId = storedId;
    return storedId;
  }

  return null;
}

async function clearPopupWindowId() {
  popupWindowId = null;
  await storageRemove(WINDOW_ID_STORAGE_KEY);
}

async function rememberPopupWindowId(windowId) {
  popupWindowId = windowId;
  await storageSet({ [WINDOW_ID_STORAGE_KEY]: windowId });
}

async function findExistingPopupWindowId() {
  const candidateId = await getStoredPopupWindowId();
  if (candidateId === null) return null;

  try {
    const window = await chrome.windows.get(candidateId);
    if (window?.type === "popup") return candidateId;
  } catch {
    // The stored window was closed or is no longer available.
  }

  await clearPopupWindowId();
  return null;
}

async function togglePopupWindow() {
  const existingWindowId = await findExistingPopupWindowId();

  if (existingWindowId !== null) {
    await chrome.windows.remove(existingWindowId);
    await clearPopupWindowId();
    return;
  }

  const newWindow = await chrome.windows.create({
    url: "window.html",
    type: "popup",
    width: 380,
    height: 460,
    focused: true,
    left: 1200,
    top: 120
  });

  if (typeof newWindow?.id === "number") {
    await rememberPopupWindowId(newWindow.id);
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    void clearPopupWindowId();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== OPEN_WINDOW_COMMAND) return;

  toggleOperation = toggleOperation
    .then(() => togglePopupWindow())
    .catch(() => {});
  await toggleOperation;
});
