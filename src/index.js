// duo-scan: checks Apple Store pickup availability every minute and sends a
// push notification (via ntfy) when a matching iPhone is available nearby.

import { DurableObject } from "cloudflare:workers";

// Small key/value store that survives between cron runs.
export class State extends DurableObject {
  async get(key) {
    return (await this.ctx.storage.get(key)) ?? null;
  }
  async put(key, value) {
    await this.ctx.storage.put(key, value);
  }
}

const REMIND_EVERY_MIN = 3; // keep nudging while stock is still there
const BLOCKED_AFTER_FAILS = 10; // consecutive failed runs before warning you
const PARTS_CACHE_HOURS = 6;
const HEARTBEAT_HOUR_PT = 9; // daily "still running" ping, Pacific time

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  "Accept-Language": "en-US,en;q=0.9",
};

export default {
  async scheduled(event, env, ctx) {
    await run(env);
  },

  // Handy URLs to open from your phone:
  //   /status  last check result
  //   /test    send a test notification
  //   /check   run a check right now
  //   /parts   show which part numbers were found on Apple's page
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const store = stateStub(env);
    if (pathname === "/test") {
      await notify(env, {
        title: "duo-scan test",
        message: "Notifications are working. You'll get one like this when an iPhone Duo is in stock.",
        priority: 5,
        tags: ["white_check_mark"],
        click: buyUrl(env),
      });
      return text("Test notification sent.");
    }
    if (pathname === "/check") return json(await run(env));
    if (pathname === "/parts") {
      const html = await fetchText(buyUrl(env));
      return json(debugParts(html, env));
    }
    return json((await store.get("status")) ?? { message: "No check has run yet." });
  },
};

// ---------------------------------------------------------------------------

export async function run(env) {
  const store = stateStub(env);
  const now = Date.now();
  const status = { at: new Date(now).toISOString(), ok: false, errors: [] };

  let parts = [];
  try {
    parts = await getParts(env, store);
  } catch (err) {
    status.errors.push(String(err.message || err));
  }
  status.parts = parts;

  const stores = new Map(); // storeNumber -> store info with per-part availability
  let okLookups = 0;
  if (parts.length) {
    for (const zip of list(env.SEARCH_ZIPS)) {
      try {
        const data = await fetchJson(fulfillmentUrl(zip, parts));
        for (const s of parseStores(data, parts, env)) {
          if (!stores.has(s.storeNumber)) stores.set(s.storeNumber, s);
        }
        okLookups++;
      } catch (err) {
        status.errors.push(`${zip}: ${err.message || err}`);
      }
    }
  }
  status.ok = okLookups > 0;

  const maxMiles = Number(env.MAX_MILES) || Infinity;
  const nearby = [...stores.values()]
    .filter((s) => s.miles == null || s.miles <= maxMiles)
    .sort((a, b) => (a.miles ?? 999) - (b.miles ?? 999));
  status.storesChecked = nearby.map((s) => `${s.name}${s.miles != null ? ` (${s.miles} mi)` : ""}`);

  const available = nearby.filter((s) => s.availableParts.length);
  status.available = available.map((s) => s.name);

  // --- alerts for stock ----------------------------------------------------
  const alerted = (await store.get("alerted")) ?? {};
  const toAlert = [];
  let anyNew = false;
  const stillAvailable = {};
  for (const s of available) {
    const key = s.storeNumber;
    const last = alerted[key];
    stillAvailable[key] = last ?? 0;
    if (!last || now - last >= REMIND_EVERY_MIN * 60_000) {
      toAlert.push(s);
      stillAvailable[key] = now;
      if (!last) anyNew = true;
    }
  }
  if (status.ok) await store.put("alerted", stillAvailable);

  if (toAlert.length) {
    const lines = toAlert.map((s) => `• ${s.name}${s.miles != null ? ` — ${s.miles} mi` : ""}${s.quote ? ` (${s.quote})` : ""}`);
    await notify(env, {
      title: anyNew ? "iPhone Duo AVAILABLE for pickup!" : "iPhone Duo still available",
      message: `${describeModel(env)}\n${lines.join("\n")}\nTap to reserve now.`,
      priority: 5,
      tags: ["rotating_light"],
      click: buyUrl(env),
    });
  }

  // --- warn if checks keep failing (e.g. Apple blocking us) ---------------
  let fails = (await store.get("fails")) ?? 0;
  const warned = (await store.get("warned")) ?? false;
  if (status.ok) {
    if (warned) {
      await notify(env, { title: "duo-scan is working again", message: "Checks are succeeding again.", priority: 3, tags: ["white_check_mark"] });
      await store.put("warned", false);
    }
    fails = 0;
  } else {
    fails++;
    if (fails === BLOCKED_AFTER_FAILS && !warned) {
      await notify(env, {
        title: "duo-scan can't check Apple",
        message: `The last ${fails} checks failed, so you won't get stock alerts until this is fixed.\n${status.errors.slice(0, 3).join("\n")}`,
        priority: 4,
        tags: ["warning"],
      });
      await store.put("warned", true);
    }
  }
  await store.put("fails", fails);
  status.consecutiveFailures = fails;

  // --- once-a-day heartbeat so you know it's alive -------------------------
  const pt = pacificNow(now);
  if (pt.hour >= HEARTBEAT_HOUR_PT && (await store.get("heartbeat")) !== pt.date) {
    await store.put("heartbeat", pt.date);
    await notify(env, {
      title: "duo-scan is watching",
      message: status.ok
        ? `Checking ${nearby.length} stores every minute for ${describeModel(env)}.`
        : `Running, but checks are failing: ${status.errors[0] ?? "unknown error"}`,
      priority: 2,
      tags: ["eyes"],
    });
  }

  await store.put("status", status);
  return status;
}

