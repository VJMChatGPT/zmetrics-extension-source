import test from "node:test";
import assert from "node:assert/strict";
import { BASE_COINS, getAllCoins, getActiveCoins, escapeMarkup, formatPrice, formatMarketCap, formatChange } from "./extension-logic.js";

test("getAllCoins removes deleted bases and preserves valid custom order", () => {
  const coins = getAllCoins(BASE_COINS, [{ id: "cardano", symbol: "ADA" }], ["ripple"], ["cardano", "bitcoin", "missing"]);
  assert.deepEqual(coins.map((coin) => coin.id), ["cardano", "bitcoin", "ethereum", "solana"]);
});

test("getActiveCoins only returns selected assets in display order", () => {
  const coins = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(getActiveCoins(coins, ["c", "a"]).map((coin) => coin.id), ["a", "c"]);
});

test("external symbols and icon attributes are escaped without changing normal labels", () => {
  assert.equal(escapeMarkup('SOL & "<img>\''), 'SOL &amp; &quot;&lt;img&gt;&#39;');
  assert.equal(escapeMarkup("BTC"), "BTC");
  assert.equal(escapeMarkup(null), "");
});

test("formatters handle currencies, magnitudes and missing values", () => {
  assert.equal(formatPrice(1234.5), "$" + (1234.5).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  assert.equal(formatPrice(0.1234, "eur"), "€0.1234");
  assert.equal(formatPrice(null), "-");
  assert.equal(formatMarketCap(2_500_000_000), "$2.50B");
  assert.equal(formatMarketCap(10, "eur"), "€10");
  assert.equal(formatChange(2.345), "+2.35%");
  assert.equal(formatChange(-1.2), "-1.20%");
  assert.equal(formatChange("bad"), "-");
});

test("percentage signs survive rounding and invalid numbers remain unavailable", () => {
  assert.equal(formatChange(-0.001), "-0.00%");
  assert.equal(formatChange(0.001), "+0.00%");
  assert.equal(formatChange(0), "0.00%");
  assert.equal(formatChange(-0), "0.00%");
  for (const value of [NaN, Infinity, -Infinity, undefined, null, "1"]) {
    assert.equal(formatChange(value), "-");
    assert.equal(formatPrice(value), "-");
    assert.equal(formatMarketCap(value), "-");
  }
});
