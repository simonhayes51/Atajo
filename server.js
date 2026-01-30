const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const morgan = require("morgan");

const fs = require("fs");
const path = require("path");

/* ================= LOAD AIRPORTS ================= */

const airports = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "airports.json"),
    "utf8"
  )
);

/* ================= APP ================= */

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

/* ================= CONFIG ================= */

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";

function hasToken() {
  return TOKEN && TOKEN.length > 10;
}

/* ================= HEALTH ================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: "travelpayouts",
    mode: hasToken() ? "LIVE" : "MOCK",
    hasToken: hasToken(),
    marker: MARKER
  });
});

/* ================= AIRPORT SEARCH ================= */

app.get("/api/places", (req, res) => {

  const q = String(req.query.q || "").toLowerCase();

  if (q.length < 2) {
    return res.json([]);
  }

  const results = airports
    .filter(a =>
      a.code.toLowerCase().includes(q) ||
      a.city.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q)
    )
    .slice(0, 10);

  res.json(results);
});

/* ================= PROBE ================= */

app.get("/api/tp_probe", async (req, res) => {

  if (!hasToken()) {
    return res.status(400).json({
      error: "Missing TRAVELPAYOUTS_TOKEN"
    });
  }

  try {

    const url =
      "https://api.travelpayouts.com/aviasales/v3/prices_for_dates" +
      "?origin=LON&destination=CDG&currency=gbp&token=" + TOKEN;

    const r = await fetch(url);
    const j = await r.json();

    res.json({
      status: r.status,
      count: j?.data?.length || 0,
      sample: j?.data?.slice(0, 3) || []
    });

  } catch (e) {

    res.status(500).json({
      error: String(e)
    });

  }
});

/* ================= SEARCH ================= */

app.post("/api/search", async (req, res) => {

  try {

    if (!hasToken()) {
      return res.json({
        mode: "MOCK",
        results: []
      });
    }

    const { from, to } = req.body;

    if (!from || !to) {
      return res.status(400).json({
        error: "from and to required"
      });
    }

    const url =
      "https://api.travelpayouts.com/aviasales/v3/prices_for_dates" +
      "?origin=" + from.toUpperCase() +
      "&destination=" + to.toUpperCase() +
      "&currency=gbp" +
      "&token=" + TOKEN;

    const r = await fetch(url);
    const j = await r.json();

    const rows = Array.isArray(j.data) ? j.data : [];

    const results = rows.slice(0, 15).map(x => ({

      origin: from.toUpperCase(),
      destination: to.toUpperCase(),
      depart_date: x.depart_date,
      return_date: x.return_date,
      airline: x.airline,
      price_gbp: x.price,

      provider: "TRAVELPAYOUTS",

      link:
        "https://www.aviasales.com" +
        x.link +
        "?marker=" +
        MARKER

    }));

    res.json({
      mode: "LIVE",
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

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Atajo running on", port);
});