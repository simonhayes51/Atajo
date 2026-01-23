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
const AIRPORTS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "airports.json"), "utf8"));
const HUBS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "hubs.json"), "utf8"));
const RAIL_EDGES = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "rail_edges.json"), "utf8"));

/** Utility */
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function uniq(arr) { return [...new Set(arr)]; }
function byIata(iata){ return AIRPORTS.find(a => a.iata === iata); }
function countryOf(iata){ return byIata(iata)?.country || "??"; }
function metroOf(iata){ return byIata(iata)?.metro || byIata(iata)?.city || iata; }
function formatMoney(n){ return "£" + (Math.round(n * 100) / 100).toFixed(2); }

function hashToFloat(seed) {
  // deterministic 0..1
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // convert to [0,1)
  return ((h >>> 0) % 1000000) / 1000000;
}

/** Provider adapter: Amadeus (minimal). If not configured, falls back to mock offers. */
async function amadeusToken() {
  const key = process.env.AMADEUS_KEY;
  const secret = process.env.AMADEUS_SECRET;
  if (!key || !secret) return null;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: key,
    client_secret: secret
  });

  // Production vs test hosts - keep prod unless you want to swap
  const url = "https://test.api.amadeus.com/v1/security/oauth2/token";
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) {
    const txt = await res.text();
    console.error("Amadeus token error:", res.status, txt);
    return null;
  }
  const json = await res.json();
  return json.access_token;
}

async function fetchAmadeusFlightOffers({ origin, destination, date, adults = 1, max = 3 }) {
  const token = await amadeusToken();
  if (!token) return null;

  // Flight Offers Search v2
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
    return null;
  }
  const json = await res.json();

  // Normalize into our edge format
  const offers = (json.data || []).map(off => {
    const itin = off.itineraries?.[0];
    const segs = itin?.segments || [];
    const dep = segs[0]?.departure?.at;
    const arr = segs[segs.length - 1]?.arrival?.at;
    const dur = itin?.duration || "PT0M";
    const mins = parseISODurationToMinutes(dur);
    const price = Number(off.price?.total || "9999");
    const airline = segs[0]?.carrierCode || "XX";
    return {
      type: "FLIGHT",
      origin, destination,
      depart_ts: dep, arrive_ts: arr,
      duration_min: mins,
      price_gbp: price,
      provider: "AMADEUS",
      airline
    };
  });

  return offers;
}

function parseISODurationToMinutes(iso) {
  // Very small parser for "PT#H#M"
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  return h * 60 + min;
}

function mockFlightOffers({ origin, destination, date, max = 3 }) {
  const base = 12 + 180 * hashToFloat(`${origin}-${destination}-${date}-base`);
  const offers = [];
  for (let i = 0; i < max; i++) {
    const jitter = 0.75 + 0.6 * hashToFloat(`${origin}-${destination}-${date}-j${i}`);
    const price = Math.max(8, Math.round(base * jitter));
    const duration = 55 + Math.round(240 * hashToFloat(`${origin}-${destination}-${date}-d${i}`));
    const departHour = 6 + Math.floor(14 * hashToFloat(`${origin}-${destination}-${date}-h${i}`));
    const depart = `${date}T${String(departHour).padStart(2,"0")}:00:00`;
    const arrive = `${date}T${String(clamp(departHour + Math.ceil(duration/60), 0, 23)).padStart(2,"0")}:${String(duration%60).padStart(2,"0")}:00`;
    offers.push({
      type: "FLIGHT",
      origin, destination,
      depart_ts: depart,
      arrive_ts: arrive,
      duration_min: duration,
      price_gbp: price,
      provider: "MOCK",
      airline: "LCC"
    });
  }
  // sort cheapest first
  offers.sort((a,b)=>a.price_gbp-b.price_gbp);
  return offers;
}

async function getFlightOffers(params) {
  const live = await fetchAmadeusFlightOffers(params);
  if (live && live.length) return live;
  return mockFlightOffers(params);
}

/** Rail edges expanded to airport-airport edges using metro grouping */
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
    for (const fa of fromAirports) for (const ta of toAirports) {
      edges.push({
        type: "TRAIN",
        origin: fa,
        destination: ta,
        duration_min: e.duration_min,
        price_low: e.price_low,
        price_mid: e.price_mid,
        notes: e.notes
      });
      edges.push({
        type: "TRAIN",
        origin: ta,
        destination: fa,
        duration_min: e.duration_min,
        price_low: e.price_low,
        price_mid: e.price_mid,
        notes: e.notes
      });
    }
  }
  return edges;
}
const RAIL_AIRPORT_EDGES = buildRailAirportEdges();

/** Route search (MVP)
 * We enumerate:
 *  - direct: O->D
 *  - 1-stop: O->H->D
 *  - 2-stop: O->H1->H2->D (small pruning)
 * plus optional train edges as replacement for a leg if cheaper.
 */
