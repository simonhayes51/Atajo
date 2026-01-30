import express from "express";
import cors from "cors";
import morgan from "morgan";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

/* ================= CONFIG ================= */

const TP_TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const TP_MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";

const LEG_CACHE_TTL_MS = Number(process.env.LEG_CACHE_TTL_MS || 60 * 60 * 1000); // 1h

const DEFAULT_MIN_BUFFER_MIN = Number(process.env.MIN_BUFFER_MIN || 180); // 3h
const DEFAULT_MAX_LAYOVER_MIN = Number(process.env.MAX_LAYOVER_MIN || 360); // 6h
const DEFAULT_MAX_TOTAL_HOURS = Number(process.env.MAX_TOTAL_HOURS || 48);

function hasTP() {
  return TP_TOKEN && TP_TOKEN.length > 10;
}

/* ================= LOAD DATA ================= */

const DATA_DIR = path.join(__dirname, "data");

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, rel), "utf8"));
}

const AIRPORTS = readJSON("airports.json");
const HUBS = readJSON("hubs.json");
const RAIL_EDGES = readJSON("rail_edges.json");

const AIRPORT_BY_IATA = new Map(AIRPORTS.map(a => [a.iata, a]));

function airportCountry(iata) {
  return AIRPORT_BY_IATA.get(iata)?.country || "??";
}

function uniq(arr) {
  return [...new Set(arr)];
}

/* ================= SIMPLE TTL CACHE ================= */

const LEG_CACHE = new Map(); // key -> { exp, value }

function cacheGet(key) {
  const hit = LEG_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    LEG_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  LEG_CACHE.set(key, { exp: Date.now() + ttlMs, value });
}

/* ================= HEALTH ================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: "travelpayouts",
    mode: hasTP() ? "LIVE" : "MOCK",
    hasToken: hasTP(),
    marker: TP_MARKER,
    cacheSize: LEG_CACHE.size
  });
});

/* ================= AUTOCOMPLETE ================= */

app.get("/api/places", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json([]);

  const hits = AIRPORTS.filter(a => {
    const hay = `${a.iata} ${a.city} ${a.name} ${a.country}`.toLowerCase();
    return hay.includes(q);
  });

  hits.sort((a, b) => {
    const aScore =
      (a.iata.toLowerCase().startsWith(q) ? 3 : 0) +
      (a.city.toLowerCase().startsWith(q) ? 2 : 0) +
      (a.name.toLowerCase().startsWith(q) ? 1 : 0);
    const bScore =
      (b.iata.toLowerCase().startsWith(q) ? 3 : 0) +
      (b.city.toLowerCase().startsWith(q) ? 2 : 0) +
      (b.name.toLowerCase().startsWith(q) ? 1 : 0);
    return bScore - aScore;
  });

  res.json(hits.slice(0, 10).map(a => ({
    iata: a.iata,
    city: a.city,
    name: a.name,
    country: a.country
  })));
});

/* ================= RAIL LOOKUP (STATIC) ================= */

function bestRailLeg(origin, destination) {
  if (!origin || !destination) return null;
  if (origin === destination) return null;

  const edges = RAIL_EDGES.filter(e => e.origin === origin && e.destination === destination);
  if (!edges.length) return null;

  const best = edges.slice().sort((a, b) => a.price_gbp - b.price_gbp)[0];
  return {
    type: "TRAIN",
    origin,
    destination,
    price_gbp: best.price_gbp,
    duration_min: best.duration_min,
    depart_ts: null,
    arrive_ts: null,
    provider: "RAIL_EST",
    note: best.note || "Typical rail link"
  };
}

/* ================= TRAVELPAYOUTS LEG FETCH ================= */