// ---------------------------------------------------------------------------
// Apple

function buyUrl(env) {
  return `https://www.apple.com/shop/buy-iphone/${env.PRODUCT_SLUG}`;
}

function fulfillmentUrl(zip, parts) {
  const q = new URLSearchParams({ pl: "true", "mts.0": "regular", "mts.1": "compact", location: zip });
  parts.forEach((p, i) => q.set(`parts.${i}`, p));
  return `https://www.apple.com/shop/fulfillment-messages?${q}`;
}

async function getParts(env, store) {
  const manual = list(env.PART_NUMBERS);
  if (manual.length) return manual;

  const cached = await store.get("parts");
  if (cached && cached.list.length && Date.now() - cached.at < PARTS_CACHE_HOURS * 3_600_000) return cached.list;

  try {
    const html = await fetchText(buyUrl(env));
    const found = findParts(html, env);
    if (!found.length) throw new Error(`No ${describeModel(env)} part numbers found on ${buyUrl(env)}`);
    await store.put("parts", { at: Date.now(), list: found });
    return found;
  } catch (err) {
    if (cached && cached.list.length) return cached.list; // stale is better than nothing
    throw err;
  }
}

const PART_RE = /"partNumber"\s*:\s*"([A-Z0-9]{4,6}[A-Z]{2}\/A)"/g;

// Find part numbers on the buy page whose product data mentions the wanted
// capacity, color and carrier (e.g. "256gb", "black", "unlocked").
export function findParts(html, env) {
  const wants = [env.CAPACITY, env.COLOR, env.CARRIER].map((w) => String(w || "").toLowerCase()).filter(Boolean);
  const found = new Set();
  for (const m of html.matchAll(PART_RE)) {
    const obj = enclosingObject(html, m.index).toLowerCase();
    if (wants.every((w) => obj.includes(w))) found.add(m[1]);
  }
  return [...found];
}

function debugParts(html, env) {
  const all = [];
  const seen = new Set();
  for (const m of html.matchAll(PART_RE)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    all.push({ part: m[1], context: enclosingObject(html, m.index).slice(0, 400) });
  }
  return { matching: findParts(html, env), all };
}

// Return the text of the smallest {...} JSON object around position idx.
export function enclosingObject(text, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0 && idx - i < 20_000; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return text.slice(Math.max(0, idx - 600), idx + 600);
  let inStr = false;
  depth = 0;
  for (let i = start; i < text.length && i - start < 50_000; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start, start + 1200);
}

// Turn Apple's fulfillment response into a simple list of stores.
export function parseStores(data, parts, env) {
  const raw = data?.body?.content?.pickupMessage?.stores;
  if (!Array.isArray(raw)) throw new Error("Unexpected response from Apple (no store list)");
  const homeLat = Number(env.HOME_LAT);
  const homeLon = Number(env.HOME_LON);
  return raw.map((s) => {
    const lat = Number(s.storelatitude ?? s.retailStore?.address?.latitude);
    const lon = Number(s.storelongitude ?? s.retailStore?.address?.longitude);
    const miles = Number.isFinite(lat) && Number.isFinite(lon) && lat && lon && Number.isFinite(homeLat)
      ? Math.round(haversineMiles(homeLat, homeLon, lat, lon))
      : null;
    const availableParts = [];
    let quote = "";
    for (const p of parts) {
      const pa = s.partsAvailability?.[p];
      if (pa?.pickupDisplay === "available") {
        availableParts.push(p);
        quote ||= stripTags(pa.pickupSearchQuote || pa.storePickupQuote || "");
      }
    }
    return {
      storeNumber: s.storeNumber,
      name: `${s.storeName}${s.city ? `, ${s.city}` : ""}`,
      miles,
      availableParts,
      quote,
    };
  });
}

// ---------------------------------------------------------------------------
// helpers

async function notify(env, { title, message, priority = 3, tags = [], click }) {
  const body = { topic: env.NTFY_TOPIC, title, message, priority, tags };
  if (click) {
    body.click = click;
    body.actions = [{ action: "view", label: "Reserve", url: click, clear: true }];
  }
  try {
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("ntfy failed", res.status, await res.text());
  } catch (err) {
    console.error("ntfy failed", err);
  }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { ...BROWSER_HEADERS, Accept: "text/html,*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Accept: "application/json, text/plain, */*", Referer: "https://www.apple.com/shop/buy-iphone" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Apple`);
  return res.json();
}

function stateStub(env) {
  return env.STATE.get(env.STATE.idFromName("main"));
}

function describeModel(env) {
  return `${env.CAPACITY.toUpperCase()} ${cap(env.COLOR)} ${cap(env.CARRIER)}`;
}

function list(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function cap(s) {
  return String(s || "").replace(/^./, (c) => c.toUpperCase());
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "").trim();
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

function pacificNow(ms) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

function text(s) {
  return new Response(s, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function json(o) {
  return new Response(JSON.stringify(o, null, 2), { headers: { "Content-Type": "application/json" } });
}