function pickOrigins(from, originScope) {
  if (from && from.length === 3) return [from.toUpperCase()];
  // v1: if "ANYWHERE" return top list (HUBS plus some UK)
  const uk = ["NCL","EDI","GLA","MAN","LHR","LGW","STN","LTN","BHX","BRS","DUB"];
  if (originScope === "UK") return uk;
  if (originScope === "EUROPE") return uniq([...HUBS, ...uk]);
  return uniq([...HUBS, ...uk]);
}

function pickDestinations(to) {
  if (to && to.length === 3) return [to.toUpperCase()];
  // If a city name, match airports by city/metro
  const q = String(to||"").toLowerCase();
  const matches = AIRPORTS.filter(a =>
    a.city.toLowerCase().includes(q) ||
    (a.metro||"").toLowerCase().includes(q) ||
    a.name.toLowerCase().includes(q)
  ).map(a => a.iata);
  return matches.slice(0, 6);
}

function scoreItinerary(it, prefs) {
  const stops = it.legs.length - 1;
  const countries = uniq(it.legs.flatMap(l => [countryOf(l.origin), countryOf(l.destination)])).filter(c=>c!=="??");
  const extraCountries = Math.max(0, countries.length - 1); // crude
  const airportChanges = it.legs.filter(l=>l.type==="TRANSFER").length;
  const overnight = it.legs.some(l => l.overnight);
  const tightTransfers = it.legs.some(l => l.tight);
  const pain = stops*15 + airportChanges*20 + (overnight?25:0) + (tightTransfers?40:0);
  const bonus = extraCountries * 30 * (prefs.adventureLevel || 1);
  const score = it.total_cost + pain - bonus;
  return { score, stops, countriesCount: countries.length, extraCountries, pain };
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

async function buildItineraries({ from, to, date, flexDays, maxStops, includeTrains, originScope, adventureLevel, minBufferMin, maxTotalHours }) {
  const origins = pickOrigins(from, originScope);
  const dests = pickDestinations(to);
  if (!dests.length) return { error: "Destination not recognized. Try an airport code like DUS or a major city name." };

  // Choose candidate hubs subset based on maxStops
  const hubSet = HUBS.filter(h => h !== from && !dests.includes(h));
  const hubs = hubSet.slice(0, clamp(20 + maxStops*15, 20, 80));

  // Date window
  const baseDate = new Date(date);
  const window = [];
  const fd = clamp(Number(flexDays||0), 0, 7);
  for (let i=-fd; i<=fd; i++){
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate()+i);
    window.push(d.toISOString().slice(0,10));
  }

  const itineraries = [];

  // Fetch offers for direct and to hubs (Pass A)
  const offerCache = new Map();
  async function offers(o, d, dt){
    const key = `${o}-${d}-${dt}`;
    if (offerCache.has(key)) return offerCache.get(key);
    const val = await getFlightOffers({ origin:o, destination:d, date:dt, max: 3 });
    offerCache.set(key, val);
    return val;
  }

  // Helper to optionally replace a leg with train if enabled and "makes sense"
  function maybeTrainLeg(origin, destination, dt) {
    if (!includeTrains) return null;
    const candidates = RAIL_AIRPORT_EDGES.filter(e => e.origin === origin && e.destination === destination);
    if (!candidates.length) return null;
    // pick mid price
    const e = candidates[0];
    return {
      type: "TRAIN",
      origin, destination,
      depart_ts: null, arrive_ts: null,
      duration_min: e.duration_min,
      price_gbp: e.price_low,
      provider: "RAIL_EST",
      notes: e.notes
    };
  }

  for (const dt of window) {
    for (const o of origins) {
      // Direct to each destination
      for (const d of dests) {
        const offs = await offers(o,d,dt);
        for (const off of offs) {
          const legs = [off];
          const totalCost = off.price_gbp;
          const totalDur = off.duration_min;
          itineraries.push({ legs, total_cost: totalCost, total_duration_min: totalDur, date: dt });
        }
      }

      if (maxStops >= 1) {
        // 1-stop via hubs
        for (const h of hubs) {
          const oh = await offers(o,h,dt);
          // prune: only consider cheapest offer for o->h
          const ohBest = oh[0];
          if (!ohBest) continue;

          // For second leg, allow dt same day (v1 simplification)
          for (const d of dests) {
            // If rail is possible between hub and dest airport, allow as alternative leg
            const trainAlt = maybeTrainLeg(h, d, dt);
            let hdOffers = await offers(h,d,dt);
            const secondLegs = [];
            if (hdOffers[0]) secondLegs.push(hdOffers[0]);
            if (trainAlt) secondLegs.push(trainAlt);

            for (const leg2 of secondLegs) {
              const legs = [ohBest, leg2].map(l=>({ ...l }));
              // layover estimate
              const lay = estimateLayover(legs[0], legs[1], minBufferMin);
              legs[1].overnight = lay.overnight;
              legs[1].tight = lay.tight;

              const totalCost = legs.reduce((s,l)=>s+l.price_gbp,0);
              const totalDur = legs.reduce((s,l)=>s+l.duration_min,0) + (lay.mins && lay.mins>0 ? lay.mins : 0);
              itineraries.push({ legs, total_cost: totalCost, total_duration_min: totalDur, date: dt });
            }
          }
        }
      }

      if (maxStops >= 2) {
        // 2-stop: O -> H1 -> H2 -> D with pruning
        // pick top few H1 based on cheapness from O
        const h1Candidates = [];
        for (const h1 of hubs.slice(0, 40)) {
          const oh1 = await offers(o,h1,dt);
          if (oh1[0]) h1Candidates.push({ h: h1, price: oh1[0].price_gbp, leg: oh1[0] });
        }
        h1Candidates.sort((a,b)=>a.price-b.price);
        const topH1 = h1Candidates.slice(0, 10);

        for (const h1 of topH1) {
          // choose H2 among hubs but limited
          for (const h2 of hubs.slice(0, 30)) {
            if (h2 === h1.h) continue;
            const h1h2 = await offers(h1.h, h2, dt);
            if (!h1h2[0]) continue;

            for (const d of dests) {
              const trainAlt = maybeTrainLeg(h2, d, dt);
              const h2d = await offers(h2, d, dt);
              const thirdLegs = [];
              if (h2d[0]) thirdLegs.push(h2d[0]);
              if (trainAlt) thirdLegs.push(trainAlt);

              for (const leg3 of thirdLegs) {
                const legs = [{...h1.leg}, {...h1h2[0]}, {...leg3}];
                const lay1 = estimateLayover(legs[0], legs[1], minBufferMin);
                legs[1].overnight = lay1.overnight; legs[1].tight = lay1.tight;
                const lay2 = estimateLayover(legs[1], legs[2], minBufferMin);
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
  }

  // Filter by max total hours
  const maxMins = (Number(maxTotalHours||48) * 60);
  const filtered = itineraries.filter(it => it.total_duration_min <= maxMins);

  // Deduplicate roughly by leg sequence
  const seen = new Set();
  const deduped = [];
  for (const it of filtered) {
    const sig = it.legs.map(l=>`${l.type}:${l.origin}-${l.destination}`).join("|") + `@${it.date}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(it);
  }

  // Score and rank
  const prefs = { adventureLevel: Number(adventureLevel||1) };
  const scored = deduped.map(it => {
    const meta = scoreItinerary(it, prefs);
    return { ...it, ...meta };
  }).sort((a,b)=>a.score-b.score);

  // Build variants
  const cheapest = scored[0];
  const bestValue = scored.slice().sort((a,b)=>(a.total_cost + a.pain) - (b.total_cost + b.pain))[0];
  const fastestCheap = scored.slice().sort((a,b)=>a.total_duration_min-b.total_duration_min)[0];
  const with2Countries = scored.find(r => r.countriesCount >= 3) || null; // countriesCount includes start + end
  const trainHack = scored.find(r => r.legs.some(l=>l.type==="TRAIN")) || null;

  const pickList = uniq([cheapest, bestValue, fastestCheap, with2Countries, trainHack].filter(Boolean))
    .slice(0, 6);

  const baseline = scored.slice().sort((a,b)=>a.total_cost-b.total_cost)[0];

  return {
    query: { from, to, date, flexDays, maxStops, includeTrains, originScope, adventureLevel, minBufferMin, maxTotalHours },
    baseline,
    itineraries: pickList,
    more: scored.slice(0, 20)
  };
}

/** Routes */
app.get("/health", (req,res)=>res.json({ ok:true, name:"atajo-mvp" }));

app.get("/api/places", (req,res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = AIRPORTS
    .filter(a =>
      a.iata.toLowerCase().includes(q) ||
      a.city.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      (a.metro||"").toLowerCase().includes(q)
    )
    .slice(0, 12)
    .map(a => ({
      iata: a.iata,
      label: `${a.city} (${a.iata}) — ${a.name}`,
      city: a.city,
      country: a.country,
      metro: a.metro
    }));
  res.json({ results });
});

app.post("/api/search", async (req,res) => {
  try {
    const body = req.body || {};
    const result = await buildItineraries({
      from: body.from || null,
      to: body.to,
      date: body.date || new Date().toISOString().slice(0,10),
      flexDays: body.flexDays ?? 3,
      maxStops: clamp(Number(body.maxStops ?? 2), 0, 3),
      includeTrains: Boolean(body.includeTrains ?? true),
      originScope: body.originScope || "EUROPE",
      adventureLevel: clamp(Number(body.adventureLevel ?? 1.0), 0, 2),
      minBufferMin: clamp(Number(body.minBufferMin ?? 180), 60, 720),
      maxTotalHours: clamp(Number(body.maxTotalHours ?? 48), 6, 120)
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Search failed", detail: String(e) });
  }
});

// Serve frontend
app.use("/", express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Atajo MVP running on :${port}`));
