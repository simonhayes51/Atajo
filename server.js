import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ================= PATH ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ================= LOAD AIRPORTS =================
   Expects airports.json items like:
   { "iata":"NCL","city":"Newcastle","name":"Newcastle Airport","country":"GB","metro":"Newcastle" }
*/

function loadAirports() {
  const candidates = [
    path.join(__dirname, "airports.json"),
    path.join(__dirname, "data", "airports.json"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  }

  console.warn("⚠️ airports.json not found in root or /data");
  return [];
}

const airports = loadAirports();

// quick lookup for country by IATA
const airportByIata = new Map(
  airports.map(a => [String(a.iata || "").toUpperCase(), a])
);

/* ================= APP ================= */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

/* ================= CONFIG ================= */

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";

const PROVIDER = "travelpayouts";

// keep calls reasonable
const API_TIMEOUT_MS = 9000;

// hubs to try (you can expand this later)
const DEFAULT_HUBS = [
  // UK/IE
  "STN","LTN","LGW","LHR","MAN","EDI","GLA","BHX","BRS","DUB",
  // NL/BE/FR
  "AMS","EIN","BRU","CRL","CDG","ORY","BVA",
  // DE
  "DUS","CGN","FRA","HHN","MUC","BER","HAM",
  // IT/ES/PT
  "MXP","BGY","FCO","CIA","NAP","VCE","BCN","MAD","LIS","OPO","PMI","ALC","AGP",
  // CEE
  "PRG","VIE","BUD","WAW","KRK","OTP","SOF","ATH",
  // Nordics
  "CPH","ARN","OSL","HEL",
  // TR
  "IST","SAW","AYT","ADB",
].filter((v, i, a) => a.indexOf(v) === i);

function hasToken() {
  return TOKEN && TOKEN.length > 10;
}

function normalizeIata(x) {
  return String(x || "").trim().toUpperCase();
}

function safeInt(x, def) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function tpLinkToFull(xLink) {
  // Travelpayouts gives "/search/..." links
  const base = "https://www.aviasales.com";
  const link = String(xLink || "");
  if (!link) return null;
  const join = link.startsWith("http") ? link : (base + link);
  // marker sometimes needs to be added; if already there, leave it
  if (join.includes("marker=")) return join;
  const sep = join.includes("?") ? "&" : "?";
  return `${join}${sep}marker=${encodeURIComponent(MARKER)}`;
}

/* ================= FETCH WITH TIMEOUT ================= */

async function timeoutFetchJson(url, ms = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body: j };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e) } };
  } finally {
    clearTimeout(t);
  }
}

/* ================= HEALTH ================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: PROVIDER,
    mode: hasToken() ? "LIVE" : "MOCK",
    hasToken: hasToken(),
    marker: MARKER,
    airportsLoaded: airports.length
  });
});

/* ================= AUTOCOMPLETE ================= */

app.get("/api/places", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const q = String(req.query.q || "").toLowerCase().trim();
  if (q.length < 2) return res.json([]);

  const results = airports
    .map(a => {
      const iata = String(a.iata || a.code || "").toUpperCase();
      return {
        iata,
        city: String(a.city || ""),
        name: String(a.name || ""),
        country: String(a.country || ""),
        metro: String(a.metro || "")
      };
    })
    .filter(x => {
      const hay = `${x.iata} ${x.city} ${x.name} ${x.metro}`.toLowerCase();
      return hay.includes(q);
    })
    .filter(x => x.iata && x.iata.length === 3)
    .slice(0, 12);

  res.json(results);
});

/* ================= TP LEG SEARCH =================
   Endpoint used:
   /aviasales/v3/prices_for_dates
   Good for "prices for dates", often returns duration_to minutes.
*/

async function tpPricesForDates(from, to, dateISO, flexDays) {
  from = normalizeIata(from);
  to = normalizeIata(to);

  if (!from || !to || from === to) return [];

  const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  url.searchParams.set("origin", from);
  url.searchParams.set("destination", to);
  url.searchParams.set("currency", "gbp");
  url.searchParams.set("token", TOKEN);

  // Travelpayouts uses "departure_at" (YYYY-MM-DD) – if you pass it, it filters
  if (dateISO) url.searchParams.set("departure_at", dateISO);

  // "flex" isn't guaranteed for this endpoint; if it does nothing, it's harmless.
  // If TP ignores it, we still get some results.
  if (Number(flexDays) > 0) url.searchParams.set("flex", String(flexDays));

  const resp = await timeoutFetchJson(url.toString());
  const data = resp?.body?.data;

  if (!resp.ok || !Array.isArray(data)) return [];

  // Normalize into a leg-like shape we control
  return data
    .filter(x => x && typeof x.price === "number")
    .slice(0, 12)
    .map(x => {
      const dep = x.departure_at ? new Date(x.departure_at) : null;

      // duration_to is minutes (often present)
      const durMin = typeof x.duration_to === "number"
        ? x.duration_to
        : (typeof x.duration === "number" ? x.duration : null);

      const arr = (dep && durMin != null)
        ? new Date(dep.getTime() + durMin * 60_000)
        : null;

      return {
        type: "FLIGHT",
        provider: "TP",
        origin: from,
        destination: to,
        airline: x.airline || null,
        price_gbp: x.price,
        depart_at: dep ? dep.toISOString() : null,
        arrive_at: arr ? arr.toISOString() : null,
        duration_min: durMin,
        deep_link: tpLinkToFull(x.link),
      };
    });
}

