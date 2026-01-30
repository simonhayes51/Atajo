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

const DATA_DIR = path.join(__dirname, "data");
const REC_DIR = path.join(__dirname, "recordings");
if (!fs.existsSync(REC_DIR)) fs.mkdirSync(REC_DIR, { recursive: true });

const AIRPORTS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "airports.json"), "utf8"));
const HUBS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "hubs.json"), "utf8"));
const RAIL_EDGES = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "rail_edges.json"), "utf8"));

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function uniq(arr) { return [...new Set(arr)]; }
function byIata(iata){ return AIRPORTS.find(a => a.iata === iata); }
function countryOf(iata){ return byIata(iata)?.country || "??"; }

function hashToFloat(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000000) / 1000000;
}

function parseISODurationToMinutes(iso) {
  const m = String(iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  return h * 60 + min;
}

function safeJsonParse(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

function dataMode() {
  const mode = (process.env.DATA_MODE || "").trim().toUpperCase();
  if (mode === "MOCK" || mode === "REPLAY" || mode === "LIVE") return mode;
  if (process.env.TRAVELPAYOUTS_TOKEN) return "LIVE";
  return "MOCK";
}

const LEG_CACHE_TTL_MS = clamp(Number(process.env.LEG_CACHE_TTL_MS || 3600000), 60_000, 24*3600_000);
const API_BUDGET_DEFAULT = clamp(Number(process.env.API_BUDGET || 25), 0, 500);
const AMADEUS_COOLDOWN_MS = clamp(Number(process.env.AMADEUS_COOLDOWN_MS || 180000), 30_000, 30*60_000);

// In-memory TTL cache for leg offers
const LEG_CACHE = new Map(); // key -> { exp, value }
function cacheGet(key) {
  const hit = LEG_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { LEG_CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  LEG_CACHE.set(key, { exp: Date.now() + ttlMs, value });
}

// Recording helpers
function recFileName(provider, origin, destination, date, adults, max) {
  const safe = (v) => String(v).replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${safe(provider)}__${safe(origin)}__${safe(destination)}__${safe(date)}__adults${safe(adults)}__max${safe(max)}.json`;
}
function readRecording(fileName) {
  const p = path.join(REC_DIR, fileName);
  if (!fs.existsSync(p)) return null;
  return safeJsonParse(fs.readFileSync(p, "utf8"));
}
function writeRecording(fileName, json) {
  const p = path.join(REC_DIR, fileName);
  fs.writeFileSync(p, JSON.stringify(json, null, 2), "utf8");
}

// Amadeus TEST adapter with token caching + 429 cooldown
let AMADEUS_TOKEN = null;
let AMADEUS_TOKEN_EXP = 0;
let AMADEUS_COOLDOWN_UNTIL = 0;

async function amadeusToken() {
  const key = process.env.AMADEUS_KEY;
  const secret = process.env.AMADEUS_SECRET;
  if (!key || !secret) return null;

  const now = Date.now();
  if (AMADEUS_TOKEN && now < AMADEUS_TOKEN_EXP) return AMADEUS_TOKEN;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: key,
    client_secret: secret
  });

  const url = "https://test.api.amadeus.com/v1/security/oauth2/token";
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) {
    const txt = await res.text();
    console.error("Amadeus token error:", res.status, txt);
    return null;
  }
  const json = await res.json();
  AMADEUS_TOKEN = json.access_token;
  AMADEUS_TOKEN_EXP = now + (Number(json.expires_in || 1800) - 60) * 1000;
  return AMADEUS_TOKEN;
}

function normalizeTravelpayoutsOffers(origin, destination, json, requestedDate) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const filtered = requestedDate
    ? rows.filter(r => (r.depart_date === requestedDate) || (String(r.departure_at || "").startsWith(requestedDate)))
    : rows;

  const picks = (filtered.length ? filtered : rows).map(r => {
    const dep = r.departure_at || (r.depart_date ? `${r.depart_date}T12:00:00Z` : null);
    const durMin = Number(r.duration || r.duration_to || 0) || 0;
    let arr = null;
    if (dep && durMin > 0) {
      const t = Date.parse(dep);
      if (!Number.isNaN(t)) arr = new Date(t + durMin * 60000).toISOString();
    }
    return {
      type: "FLIGHT",
      origin, destination,
      depart_ts: dep,
      arrive_ts: arr,
      duration_min: durMin,
      price_gbp: Number(r.price || 9999),
      provider: "TRAVELPAYOUTS",
      airline: r.airline || "XX",
      deep_link: r.link ? ("https://www.aviasales.com" + r.link + "?marker=" + (process.env.TRAVELPAYOUTS_MARKER || "493900")) : null,
      transfers: Number(r.transfers || 0)
    };
  });

  picks.sort((a,b)=>a.price_gbp-b.price_gbp);
  return picks;
}

async function fetchTravelpayoutsOffers({ origin, destination, date, max = 3, budget }) {
  if (!budget || budget.remaining <= 0) return { offers: null, used: 0, budget_exhausted: true };

  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) return { offers: null, used: 0, no_token: true };

  // Budget accounting: 1 call per leg
  budget.remaining -= 1;

  const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("currency", "gbp");
  url.searchParams.set("market", "gb");
  url.searchParams.set("limit", String(Math.max(10, max * 10)));
  url.searchParams.set("token", token);

  // Narrow to requested date when provided (YYYY-MM-DD)
  if (date) url.searchParams.set("departure_at", date);

  const res = await fetch(url.toString());
  const txt = await res.text();
  const json = safeJsonParse(txt) || {};

  if (!res.ok) {
    console.error("Travelpayouts error:", res.status, txt.slice(0, 400));
    return { offers: null, used: 1, error_status: res.status };
  }

  return { offers: normalizeTravelpayoutsOffers(origin, destination, json, date).slice(0, max), used: 1, live: true };
}

async function fetchAmadeusFlightOffers({ origin, destination, date, adults = 1, max = 3, budget }) {
  if (Date.now() < AMADEUS_COOLDOWN_UNTIL) return { offers: null, used: 0, cooldown: true };
  if (!budget || budget.remaining <= 0) return { offers: null, used: 0, budget_exhausted: true };

  const token = await amadeusToken();
  if (!token) return { offers: null, used: 0, no_token: true };

  const mode = dataMode();

  const fileName = recFileName("amadeus_test", origin, destination, date, adults, max);
  if (mode === "REPLAY") {
    const rec = readRecording(fileName);
    if (!rec) return { offers: null, used: 0, missing_recording: true };
    return { offers: normalizeAmadeusOffers(origin, destination, rec), used: 0, replay: true };
  }

  if (mode === "LIVE") {
    const existing = readRecording(fileName);
    if (existing) return { offers: normalizeAmadeusOffers(origin, destination, existing), used: 0, replay: true };

    budget.remaining -= 1;

    const url = new URL("https://test.api.amadeus.com/v2/shopping/flight-offers");
    url.searchParams.set("originLocationCode", origin);
    url.searchParams.set("destinationLocationCode", destination);
    url.searchParams.set("departureDate", date);
    url.searchParams.set("adults", String(adults));
    url.searchParams.set("max", String(max));
    url.searchParams.set("currencyCode", "GBP");

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const txt = await res.text();
      console.error("Amadeus offers error:", res.status, txt);
      if (res.status === 429) AMADEUS_COOLDOWN_UNTIL = Date.now() + AMADEUS_COOLDOWN_MS;
      return { offers: null, used: 1, error_status: res.status };
    }

    const json = await res.json();
    writeRecording(fileName, json);
    return { offers: normalizeAmadeusOffers(origin, destination, json), used: 1, live: true };
  }

  return { offers: null, used: 0, mock: true };
}

function mockFlightOffers({ origin, destination, date, max = 3 }) {
  const baseSeed = `${origin}-${destination}-${date}`;
  const dist = Math.abs(hashToFloat(baseSeed) - 0.5);
  const basePrice = Math.round(12 + dist * 220);
  const baseDur = Math.round(55 + dist * 240);

  const offers = [];
  for (let i=0;i<max;i++){
    const bump = 1 + i * 0.08;
    offers.push({
      type: "FLIGHT",
      origin, destination,
      depart_ts: `${date}T10:00:00Z`,
      arrive_ts: `${date}T${String(10 + Math.floor((baseDur*bump)/60)).padStart(2,"0")}:${String(Math.floor((baseDur*bump)%60)).padStart(2,"0")}:00Z`,
      duration_min: Math.round(baseDur*bump),
      price_gbp: Math.round(basePrice*bump),
      provider: "MOCK",
      airline: "MOCK"
    });
  }
  offers.sort((a,b)=>a.price_gbp-b.price_gbp);
  return offers;
}

async function getFlightOffers({ origin, destination, date, max, budget }) {
  const key = `${dataMode()}|${origin}-${destination}-${date}-max${max}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const mode = dataMode();
  let offers = null;
  if (mode === "LIVE" || mode === "REPLAY") {
    const res = await fetchTravelpayoutsOffers({ origin, destination, date, max, budget });
    offers = res.offers;
  }
  if ((!offers || !offers.length) && dataMode() === "LIVE" && String(process.env.AMADEUS_STRICT||"").trim()==="1") {
    offers = [];
  }
  if (!offers || !offers.length) {
    offers = mockFlightOffers({ origin, destination, date, max });
  }

  cacheSet(key, offers, LEG_CACHE_TTL_MS);
  return offers;
}

// Rail edges expanded to airport-airport edges using metro grouping
function buildRailAirportEdges() {
  const byMetro = new Map();
  for (const a of AIRPORTS) {
    const m = a.metro || a.city;
    if (!byMetro.has(m)) byMetro.set(m, []);
    byMetro.get(m).push(a.iata);
  }
  const edges = [];
  for (const e of RAIL_EDGES) {
    const fromAirports = byMetro.get(e.from_city) || [];
    const toAirports = byMetro.get(e.to_city) || [];
    for (const fa of fromAirports) {
      for (const ta of toAirports) {
        edges.push({ origin: fa, destination: ta, price_gbp: e.price_gbp, duration_min: e.duration_min, from_city: e.from_city, to_city: e.to_city });
      }
    }
  }
  return edges;
}
const RAIL_AIRPORT_EDGES = buildRailAirportEdges();

app.get("/api/places", (req,res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json([]);

  const matches = AIRPORTS.filter(a =>
    a.iata.toLowerCase().includes(q) ||
    a.city.toLowerCase().includes(q) ||
    a.name.toLowerCase().includes(q)
  );

  // Prefer starts-with matches
  matches.sort((a,b)=>{
    const as = a.iata.toLowerCase().startsWith(q) || a.city.toLowerCase().startsWith(q) || a.name.toLowerCase().startsWith(q);
    const bs = b.iata.toLowerCase().startsWith(q) || b.city.toLowerCase().startsWith(q) || b.name.toLowerCase().startsWith(q);
    return (bs?1:0)-(as?1:0);
  });

  return res.json(matches.slice(0, 8).map(a => ({ iata: a.iata, city: a.city, name: a.name, country: a.country })));
});

function pickDestinations(to) {
  const t = String(to || "").trim().toUpperCase();
  if (t.length === 3) return [t];
  // allow major city string to map to all airports in that city
  const city = String(to || "").trim().toLowerCase();
  const matches = AIRPORTS.filter(a => a.city.toLowerCase() === city).map(a=>a.iata);
  return matches.slice(0, 6);
}

function pickOrigins(from, originScope) {
  if (from && String(from).length === 3) return [String(from).toUpperCase()];

  const uk = ["NCL","EDI","GLA","MAN","LHR","LGW","STN","LTN","BHX","BRS","DUB"];
  const europe = uniq([...uk, ...HUBS]);
  const global = uniq([...europe, "JFK","EWR","LAX","SFO","ORD","MIA","YYZ","MEX","CUN","SJO","PTY","BOG","LIM","GRU","EZE","SCL","HND","NRT","ICN","HKG","SIN","BKK","KUL","DXB","DOH","AUH","SYD","MEL","AKL","DEL","BOM"]);

  if (originScope === "UK") return uk;
  if (originScope === "EUROPE" || originScope === "UK_EU") return europe;
  if (originScope === "GLOBAL") return global;

  // default
  return europe;
}

function estimateLayover(prev, next, minBufferMin) {
  if (!prev.arrive_ts || !next.depart_ts) return { mins: null, overnight: false, tight: false };
  const a = new Date(prev.arrive_ts);
  const d = new Date(next.depart_ts);
  const mins = Math.round((d - a) / 60000);
  const overnight = a.getUTCDate() !== d.getUTCDate();
  const tight = mins >= 0 && mins < minBufferMin;
  return { mins, overnight, tight };
}

function scoreItinerary(it, prefs) {
  const stops = it.legs.length - 1;
  const countries = uniq(it.legs.flatMap(l => [countryOf(l.origin), countryOf(l.destination)])).filter(c=>c!=="??");
  const extraCountries = Math.max(0, countries.length - 1);
  const overnight = it.legs.some(l => l.overnight);
  const tightTransfers = it.legs.some(l => l.tight);
  const pain = stops*15 + (overnight?25:0) + (tightTransfers?40:0);
  const bonus = extraCountries * 30 * (prefs.adventureLevel || 1);
  const score = it.total_cost + pain - bonus;
  return { score, stops, countriesCount: countries.length, extraCountries, pain };
}

function maybeTrainLeg(origin, destination, includeTrains) {
  if (!includeTrains) return null;
  const candidates = RAIL_AIRPORT_EDGES.filter(e => e.origin === origin && e.destination === destination);
  if (!candidates.length) return null;
  const best = candidates.slice().sort((a,b)=>a.price_gbp-b.price_gbp)[0];
  return {
    type: "TRAIN",
    origin, destination,
    depart_ts: null, arrive_ts: null,
    duration_min: best.duration_min,
    price_gbp: best.price_gbp,
    provider: "RAIL_EST",
    note: `Frequent rail link: ${best.from_city} → ${best.to_city}`
  };
}

async function buildItineraries({ from, to, date, flexDays, maxStops, includeTrains, originScope, adventureLevel, minBufferMin, maxTotalHours }) {
  const origins = pickOrigins(from, originScope);
  const dests = pickDestinations(to);
  if (!dests.length) return { error: "Destination not recognized. Try an airport code like DUS or a major city name." };

  const budget = { remaining: API_BUDGET_DEFAULT };

  // Destination-first hub pruning (low calls)
  const baseHubs = uniq(["DUB","AMS","BRU","CRL","CDG","ORY","BVA","BCN","MAD","LIS","OPO","MXP","BGY","FRA","HHN","CGN","BER","PRG","BUD","VIE","CPH","IST","SAW","AYT","ADB"]);
  let hubs = baseHubs.filter(h => !dests.includes(h) && h !== from);

  const baseDate = new Date(date);
  const fd = clamp(Number(flexDays||0), 0, 7);
  const window = [];
  for (let i=-fd; i<=fd; i++){
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate()+i);
    window.push(d.toISOString().slice(0,10));
  }

  const hubScores = [];
  for (const h of hubs) {
    let best = Infinity;
    for (const dt of window) {
      const d = dests[0];
      const offs = await getFlightOffers({ origin: h, destination: d, date: dt, max: 1, budget });
      if (offs[0]) best = Math.min(best, offs[0].price_gbp);
    }
    if (best < Infinity) hubScores.push({ h, best });
  }
  hubScores.sort((a,b)=>a.best-b.best);
  hubs = hubScores.slice(0, clamp(6 + maxStops*2, 6, 10)).map(x=>x.h);

  const itineraries = [];

  async function offers(o, d, dt, max=1){
    return await getFlightOffers({ origin:o, destination:d, date:dt, max, budget });
  }

  for (const dt of window) {
    for (const o of origins) {
      // direct
      const d = dests[0];
      const directOffers = await offers(o, d, dt, 2);
      for (const off of directOffers.slice(0,2)) {
        itineraries.push({ legs:[off], total_cost: off.price_gbp, total_duration_min: off.duration_min, date: dt });
      }

      if (maxStops >= 1) {
        for (const h of hubs) {
          const oh = (await offers(o,h,dt,1))[0];
          if (!oh) continue;

          const trainAlt = maybeTrainLeg(h, d, includeTrains);
          const hd = (await offers(h,d,dt,1))[0];
          for (const leg2 of [hd, trainAlt].filter(Boolean)) {
            const legs = [{...oh}, {...leg2}];
            const lay = estimateLayover(legs[0], legs[1], minBufferMin);
            if (lay.mins !== null && lay.mins > 360) continue;
            legs[1].overnight = lay.overnight;
            legs[1].tight = lay.tight;

            const totalCost = legs.reduce((s,l)=>s+l.price_gbp,0);
            const totalDur = legs.reduce((s,l)=>s+l.duration_min,0) + (lay.mins && lay.mins>0 ? lay.mins : 0);
            itineraries.push({ legs, total_cost: totalCost, total_duration_min: totalDur, date: dt });
          }
        }
      }

      if (maxStops >= 2 && budget.remaining > 0) {
        const h1List = [];
        for (const h1 of hubs) {
          const leg = (await offers(o,h1,dt,1))[0];
          if (leg) h1List.push({ h1, leg, price: leg.price_gbp });
        }
        h1List.sort((a,b)=>a.price-b.price);
        const topH1 = h1List.slice(0, 3);

        for (const {h1, leg:leg1} of topH1) {
          for (const h2 of hubs) {
            if (h2===h1) continue;
            const leg2 = (await offers(h1,h2,dt,1))[0];
            if (!leg2) continue;

            const trainAlt = maybeTrainLeg(h2, d, includeTrains);
            const leg3 = (await offers(h2,d,dt,1))[0];

            for (const finalLeg of [leg3, trainAlt].filter(Boolean)) {
              const legs = [{...leg1}, {...leg2}, {...finalLeg}];
              const lay1 = estimateLayover(legs[0], legs[1], minBufferMin);
              if (lay1.mins !== null && lay1.mins > 360) continue;
              legs[1].overnight = lay1.overnight; legs[1].tight = lay1.tight;
              const lay2 = estimateLayover(legs[1], legs[2], minBufferMin);
              if (lay2.mins !== null && lay2.mins > 360) continue;
              legs[2].overnight = lay2.overnight; legs[2].tight = lay2.tight;

              const totalCost = legs.reduce((s,l)=>s+l.price_gbp,0);
              const layMins = (lay1.mins && lay1.mins>0 ? lay1.mins : 0) + (lay2.mins && lay2.mins>0 ? lay2.mins : 0);
              const totalDur = legs.reduce((s,l)=>s+l.duration_min,0) + layMins;
              itineraries.push({ legs, total_cost: totalCost, total_duration_min: totalDur, date: dt });
            }
          }
        }
      }
    }
  }

  const maxMins = (Number(maxTotalHours||24) * 60);
  const filtered = itineraries.filter(it => it.total_duration_min <= maxMins);

  const seen = new Set();
  const deduped = [];
  for (const it of filtered) {
    const sig = it.legs.map(l=>`${l.type}:${l.origin}-${l.destination}`).join("|") + `@${it.date}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(it);
  }

  const prefs = { adventureLevel: Number(adventureLevel||1) };
  const scored = deduped.map(it => ({ ...it, ...scoreItinerary(it, prefs) }))
    .sort((a,b)=>a.score-b.score);

  const cheapest = scored[0];
  const bestValue = scored.slice().sort((a,b)=>(a.total_cost + a.pain) - (b.total_cost + b.pain))[0];
  const fastest = scored.slice().sort((a,b)=>a.total_duration_min-b.total_duration_min)[0];
  const with2Countries = scored.find(r => r.countriesCount >= 3) || null;
  const trainHack = scored.find(r => r.legs.some(l=>l.type==="TRAIN")) || null;

  const pickList = uniq([cheapest, bestValue, fastest, with2Countries, trainHack].filter(Boolean)).slice(0, 6);

  return {
    mode: dataMode(),
    apiBudgetRemaining: budget.remaining,
    query: { from, to, date, flexDays, maxStops, includeTrains, originScope, adventureLevel, minBufferMin, maxTotalHours },
    itineraries: pickList,
    more: scored.slice(0, 20)
  };
}

app.get("/health", (req,res)=>res.json({ ok:true, name:"atajo-mvp", mode: dataMode(), hasTravelpayoutsToken: Boolean(process.env.TRAVELPAYOUTS_TOKEN), marker: process.env.TRAVELPAYOUTS_MARKER || "493900", apiBudgetDefault: API_BUDGET_DEFAULT, legCacheTtlMs: LEG_CACHE_TTL_MS }));

app.get("/api/debug", (req,res) => {
  const files = fs.existsSync(REC_DIR) ? fs.readdirSync(REC_DIR).slice(0,10) : [];
  res.json({
    mode: dataMode(),
    hasToken: Boolean(process.env.TRAVELPAYOUTS_TOKEN),
    marker: process.env.TRAVELPAYOUTS_MARKER || "493900",
    apiBudgetDefault: API_BUDGET_DEFAULT,
    legCacheTtlMs: LEG_CACHE_TTL_MS,
    legCacheSize: LEG_CACHE.size,
    recordingsCount: files.length,
    sampleRecordings: files
  });
});

app.post("/api/search", async (req,res) => {
  try {
    const body = req.body || {};
    const result = await buildItineraries({
      from: body.from || null,
      to: body.to,
      date: body.date || new Date().toISOString().slice(0,10),
      flexDays: body.flexDays ?? 0,
      maxStops: clamp(Number(body.maxStops ?? 1), 0, 3),
      includeTrains: Boolean(body.includeTrains ?? true),
      originScope: body.originScope || "UK",
      adventureLevel: clamp(Number(body.adventureLevel ?? 1.0), 0, 2),
      minBufferMin: clamp(Number(body.minBufferMin ?? 180), 60, 720),
      maxTotalHours: clamp(Number(body.maxTotalHours ?? 24), 6, 120)
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Search failed", detail: String(e) });
  }
});

app.use("/", express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(
    `Atajo MVP running on :${port} | mode=${dataMode()} | budget=${API_BUDGET_DEFAULT}`
  );
});