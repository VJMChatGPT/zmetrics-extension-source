import test from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const values = { session: {} };
  const area = (name) => ({
    get(defaults, callback) {
      callback({ ...defaults, ...values[name] });
    },
    set(next, callback) {
      Object.assign(values[name], next);
      callback?.();
    },
    remove(key, callback) {
      delete values[name][key];
      callback?.();
    }
  });
  return { values, session: area("session"), local: area("session") };
}

function eventSlot() {
  let handler = null;
  return {
    addListener(next) {
      handler = next;
    },
    async dispatch(...args) {
      return handler?.(...args);
    }
  };
}

test("background worker", async (t) => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  const storage = makeStorage();
  const events = {
    command: eventSlot(),
    removed: eventSlot(),
    message: eventSlot()
  };
  const createdWindows = [];
  const removedWindows = [];
  let nextWindowId = 42;
  const broadcasts = [];
  const requests = [];
  let finish;
  globalThis.fetch = url => {
    requests.push(url);
    return new Promise(resolve => { finish = resolve; });
  };

  globalThis.chrome = {
    runtime: {
      id: "test-extension", onMessage: events.message,
      sendMessage(message, callback) { broadcasts.push(message); callback?.(); }
    },
    commands: { onCommand: events.command },
    windows: {
      onRemoved: events.removed,
      async get(windowId) {
        if (removedWindows.includes(windowId)) throw new Error("window_closed");
        return { id: windowId, type: "popup" };
      },
      async create(options) {
        const created = { id: nextWindowId++, ...options };
        createdWindows.push(created);
        return created;
      },
      async remove(windowId) {
        removedWindows.push(windowId);
      }
    },
    storage
  };

  await import("./background.js");

  await t.test("shortcut toggles one floating window without reading tab URLs", async () => {
    await events.command.dispatch("open_window_popup");
    assert.equal(createdWindows.length, 1);
    assert.equal(createdWindows[0].url, "window.html");
    assert.equal(storage.values.session.zmetrics_floating_window_id, 42);

    await events.command.dispatch("open_window_popup");
    assert.deepEqual(removedWindows, [42]);
    assert.equal(storage.values.session.zmetrics_floating_window_id, undefined);

    await Promise.all([
      events.command.dispatch("open_window_popup"),
      events.command.dispatch("open_window_popup")
    ]);
    assert.equal(createdWindows.length, 2);
    assert.deepEqual(removedWindows, [42, 43]);
  });

  await t.test("worker validates requests, shares market fetches and broadcasts successful snapshots", async () => {
    const send = (message, sender = { id: "test-extension" }) => new Promise(resolve => {
      events.message.dispatch(message, sender, resolve).then(result => { if (result !== true) resolve(undefined); });
    });
    const message = { type: "zmetrics:get-markets", currency: "usd", ids: ["bitcoin"] };
    assert.equal(await send(message, { id: "other-extension" }), undefined);
    assert.equal(await send({ type: "unknown" }), undefined);
    assert.deepEqual(await send({ ...message, currency: "invalid" }), { error: "Market data unavailable" });
    assert.equal(requests.length, 0);
    const first = send(message);
    const second = send(message);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    finish({ ok: true, json: async () => [{ id: "bitcoin", current_price: 123 }] });
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.snapshot.markets.bitcoin.price, 123);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, "zmetrics:markets-updated");
    assert.deepEqual(await send(message), a);
    assert.equal(requests.length, 1);
  });
});