/* ================= ROUTE HELPERS ================= */

function getCountry(iata) {
  const a = airportByIata.get(normalizeIata(iata));
  return a?.country ? String(a.country).toUpperCase() : null;
}

function countCountries(legs) {
  const set = new Set();
  for (const l of legs) {
    const c1 = getCountry(l.origin);
    const c2 = getCountry(l.destination);
    if (c1) set.add(c1);
    if (c2) set.add(c2);
  }
  return set.size;
}

function extraCountries(legs) {
  // "extra" = unique countries visited minus origin+destination countries
  const set = new Set();
  for (const l of legs) {
    const c1 = getCountry(l.origin);
    const c2 = getCountry(l.destination);
    if (c1) set.add(c1);
    if (c2) set.add(c2);
  }

  const startC = getCountry(legs[0]?.origin);
  const endC = getCountry(legs[legs.length - 1]?.destination);
  if (startC) set.delete(startC);
  if (endC) set.delete(endC);
  return set.size;
}

function sumCost(legs) {
  return legs.reduce((s, l) => s + (Number(l.price_gbp) || 0), 0);
}

function totalDurationMin(legs) {
  // use depart/arrive if available, otherwise sum durations
  const firstDep = legs[0]?.depart_at ? new Date(legs[0].depart_at) : null;
  const lastArr = legs[legs.length - 1]?.arrive_at ? new Date(legs[legs.length - 1].arrive_at) : null;

  if (firstDep && lastArr) return Math.max(0, Math.round((lastArr - firstDep) / 60000));

  let sum = 0;
  for (const l of legs) sum += Number(l.duration_min) || 0;
  return sum || 0;
}

function layoverHours(legA, legB) {
  // layover = B.depart - A.arrive
  if (!legA?.arrive_at || !legB?.depart_at) return null;
  const a = new Date(legA.arrive_at);
  const b = new Date(legB.depart_at);
  return (b - a) / 3600000;
}

/* ================= HUBS ================= */

function buildHubList(originScope) {
  // In your UI:
  // UK, UK_EU, GLOBAL
  const scope = String(originScope || "UK_EU");

  if (scope === "UK") {
    return ["STN","LTN","LGW","LHR","MAN","EDI","GLA","BHX","BRS","DUB"];
  }

  if (scope === "GLOBAL") {
    // still hub-biased (we're not doing full world graph yet)
    return DEFAULT_HUBS.concat(["JFK","EWR","YYZ","DXB","DOH"]).filter((v, i, a) => a.indexOf(v) === i);
  }

  return DEFAULT_HUBS;
}

/* ================= SEARCH ================= */