function normalizeTP(origin, destination, json, preferredDate) {
  const rows = Array.isArray(json?.data) ? json.data : [];

  const filtered = preferredDate
    ? rows.filter(r =>
        (r.depart_date === preferredDate) ||
        (String(r.departure_at || "").startsWith(preferredDate))
      )
    : rows;

  const use = filtered.length ? filtered : rows;

  const mapped = use.map(r => {
    const dep = r.departure_at || (r.depart_date ? `${r.depart_date}T12:00:00Z` : null);
    const durMin = Number(r.duration || r.duration_to || 0) || 0;

    let arr = null;
    if (dep && durMin > 0) {
      const t = Date.parse(dep);
      if (!Number.isNaN(t)) arr = new Date(t + durMin * 60000).toISOString();
    }

    return {
      type: "FLIGHT",
      origin,
      destination,
      price_gbp: Number(r.price || 999999),
      duration_min: durMin,
      depart_ts: dep,
      arrive_ts: arr,
      airline: r.airline || "XX",
      transfers: Number(r.transfers || 0),
      provider: "TRAVELPAYOUTS",
      deep_link: r.link
        ? ("https://www.aviasales.com" + r.link + (r.link.includes("?") ? "&" : "?") + "marker=" + TP_MARKER)
        : null
    };
  });

  mapped.sort((a, b) => a.price_gbp - b.price_gbp);
  return mapped;
}

