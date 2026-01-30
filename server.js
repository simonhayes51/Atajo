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

/* ================= DATA ================= */

// allow either airports.json in root OR /data/airports.json
const airportsPathCandidates = [
  path.join(__dirname, "airports.json"),
  path.join(__dirname, "data", "airports.json"),
];

let airports = [];
for (const p of airportsPathCandidates) {
  if (fs.existsSync(p)) {
    airports = JSON.parse(fs.readFileSync(p, "utf8"));
    break;
  }
}
if (!airports.length) {
  console.warn("WARN: airports.json not found. Autocomplete will be empty.");
}

/* ================= APP ================= */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

/* ================= CONFIG ================= */

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";

const PROVIDER = "travelpayouts";

// keep Railway happy
const API_TIMEOUT_MS = 6500;
const MAX_HUBS_DEFAULT = 26;
const MAX_PICKS = 5;

// how many candidate flights to consider per leg
const LEG_CANDIDATES = 4;

// layover constraints
const MAX_LAYOVER_HOURS = 8; // avoids 13h “not a hack”
const MIN_LAYOVER_MIN_DEFAULT = 180; // 3h

function hasToken() {
  return TOKEN && TOKEN.length > 10;
}

function normalize(iata) {
  return String(iata || "").toUpperCase().trim();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function parseISO(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

// Travelpayouts gives duration in minutes in some fields; we handle common shapes.
function getDurationMin(row) {
  // seen: duration (minutes), duration_to (minutes)
  const d =
    row?.duration_to ??
    row?.duration ??
    row?.durationMin ??
    null;
  return Number.isFinite(Number(d)) ? Number(d) : null;
}

function addMinutes(tsMs, mins) {
  return tsMs + mins * 60_000;
}

function hoursBetween(aMs, bMs) {
  return (bMs - aMs) / 3_600_000;
}

/* ================= FETCH (timeout) ================= */

async function timeoutFetchJson(url, ms = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const r = await fetch(url, { signal: controller.signal });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e) } };
  } finally {
    clearTimeout(t);
  }
}

/* ================= HEALTH / DEBUG ================= */

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
  res.setHeader("Cache-Control", "no-store"); // stop iOS/CDN 304 weirdness

  const q = String(req.query.q || "").toLowerCase().trim();
  if (q.length < 2) return res.json([]);

  const out = airports
    .filter(a => {
      const code = String(a.code || a.iata || "").toLowerCase();
      const city = String(a.city || "").toLowerCase();
      const name = String(a.name || "").toLowerCase();
      return code.includes(q) || city.includes(q) || name.includes(q);
    })
    .slice(0, 12)
    .map(a => ({
      // return BOTH keys so your frontend works no matter what it expects
      code: String(a.code || a.iata || "").toUpperCase(),
      iata: String(a.code || a.iata || "").toUpperCase(),
      city: a.city || "",
      name: a.name || ""
    }));

  res.json(out);
});

/* ================= TP LEG SEARCH ================= */

/**
 * We use prices_for_dates as a cheap “live-ish” endpoint.
 * If date+flexDays provided, we fetch normally then filter within window.
 */
async function fetchLegCandidates(from, to, date, flexDays) {
  from = normalize(from);
  to = normalize(to);

  if (!from || !to) return [];
  if (from === to) return [];

  const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  url.searchParams.set("origin", from);
  url.searchParams.set("destination", to);
  url.searchParams.set("currency", "gbp");
  url.searchParams.set("token", TOKEN);

  // If a date is provided, we ask TP to start from it (still returns multiple dates)
  if (date) url.searchParams.set("departure_at", date);

  const r = await timeoutFetchJson(url.toString());
  const rows = Array.isArray(r.json?.data) ? r.json.data : [];
  if (!rows.length) return [];

  // Filter within ±flexDays window if provided
  let filtered = rows;
  if (date) {
    const center = Date.parse(date);
    if (Number.isFinite(center)) {
      const flex = clamp(Number(flexDays || 0), 0, 7);
      const start = center - flex * 86_400_000;
      const end = center + flex * 86_400_000;

      filtered = rows.filter(x => {
        const t = parseISO(x.departure_at);
        return t && t >= start && t <= end;
      });
    }
  }

  // Sort by price ascending, keep a few candidates
  filtered.sort((a, b) => (a.price ?? 9e9) - (b.price ?? 9e9));

  return filtered.slice(0, LEG_CANDIDATES).map(x => ({
    origin: from,
    destination: to,
    airline: x.airline || null,
    price: Number(x.price ?? 0),
    departure_at: x.departure_at,
    duration_min: getDurationMin(x),
    link: x.link || null
  }));
}