app.post("/api/search", async (req, res) => {
  if (!hasToken()) {
    return res.json({
      mode: "MOCK",
      provider: PROVIDER,
      picks: []
    });
  }

  try {
    const body = req.body || {};

    // matches your index.html payload keys
    const from = normalizeIata(body.from || "");
    const to = normalizeIata(body.to || "");
    const date = body.date ? String(body.date) : null; // YYYY-MM-DD
    const flexDays = safeInt(body.flexDays, 0);

    const maxStops = safeInt(body.maxStops, 1); // 0..2
    const minBufferMin = safeInt(body.minBufferMin, 180);
    const maxTotalHours = safeInt(body.maxTotalHours, 24);

    const adventureLevel = Number(body.adventureLevel ?? 1);
    const originScope = String(body.originScope || "UK_EU");

    if (!to || to.length !== 3) {
      return res.status(400).json({ error: "Destination IATA required (e.g. DUS, IST, BUD)" });
    }

    // If user leaves FROM blank, we force a sensible default for now:
    // "UK + Europe" => use UK airports as candidate origins
    // (Later: support “Anywhere” properly)
    let origin = from;
    if (!origin) {
      // pick a “default origin pool” (UK major airports)
      // But we still need an origin to construct 1–2 leg hacks.
      origin = "STN";
    }

    const hubs = buildHubList(originScope)
      .filter(h => h !== origin && h !== to)
      .slice(0, 30);

    // 1) baseline direct price (if exists)
    const directLegs = await tpPricesForDates(origin, to, date, flexDays);
    const baseline = directLegs.length ? Math.min(...directLegs.map(x => x.price_gbp)) : null;

    // 2) generate candidates:
    // if maxStops === 0 => only direct
    // if maxStops >= 1 => try 1 hub: origin -> hub -> to
    // if maxStops >= 2 => try 2 hubs: origin -> h1 -> h2 -> to (limited)
    const candidates = [];

    // Direct candidate
    if (directLegs.length) {
      const bestDirect = directLegs[0];
      candidates.push([bestDirect]);
    }

    if (maxStops >= 1) {
      // 1-stop hacks
      const tasks = hubs.map(async (hub) => {
        const [aList, bList] = await Promise.all([
          tpPricesForDates(origin, hub, date, flexDays),
          tpPricesForDates(hub, to, date, flexDays),
        ]);

        if (!aList.length || !bList.length) return null;

        // take best of each (you can expand later)
        const a = aList[0];
        const b = bList[0];

        // layover rules
        const layH = layoverHours(a, b);
        if (layH == null) return null;

        const minH = minBufferMin / 60;
        if (layH < minH) return null;

        // hard cap on layover to avoid “overnight for no reason”
        if (layH > 6) return null;

        const legs = [a, b];
        const durMin = totalDurationMin(legs);
        if (durMin > maxTotalHours * 60) return null;

        return legs;
      });

      const legsFound = await Promise.all(tasks);
      for (const l of legsFound) if (l) candidates.push(l);
    }

    if (maxStops >= 2) {
      // 2-stop hacks (very limited to avoid call explosion)
      const hubs2 = hubs.slice(0, 12);

      // brute-force small: origin->h1->h2->to
      for (const h1 of hubs2) {
        for (const h2 of hubs2) {
          if (h1 === h2) continue;
          if (h1 === origin || h2 === origin) continue;
          if (h1 === to || h2 === to) continue;

          const [l1, l2, l3] = await Promise.all([
            tpPricesForDates(origin, h1, date, flexDays),
            tpPricesForDates(h1, h2, date, flexDays),
            tpPricesForDates(h2, to, date, flexDays),
          ]);

          if (!l1.length || !l2.length || !l3.length) continue;

          const a = l1[0], b = l2[0], c = l3[0];

          const lay1 = layoverHours(a, b);
          const lay2 = layoverHours(b, c);
          if (lay1 == null || lay2 == null) continue;

          const minH = minBufferMin / 60;
          if (lay1 < minH || lay2 < minH) continue;
          if (lay1 > 6 || lay2 > 6) continue;

          const legs = [a, b, c];
          const durMin = totalDurationMin(legs);
          if (durMin > maxTotalHours * 60) continue;

          candidates.push(legs);

          // don’t go mental
          if (candidates.length > 60) break;
        }
        if (candidates.length > 60) break;
      }
    }

    // 3) score & pick “hacks”
    // Score prioritizes low price but rewards “extra countries” based on adventureLevel
    const scored = candidates.map(legs => {
      const cost = sumCost(legs);
      const durMin = totalDurationMin(legs);
      const countriesCount = countCountries(legs);
      const extra = extraCountries(legs);

      // baseline comparison
      const baselineNum = baseline ?? cost;

      // “pain” is time + stops penalty
      const stops = Math.max(0, legs.length - 1);
      const pain = (durMin / 60) + (stops * 1.5);

      // reward for extra countries (small, controlled)
      const bonus = extra * 25 * (Number.isFinite(adventureLevel) ? adventureLevel : 1);

      // score: lower is better
      const score = (cost - bonus) + pain * 2;

      return {
        total_cost: cost,
        total_duration_min: durMin,
        legs: legs.map(l => ({
          type: l.type,
          provider: l.provider,
          origin: l.origin,
          destination: l.destination,
          airline: l.airline,
          price_gbp: l.price_gbp,
          duration_min: l.duration_min,
          deep_link: l.deep_link
        })),
        score,
        pain,
        extraCountries: extra,
        countriesCount,
        // for your chips
        stops
      };
    });

    // Filter out rubbish:
    // If we have a baseline, only show routes <= baseline (or within a tiny buffer)
    const filtered = scored
      .filter(x => {
        if (baseline == null) return true;
        return x.total_cost <= baseline + 10; // allow a tiny wiggle
      })
      .sort((a, b) => a.score - b.score);

    // Build “picks” like original MVP: few variants
    const picks = [];

    if (filtered.length) {
      // Cheapest
      picks.push(filtered.slice().sort((a,b) => a.total_cost - b.total_cost)[0]);

      // Fastest
      picks.push(filtered.slice().sort((a,b) => a.total_duration_min - b.total_duration_min)[0]);

      // Best value (lowest score)
      picks.push(filtered[0]);

      // Cheapest with extra countries
      const extraSorted = filtered
        .filter(x => x.extraCountries >= 1)
        .sort((a,b) => a.total_cost - b.total_cost);
      if (extraSorted.length) picks.push(extraSorted[0]);

      // De-dupe identical routes
      const seen = new Set();
      const uniq = [];
      for (const p of picks) {
        const key = p.legs.map(l => `${l.origin}-${l.destination}-${l.price_gbp}`).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(p);
      }

      // only top 5
      picks.length = 0;
      picks.push(...uniq.slice(0, 5));
    }

    return res.json({
      mode: "LIVE",
      provider: PROVIDER,
      baseline: baseline,
      picks
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Search failed" });
  }
});

/* ================= STATIC ================= */

app.use("/", express.static("public"));

/* ================= START ================= */

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(
    `Atajo running on ${PORT} | mode=${hasToken() ? "LIVE" : "MOCK"} | marker=${MARKER} | airports=${airports.length}`
  );
});