async function fetchTPLeg(origin, destination, date, limit = 3) {
  origin = String(origin || "").toUpperCase().trim();
  destination = String(destination || "").toUpperCase().trim();

  // ✅ hard guard – prevents TP 400 spam
  if (!origin || !destination) return [];
  if (origin === destination) return [];

  const key = `tp|${origin}-${destination}-${date}|${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  if (!hasTP()) {
    const mock = [{
      type: "FLIGHT",
      origin,
      destination,
      price_gbp: 12 + Math.floor(Math.random() * 120),
      duration_min: 60 + Math.floor(Math.random() * 220),
      depart_ts: `${date}T10:00:00Z`,
      arrive_ts: `${date}T12:00:00Z`,
      airline: "MOCK",
      transfers: 0,
      provider: "MOCK",
      deep_link: null
    }];
    cacheSet(key, mock, LEG_CACHE_TTL_MS);
    return mock;
  }

  const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("currency", "gbp");
  url.searchParams.set("market", "gb");
  url.searchParams.set("limit", "30");
  url.searchParams.set("token", TP_TOKEN);
  if (date) url.searchParams.set("departure_at", date);

  const r = await fetch(url.toString());
  const txt = await r.text();
  const j = (() => { try { return JSON.parse(txt); } catch { return {}; } })();

  if (!r.ok) {
    console.error("TP leg error", r.status, txt.slice(0, 500));
    cacheSet(key, [], 5 * 60 * 1000);
    return [];
  }

  const offers = normalizeTP(origin, destination, j, date).slice(0, limit);
  cacheSet(key, offers, LEG_CACHE_TTL_MS);
  return offers;
}

/* ================= HACK SCORING ================= */

function minutesBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

function computeLayover(prevLeg, nextLeg, minBufferMin) {
  const mins = minutesBetween(prevLeg.arrive_ts, nextLeg.depart_ts);
  if (mins == null) return { mins: null, tight: false, overnight: false };
  const tight = mins >= 0 && mins < minBufferMin;
  const overnight =
    prevLeg.arrive_ts && nextLeg.depart_ts
      ? (new Date(prevLeg.arrive_ts).toDateString() !== new Date(nextLeg.depart_ts).toDateString())
      : false;
  return { mins, tight, overnight };
}

function scoreRoute(route, adventureLevel) {
  const stops = route.legs.length - 1;
  const countries = uniq(route.legs.flatMap(l => [airportCountry(l.origin), airportCountry(l.destination)])).filter(c => c !== "??");
  const extraCountries = Math.max(0, countries.length - 1);

  const pain =
    stops * 15 +
    (route.legs.some(l => l._overnight) ? 25 : 0) +
    (route.legs.some(l => l._tight) ? 40 : 0);

  const bonus = extraCountries * 30 * adventureLevel;
  const score = route.total_cost + pain - bonus;

  return { score, stops, countriesCount: countries.length, extraCountries, pain };
}

/* ================= SEARCH ENGINE ================= */

function originList(originScope, fromIataOrNull) {
  if (fromIataOrNull && String(fromIataOrNull).trim().length === 3) {
    return [String(fromIataOrNull).trim().toUpperCase()];
  }

  const UK = ["NCL","EDI","GLA","MAN","LHR","LGW","STN","LTN","BHX","BRS","LBA","DUB"];
  const EUROPE = uniq([...UK, ...HUBS]);
  const GLOBAL = uniq([
    ...EUROPE,
    "JFK","EWR","LAX","SFO","ORD","MIA","YYZ","YUL","MEX","CUN","SJO","PTY","BOG","LIM","GRU","EZE","SCL",
    "HND","NRT","ICN","HKG","SIN","BKK","KUL","DXB","DOH","AUH","SYD","MEL","AKL","DEL","BOM"
  ]);

  if (originScope === "UK") return UK;
  if (originScope === "UK_EU") return EUROPE;
  if (originScope === "GLOBAL") return GLOBAL;
  return EUROPE;
}

function dateWindow(date, flexDays) {
  const base = new Date(date + "T00:00:00Z");
  const n = Math.max(0, Math.min(7, Number(flexDays || 0)));
  const out = [];
  for (let i = -n; i <= n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function buildRoutes(params) {
  const {
    from,
    to,
    date,
    flexDays,
    originScope,
    maxStops,
    adventureLevel,
    includeTrains,
    minBufferMin,
    maxTotalHours,
    maxLayoverMin
  } = params;

  const dest = String(to || "").trim().toUpperCase();
  if (dest.length !== 3) return { error: "Destination must be an IATA code (e.g. DUS, IST, BUD)." };

  const dates = dateWindow(date, flexDays);

  // ✅ also remove dest from origins early
  const origins = originList(originScope, from).filter(o => o !== dest);

  const hubs = HUBS.slice(0).filter(h => h !== dest);

  const routes = [];

  async function bestLeg(o, d, dt) {
    const offers = await fetchTPLeg(o, d, dt, 2);
    return offers[0] || null;
  }

  for (const dt of dates) {
    for (const origin of origins) {
      if (origin === dest) continue; // ✅ belt & braces

      // DIRECT
      const d0 = await bestLeg(origin, dest, dt);
      if (d0) {
        routes.push({
          legs: [d0],
          total_cost: d0.price_gbp,
          total_duration_min: d0.duration_min,
          date: dt
        });
      }

      if (maxStops >= 1) {
        for (const h of hubs) {
          if (h === origin || h === dest) continue;

          const l1 = await bestLeg(origin, h, dt);
          if (!l1) continue;

          const rail2 = includeTrains ? bestRailLeg(h, dest) : null;
          const l2f = await bestLeg(h, dest, dt);
          const l2candidates = [l2f, rail2].filter(Boolean);

          for (const l2 of l2candidates) {
            const lay = computeLayover(l1, l2, minBufferMin);
            if (lay.mins != null && lay.mins > maxLayoverMin) continue;
            if (lay.mins != null && lay.mins < 0) continue;

            l2._tight = lay.tight;
            l2._overnight = lay.overnight;

            const totalCost = l1.price_gbp + l2.price_gbp;
            const totalDur =
              l1.duration_min + l2.duration_min + (lay.mins && lay.mins > 0 ? lay.mins : 0);

            routes.push({
              legs: [l1, l2],
              total_cost: totalCost,
              total_duration_min: totalDur,
              date: dt
            });
          }
        }
      }

      if (maxStops >= 2) {
        const firstHubCandidates = [];
        for (const h1 of hubs) {
          if (h1 === origin || h1 === dest) continue;
          const l1 = await bestLeg(origin, h1, dt);
          if (l1) firstHubCandidates.push({ h1, l1 });
        }

        firstHubCandidates.sort((a, b) => a.l1.price_gbp - b.l1.price_gbp);

        for (const { h1, l1 } of firstHubCandidates.slice(0, 4)) {
          for (const h2 of hubs) {
            if (h2 === origin || h2 === dest || h2 === h1) continue;

            const l2 = await bestLeg(h1, h2, dt);
            if (!l2) continue;

            const rail3 = includeTrains ? bestRailLeg(h2, dest) : null;
            const l3f = await bestLeg(h2, dest, dt);
            const l3candidates = [l3f, rail3].filter(Boolean);

            for (const l3 of l3candidates) {
              const lay1 = computeLayover(l1, l2, minBufferMin);
              if (lay1.mins != null && lay1.mins > maxLayoverMin) continue;
              if (lay1.mins != null && lay1.mins < 0) continue;

              l2._tight = lay1.tight;
              l2._overnight = lay1.overnight;

              const lay2 = computeLayover(l2, l3, minBufferMin);
              if (lay2.mins != null && lay2.mins > maxLayoverMin) continue;
              if (lay2.mins != null && lay2.mins < 0) continue;

              l3._tight = lay2.tight;
              l3._overnight = lay2.overnight;

              const totalCost = l1.price_gbp + l2.price_gbp + l3.price_gbp;
              const totalLay =
                (lay1.mins && lay1.mins > 0 ? lay1.mins : 0) +
                (lay2.mins && lay2.mins > 0 ? lay2.mins : 0);

              const totalDur = l1.duration_min + l2.duration_min + l3.duration_min + totalLay;

              routes.push({
                legs: [l1, l2, l3],
                total_cost: totalCost,
                total_duration_min: totalDur,
                date: dt
              });
            }
          }
        }
      }
    }
  }

  const maxMins = Math.min(Number(maxTotalHours || DEFAULT_MAX_TOTAL_HOURS), DEFAULT_MAX_TOTAL_HOURS) * 60;
  const trimmed = routes.filter(r => r.total_duration_min <= maxMins);

  const seen = new Set();
  const deduped = [];
  for (const r of trimmed) {
    const sig = r.legs.map(l => `${l.type}:${l.origin}-${l.destination}`).join("|") + "@" + r.date;
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(r);
  }

  const adv = Math.max(0, Math.min(2, Number(adventureLevel || 1)));
  const scored = deduped
    .map(r => ({ ...r, ...scoreRoute(r, adv) }))
    .sort((a, b) => a.score - b.score);

  const cheapest = scored[0] || null;
  const bestValue = scored.slice().sort((a, b) => (a.total_cost + a.pain) - (b.total_cost + b.pain))[0] || null;
  const fastest = scored.slice().sort((a, b) => a.total_duration_min - b.total_duration_min)[0] || null;
  const extraCountries = scored.find(x => x.countriesCount >= 3) || null;
  const withTrain = scored.find(x => x.legs.some(l => l.type === "TRAIN")) || null;

  const picks = uniq([cheapest, bestValue, fastest, extraCountries, withTrain].filter(Boolean));

  return {
    mode: hasTP() ? "LIVE" : "MOCK",
    provider: "travelpayouts",
    picks,
    top: scored.slice(0, 25)
  };
}

/* ================= API SEARCH ================= */

app.post("/api/search", async (req, res) => {
  try {
    const body = req.body || {};
    const out = await buildRoutes({
      from: body.from || null,
      to: body.to,
      date: body.date || new Date().toISOString().slice(0, 10),
      flexDays: Number(body.flexDays || 0),
      originScope: body.originScope || "UK_EU",
      maxStops: Math.max(0, Math.min(3, Number(body.maxStops || 1))),
      adventureLevel: Math.max(0, Math.min(2, Number(body.adventureLevel || 1))),
      includeTrains: Boolean(body.includeTrains ?? true),
      minBufferMin: Math.max(60, Math.min(720, Number(body.minBufferMin || DEFAULT_MIN_BUFFER_MIN))),
      maxTotalHours: Math.max(6, Math.min(120, Number(body.maxTotalHours || DEFAULT_MAX_TOTAL_HOURS))),
      maxLayoverMin: Math.max(60, Math.min(12 * 60, Number(body.maxLayoverMin || DEFAULT_MAX_LAYOVER_MIN)))
    });

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "search failed", detail: String(e) });
  }
});

/* ================= STATIC ================= */

app.use("/", express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Atajo running on ${port} | mode=${hasTP() ? "LIVE" : "MOCK"} | marker=${TP_MARKER}`);
});