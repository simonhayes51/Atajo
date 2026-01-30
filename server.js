
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const airports = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "data", "airports.json"),
    "utf8"
  )
);

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";

const hasToken = () => TOKEN && TOKEN.length > 10;

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: "travelpayouts",
    mode: hasToken() ? "LIVE" : "MOCK",
    marker: MARKER
  });
});

app.get("/api/places", (req, res) => {
  const q = (req.query.q || "").toLowerCase();
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

app.post("/api/search", async (req, res) => {
  if (!hasToken()) return res.json({ results: [] });

  const { from, to } = req.body;

  try {
    const url =
      "https://api.travelpayouts.com/aviasales/v3/prices_for_dates" +
      `?origin=${from}&destination=${to}&currency=gbp&token=${TOKEN}`;

    const r = await fetch(url);
    const j = await r.json();

    const rows = j.data || [];

    const results = rows.slice(0, 15).map(x => ({
      origin: from,
      destination: to,
      date: x.depart_date,
      airline: x.airline,
      price: x.price,
      link: "https://www.aviasales.com" + x.link + "?marker=" + MARKER
    }));

    res.json({ results });

  } catch (e) {
    res.status(500).json({ error: "search failed" });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Atajo running on", port);
});
