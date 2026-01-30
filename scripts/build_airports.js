import fs from "fs";
import fetch from "node-fetch";

const URL =
  "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";

async function run() {
  const res = await fetch(URL);
  const text = await res.text();

  const lines = text.split("\n");

  const airports = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // CSV but messy, so regex split
    const parts = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);

    if (!parts || parts.length < 8) continue;

    const name = parts[1]?.replace(/"/g, "");
    const city = parts[2]?.replace(/"/g, "");
    const country = parts[3]?.replace(/"/g, "");
    const iata = parts[4]?.replace(/"/g, "");

    if (!iata || iata === "\\N") continue;

    airports.push({
      code: iata,
      name,
      city,
      country
    });
  }

  fs.writeFileSync(
    "airports.json",
    JSON.stringify(airports, null, 2)
  );

  console.log("Saved", airports.length, "airports");
}

run();