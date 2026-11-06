// Offline test: fakes Apple + ntfy and checks alert behaviour.
// Run: node --import ./test/register.mjs --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, findParts, parseStores } from "../src/index.js";

const env = {
  NTFY_TOPIC: "t", PRODUCT_SLUG: "iphone-duo", CAPACITY: "256gb", COLOR: "black", CARRIER: "unlocked",
  PART_NUMBERS: "", HOME_ZIP: "95831", HOME_LAT: "38.4960", HOME_LON: "-121.5300",
  SEARCH_ZIPS: "95831,95050", MAX_MILES: "130",
};
const mem = new Map();
const stub = { get: async (k) => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, structuredClone(v)); } };
env.STATE = { idFromName: () => "id", get: () => stub };

const HTML = `<script>window.X = {"products":[
 {"partNumber":"MAAA1LL/A","dimensions":{"dimensionCapacity":"256gb","dimensionColor":"black","carrierModel":"UNLOCKED/US"}},
 {"partNumber":"MBBB1LL/A","dimensions":{"dimensionCapacity":"512gb","dimensionColor":"black","carrierModel":"UNLOCKED/US"}},
 {"partNumber":"MCCC1LL/A","dimensions":{"dimensionCapacity":"256gb","dimensionColor":"white","carrierModel":"UNLOCKED/US"}},
 {"partNumber":"MDDD1LL/A","dimensions":{"dimensionCapacity":"256gb","dimensionColor":"black","carrierModel":"VERIZON/US"}}
]}</script>`;

const store = (num, name, lat, lon, display) => ({
  storeNumber: num, storeName: name, city: "X", storelatitude: lat, storelongitude: lon,
  partsAvailability: { "MAAA1LL/A": { pickupDisplay: display, pickupSearchQuote: "<b>Today</b>" } },
});
let avail = "unavailable";
let appleStatus = 200;
const sent = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith("https://ntfy.sh")) { sent.push(JSON.parse(init.body)); return new Response("{}"); }
  if (appleStatus !== 200) return new Response("blocked", { status: appleStatus });
  if (url.includes("/shop/buy-iphone/")) return new Response(HTML);
  if (url.includes("fulfillment-messages")) {
    assert.ok(url.includes("parts.0=MAAA1LL%2FA"));
    return Response.json({ body: { content: { pickupMessage: { stores: [
      store("R1", "Arden Fair", 38.6, -121.42, avail),
      store("R2", "Valley Fair", 37.32, -121.95, "unavailable"),
      store("R3", "Fresno", 36.79, -119.86, "available"), // >130 mi: ignored
    ] } } } });
  }
  throw new Error("unexpected " + url);
};

test("finds only the 256GB black unlocked part", () => {
  assert.deepEqual(findParts(HTML, env), ["MAAA1LL/A"]);
});

test("distance filter and parsing", () => {
  const s = parseStores({ body: { content: { pickupMessage: { stores: [store("R1", "A", 38.6, -121.42, "available")] } } } }, ["MAAA1LL/A"], env);
  assert.equal(s[0].availableParts.length, 1);
  assert.equal(s[0].quote, "Today");
  assert.ok(s[0].miles < 15);
});

test("alert flow", async () => {
  const t0 = Date.now();
  let st = await run(env);
  assert.equal(st.ok, true);
  assert.equal(st.storesChecked.length, 2, "Fresno excluded");
  assert.equal(sent.filter((n) => n.priority === 5).length, 0, "no stock alert yet");

  avail = "available";
  st = await run(env);
  const alerts = sent.filter((n) => n.priority === 5);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /AVAILABLE/);
  assert.match(alerts[0].message, /Arden Fair/);
  assert.equal(alerts[0].click, "https://www.apple.com/shop/buy-iphone/iphone-duo");

  await run(env); // within 3 minutes: no repeat
  assert.equal(sent.filter((n) => n.priority === 5).length, 1);

  const realNow = Date.now; Date.now = () => t0 + 4 * 60_000;
  await run(env); // reminder
  Date.now = realNow;
  assert.equal(sent.filter((n) => n.priority === 5).length, 2);
  assert.match(sent.filter((n) => n.priority === 5)[1].title, /still/);

  avail = "unavailable"; await run(env);
  avail = "available"; await run(env); // reappears -> new alert immediately
  assert.match(sent.filter((n) => n.priority === 5).at(-1).title, /AVAILABLE/);
});

test("warns once after repeated failures, then recovers", async () => {
  appleStatus = 403;
  for (let i = 0; i < 12; i++) await run(env);
  assert.equal(sent.filter((n) => /can't check/.test(n.title)).length, 1);
  appleStatus = 200;
  await run(env);
  assert.equal(sent.filter((n) => /working again/.test(n.title)).length, 1);
});
