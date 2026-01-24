// Usage: node test-live.mjs https://YOUR-APP-URL
const BASE = process.argv[2];
if (!BASE) { console.error("Usage: node test-live.mjs https://<your-app-url>"); process.exit(1); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isoDatePlus = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); };

const TESTS = [
  { from: "NCL", to: "DUS" },
  { from: "MAN", to: "AMS" },
  { from: "EDI", to: "BER" },
  { from: "STN", to: "BGY" },
];

const payloadBase = {
  date: isoDatePlus(14),
  flexDays: 0,
  maxStops: 1,
  originScope: "UK",
  includeTrains: true,
  adventureLevel: 1,
  minBufferMin: 180,
  maxTotalHours: 24,
};

async function runOne(t) {
  const payload = { ...payloadBase, ...t };
  const res = await fetch(`${BASE}/api/search`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  const json = await res.json().catch(()=>({}));
  if (!res.ok) {
    console.log(`❌ ${t.from}→${t.to} HTTP ${res.status}`, json);
    if (res.status === 429) await sleep(60_000);
    return;
  }
  const itins = json.itineraries || [];
  const first = itins[0];
  const providers = first?.legs?.map(l=>l.provider).filter(Boolean).join(", ") || "—";
  console.log(`✅ ${t.from}→${t.to} | options=${itins.length} | cheapest=£${first?.total_cost ?? "—"} | providers=${providers} | budgetRemaining=${json.apiBudgetRemaining}`);
}

(async () => {
  console.log("Running low-call tests against:", BASE);
  for (const t of TESTS) { await runOne(t); await sleep(1500); }
  console.log("Done.");
})();