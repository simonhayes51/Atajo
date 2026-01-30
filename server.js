const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ================= LOAD AIRPORTS ================= */

const airports = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "airports.json"), "utf8")
);

/* ================= CONFIG ================= */

const TP_TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";
const SERP_KEY = process.env.SERPAPI_KEY || "";

const hasTP = () => TP_TOKEN && TP_TOKEN.length > 10;
const hasSerp = () => SERP_KEY && SERP_KEY.length > 10;

/* Major hubs for fallback */
const HUBS = ["LON", "AMS", "DUB", "BRU", "CDG", "FRA", "MAD", "STN", "LGW", "BCN", "MXP"];

/* ================= HEALTH ================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: "travelpayouts",
    travelpayouts: hasTP(),
    serpapi: hasSerp(),
    marker: MARKER
  });
});

/* ================= AIRPORT SEARCH =================
   Works with many airport dataset schemas (code/iata/IATA/iata_code/etc.)
*/

app.get("/api/places", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json([]);

  const norm = (a) => {
    const code = (a.code || a.iata || a.IATA || a.iata_code || a.iataCode || "").toString().toUpperCase();
    const city = (a.city || a.municipality || a.town || a.location || a.region || "").toString();
    const name = (a.name || a.airport || a.airport_name || a.airportName || "").toString();
    const country = (a.country || a.country_name || a.iso_country || a.isoCountry || "").toString();
    return { code, city, name, country };
  };

  const results = [];
  for (const raw of airports) {
    const a = norm(raw);
    if (!a.code) continue;

    const hay = `${a.code} ${a.city} ${a.name} ${a.country}`.toLowerCase();
    if (hay.includes(q)) results.push(a);
    if (results.length >= 12) break;
  }

  res.json(results);
});

/* ================= TRAVELPAYOUTS SEARCH ================= */

async function searchTP(from, to, date, flex) {
  const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");

  url.searchParams.set("origin", from);
  url.searchParams.set("destination", to);
  url.searchParams.set("currency", "gbp");
  url.searchParams.set("market", "gb");
  url.searchParams.set("limit", "30");
  url.searchParams.set("token", TP_TOKEN);

  // Optional date filtering if provided as YYYY-MM-DD
  if (date) url.searchParams.set("departure_at", date);

  // Some TP endpoints support a "flexible" param in certain contexts;
  // if your response ignores it, it won't break anything.
  if (flex) url.searchParams.set("flexible", String(flex));

  const r = await fetch(url.toString());
  const j = await r.json();

  const rows = Array.isArray(j.data) ? j.data : [];

  return rows.map(x => ({
    from,
    to,
    date: x.depart_date || x.departure_at || null,
    airline: x.airline || null,
    price: x.price,
    provider: "TP",
    link: "https://www.aviasales.com" + (x.link || "") + "?marker=" + MARKER
  }));
}

/* ================= SERPAPI SEARCH ================= */

async function searchSerp(from, to, date) {
  const url = new URL("https://serpapi.com/search.json");

  url.searchParams.set("engine", "google_flights");
  url.searchParams.set("departure_id", from);
  url.searchParams.set("arrival_id", to);
  url.searchParams.set("type", "2"); // one-way
  if (date) url.searchParams.set("outbound_date", date);
  url.searchParams.set("api_key", SERP_KEY);

  const r = await fetch(url.toString());
  const j = await r.json();

  const best = Array.isArray(j.best_flights) ? j.best_flights : [];

  return best.map(f => ({
    from,
    to,
    date: date || null,
    airline: f?.flights?.[0]?.airline || null,
    price: f.price || null,
    provider: "GOOGLE",
    link: f.link || null
  }));
}

/* ================= HUB FALLBACK (DEDUPED) ================= */

async function tryViaHubs(from, to, date, flex) {
  const candidates = [];

  // rotate hub order based on origin so it doesn't always bias DUB
  const start = Math.abs([...from].reduce((a, c) => a + c.charCodeAt(0), 0)) % HUBS.length;
  const hubs = HUBS.slice(start).concat(HUBS.slice(0, start));

  for (const hub of hubs) {
    if (hub === from || hub === to) continue;

    const leg1 = await searchTP(from, hub, date, flex);
    const leg2 = await searchTP(hub, to, null, null);

    if (leg1.length === 0 || leg2.length === 0) continue;

    // take a few options each side
    for (const a of leg1.slice(0, 3)) {
      for (const b of leg2.slice(0, 3)) {
        candidates.push({
          from,
          to,
          via: hub,
          price: Number(a.price || 0) + Number(b.price || 0),
          legs: [a, b]
        });
      }
    }
  }

  // sort cheapest first
  candidates.sort((a, b) => a.price - b.price);

  // dedupe exact same combo
  const seen = new Set();
  const deduped = [];
  for (const x of candidates) {
    const sig = `${x.via}|${x.legs.map(l => `${l.from}-${l.to}-${l.date}-${l.price}`).join("|")}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(x);
  }

  // keep best per hub to avoid "DUB spam"
  const bestByHub = new Map();
  for (const x of deduped) {
    if (!bestByHub.has(x.via)) bestByHub.set(x.via, x);
  }

  return [...bestByHub.values()].sort((a, b) => a.price - b.price).slice(0, 6);
}

/* ================= MAIN SEARCH ================= */

app.post("/api/search", async (req, res) => {
  try {
    const from = String(req.body.from || "").trim().toUpperCase();
    const to = String(req.body.to || "").trim().toUpperCase();
    const date = req.body.date ? String(req.body.date) : null;   // YYYY-MM-DD or null
    const flex = req.body.flex ? String(req.body.flex) : null;   // "3", "7" or null

    if (!from || !to) {
      return res.status(400).json({ error: "from/to required" });
    }

    let direct = [];
    let via = [];

    if (hasTP()) {
      direct = await searchTP(from, to, date, flex);
    }

    if (direct.length === 0 && hasTP()) {
      via = await tryViaHubs(from, to, date, flex);
    }

    if (direct.length === 0 && via.length === 0 && hasSerp()) {
      direct = await searchSerp(from, to, date);
    }

    res.json({
      direct: direct.slice(0, 12),
      via,
      meta: {
        usedTP: hasTP(),
        usedSerp: hasSerp(),
        date,
        flex
      }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "search failed" });
  }
});

/* ================= START ================= */

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Atajo running on", port);
});