/* ================= HUBS ================= */

function getDefaultHubs(originScope) {
  // mix of UK/EU + some global “useful” hubs
  const UK_EU = [
    "STN","LTN","LGW","MAN","EDI","DUB",
    "AMS","EIN","BRU","CRL","CDG","ORY",
    "BGY","MXP","FCO","CIA","BCN","MAD",
    "LIS","OPO","BUD","VIE","PRG","WAW",
    "KRK","OTP","SOF","ATH","SKG","IST"
  ];

  const GLOBAL = [
    ...UK_EU,
    "DXB","DOH","CAI","TLV",
    "JFK","EWR","BOS","YYZ",
  ];

  if (originScope === "GLOBAL") return GLOBAL;
  if (originScope === "UK") return ["STN","LTN","LGW","MAN","EDI","DUB"];
  return UK_EU; // default UK_EU
}

/* ================= CONCURRENCY LIMIT ================= */

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;

  const workers = new Array(limit).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

/* ================= SCORING (simple MVP) ================= */

function computeRouteMeta(legs) {
  const total_cost = legs.reduce((s, l) => s + (l.price_gbp || 0), 0);
  const total_duration_min = legs.reduce((s, l) => s + (l.duration_min || 0), 0);

  const stops = Math.max(0, legs.length - 1);

  // crude “pain”: layover minutes + stop penalty
  let pain = stops * 10;
  for (let i = 0; i < legs.length - 1; i++) {
    pain += legs[i].layover_min ? Math.round(legs[i].layover_min / 30) : 0;
  }

  // score: cheaper is better, small penalty for pain
  const score = total_cost + pain;

  return { total_cost, total_duration_min, stops, pain, score };
}

/* ================= SEARCH ================= */

