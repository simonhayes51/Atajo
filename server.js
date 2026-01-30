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

const airports = JSON.parse(
  fs.readFileSync(path.join(__dirname, "airports.json"), "utf8")
);

/* ================= APP ================= */

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

/* ================= CONFIG ================= */

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";

const MAX_HUBS = 25;
const MAX_RESULTS = 20;
const API_TIMEOUT = 8000; // 8s per call

function hasToken() {
  return TOKEN.length > 10;
}

/* ================= UTILS ================= */

function timeoutFetch(url, ms = API_TIMEOUT) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);

  return fetch(url, { signal: controller.signal });
}

function normalize(iata) {
  return String(iata || "").toUpperCase().trim();
}

/* ================= HEALTH ================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: "travelpayouts",
    mode: hasToken() ? "LIVE" : "MOCK",
    marker: MARKER
  });
});

/* ================= AUTOCOMPLETE ================= */

app.get("/api/places", (req, res) => {
  const q = String(req.query.q || "").toLowerCase();

  if (q.length < 2) return res.json([]);

  const out = airports
    .filter(a =>
      a.code.toLowerCase().includes(q) ||
      a.city.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q)
    )
    .slice(0, 10);

  res.json(out);
});

/* ================= TP LEG ================= */

async function fetchLeg(from, to, date, flex) {
  from = normalize(from);
  to = normalize(to);

  if (!from || !to) return [];
  if (from === to) return [];

  const url = new URL(
    "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"
  );

  url.searchParams.set("origin", from);
  url.searchParams.set("destination", to);
  url.searchParams.set("currency", "gbp");
  url.searchParams.set("token", TOKEN);

  if (date) url.searchParams.set("departure_at", date);
  if (flex) url.searchParams.set("flex", flex);

  try {
    const r = await timeoutFetch(url.toString());
    const j = await r.json();

    return Array.isArray(j.data) ? j.data : [];

  } catch {
    return [];
  }
}

/* ================= HUB SELECTION ================= */

function getHubs(from) {
  // Cheap European hubs + LCC bases
  const hubs = [
    "STN","LTN","MAN","EDI","DUB",
    "AMS","EIN","CRL","BGY","MXP",
    "BCN","MAD","BUD","VIE","PRG",
    "WAW","KRK","OTP","SOF","ATH",
    "FCO","CIA","NAP","MIL","BER"
  ];

  return hubs
    .filter(h => h !== from)
    .slice(0, MAX_HUBS);
}

/* ================= SEARCH ================= */

app.post("/api/search", async (req, res) => {
  const start = Date.now();

  if (!hasToken()) {
    return res.json({ results: [] });
  }

  try {
    let {
      from,
      to,
      date,
      flex,
      maxHours = 24,
      buffer = 3
    } = req.body;

    from = normalize(from);
    to = normalize(to);

    if (!to) {
      return res.status(400).json({ error: "Destination required" });
    }

    /* ---------- DIRECT ---------- */

    const direct = await fetchLeg(from, to, date, flex);

    let baseline = Infinity;

    if (direct.length) {
      baseline = Math.min(...direct.map(x => x.price));
    }

    /* ---------- HUBS ---------- */

    const hubs = getHubs(from);

    const hacks = [];

    for (const hub of hubs) {

      if (hub === to) continue;

      const [leg1, leg2] = await Promise.all([
        fetchLeg(from, hub, date, flex),
        fetchLeg(hub, to, date, flex)
      ]);

      if (!leg1.length || !leg2.length) continue;

      const a = leg1[0];
      const b = leg2[0];

      const price = a.price + b.price;

      if (price >= baseline) continue;

      const layover =
        (new Date(b.departure_at) -
         new Date(a.departure_at)) / 3600000;

      if (layover < buffer || layover > 12) continue;

      hacks.push({
        price,
        route: [a, b],
        hub
      });

      if (hacks.length >= MAX_RESULTS) break;
    }

    hacks.sort((a,b) => a.price - b.price);

    /* ---------- FORMAT ---------- */

    const results = hacks.map(h => ({
      price: h.price,
      via: h.hub,
      legs: h.route.map(x => ({
        from: x.origin,
        to: x.destination,
        airline: x.airline,
        price: x.price,
        date: x.departure_at,
        link:
          "https://www.aviasales.com" +
          x.link +
          "?marker=" +
          MARKER
      }))
    }));

    res.json({
      took_ms: Date.now() - start,
      baseline,
      count: results.length,
      results
    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: "Search failed"
    });
  }
});

/* ================= STATIC ================= */

app.use("/", express.static("public"));

/* ================= START ================= */

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(
    "Atajo running on",
    PORT,
    "| mode=" + (hasToken() ? "LIVE" : "MOCK"),
    "| marker=" + MARKER
  );
});