app.post("/api/search", async (req, res) => {
  const start = Date.now();

  if (!hasToken()) {
    return res.json({
      mode: "MOCK",
      provider: PROVIDER,
      picks: []
    });
  }

  try {
    let {
      from,
      to,
      date,
      flexDays = 0,
      originScope = "UK_EU",
      maxStops = 2,
      maxTotalHours = 24,
      minBufferMin = MIN_LAYOVER_MIN_DEFAULT,
      adventureLevel = 1,
      includeTrains = true
    } = req.body || {};

    from = normalize(from);
    to = normalize(to);

    flexDays = clamp(Number(flexDays || 0), 0, 7);
    maxStops = clamp(Number(maxStops || 2), 0, 2);
    maxTotalHours = clamp(Number(maxTotalHours || 24), 6, 48);
    minBufferMin = clamp(Number(minBufferMin || 180), 60, 360);

    if (!to || to.length !== 3) {
      return res.status(400).json({ error: "Destination IATA required (e.g. DUS, IST, BUD)" });
    }

    // If origin omitted, treat as “anywhere” using hubs as candidate origins.
    const originCandidates = from ? [from] : getDefaultHubs(originScope).slice(0, 10);

    // Baseline = cheapest direct from ANY origin candidate
    let baselineCheapest = Infinity;
    let baselineLeg = null;

    // evaluate baseline direct in parallel (limited)
    const directCandidates = await mapLimit(originCandidates, 4, async (orig) => {
      const direct = await fetchLegCandidates(orig, to, date, flexDays);
      return { orig, direct };
    });

    for (const x of directCandidates) {
      if (x.direct?.length) {
        const best = x.direct[0];
        if (best.price < baselineCheapest) {
          baselineCheapest = best.price;
          baselineLeg = { orig: x.orig, row: best };
        }
      }
    }

    // If we didn’t find a direct baseline, still allow hacks (don’t kill the whole app)
    if (!Number.isFinite(baselineCheapest)) baselineCheapest = Infinity;

    // Hub list
    const hubs = getDefaultHubs(originScope)
      .filter(h => h !== to)
      .slice(0, MAX_HUBS_DEFAULT);

    // Build hack options: origin -> hub -> destination (1 stop)
    const hackRows = [];

    // Small routes: try each origin candidate
    const tasks = [];
    for (const orig of originCandidates) {
      for (const hub of hubs) {
        if (hub === orig || hub === to) continue;
        tasks.push({ orig, hub });
      }
    }

    // limit total combos (keeps calls sane)
    const limitedTasks = tasks.slice(0, 120);

    const combos = await mapLimit(limitedTasks, 6, async ({ orig, hub }) => {
      const [leg1s, leg2s] = await Promise.all([
        fetchLegCandidates(orig, hub, date, flexDays),
        fetchLegCandidates(hub, to, date, flexDays)
      ]);

      if (!leg1s.length || !leg2s.length) return null;

      // Try a few combinations to find best valid connection
      let best = null;

      for (const a of leg1s) {
        const aDep = parseISO(a.departure_at);
        const aDur = a.duration_min ?? null;
        if (!aDep || !aDur) continue;
        const aArr = addMinutes(aDep, aDur);

        for (const b of leg2s) {
          const bDep = parseISO(b.departure_at);
          const bDur = b.duration_min ?? null;
          if (!bDep || !bDur) continue;

          // Layover = b departure - a arrival
          const layoverMin = (bDep - aArr) / 60_000;
          if (layoverMin < minBufferMin) continue;
          if (layoverMin > MAX_LAYOVER_HOURS * 60) continue;

          // Total duration = a + layover + b
          const totalMin = aDur + layoverMin + bDur;
          if (totalMin > maxTotalHours * 60) continue;

          const totalCost = a.price + b.price;

          // “hack” rule: cheaper than baseline OR baseline missing
          if (Number.isFinite(baselineCheapest) && totalCost >= baselineCheapest) continue;

          if (!best || totalCost < best.totalCost) {
            best = { a, b, layoverMin, totalMin, totalCost };
          }
        }
      }

      if (!best) return null;

      return {
        orig,
        hub,
        to,
        totalCost: best.totalCost,
        totalMin: best.totalMin,
        layoverMin: best.layoverMin,
        legs: [best.a, best.b]
      };
    });

    for (const c of combos) {
      if (c) hackRows.push(c);
    }

    hackRows.sort((x, y) => x.totalCost - y.totalCost);

    // Format into the MVP “picks” structure your UI expects
    const picks = hackRows.slice(0, MAX_PICKS).map((h) => {
      const legs = h.legs.map((row, idx) => {
        const deep_link =
          row.link
            ? `https://www.aviasales.com${row.link}&marker=${encodeURIComponent(MARKER)}`
            : null;

        // attach layover on leg1 for UI chips/pain calc
        const layover_min = idx === 0 ? h.layoverMin : null;

        return {
          type: "FLIGHT",
          provider: "TP",
          origin: row.origin,
          destination: row.destination,
          airline: row.airline || null,
          price_gbp: row.price,
          duration_min: row.duration_min || null,
          depart_at: row.departure_at,
          deep_link,
          layover_min
        };
      });

      const meta = computeRouteMeta(legs);

      // Very light “adventure” numbers for now (real country counting needs a country map)
      const extraCountries = 1; // placeholder for “via hub”
      const countriesCount = 2 + extraCountries;

      return {
        ...meta,
        legs,
        extraCountries,
        countriesCount,
        // keep these fields your UI prints
        score: meta.score * (2 / clamp(Number(adventureLevel || 1), 0.5, 2)),
      };
    });

    return res.json({
      mode: "LIVE",
      provider: PROVIDER,
      took_ms: Date.now() - start,
      baseline: baselineLeg
        ? { from: baselineLeg.orig, to, price_gbp: baselineLeg.row.price, depart_at: baselineLeg.row.departure_at }
        : null,
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
    `Atajo running on ${PORT} | provider=${PROVIDER} | mode=${hasToken() ? "LIVE" : "MOCK"} | marker=${MARKER}`
  );
});