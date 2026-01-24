# Atajo MVP (Railway-ready)

A lean MVP that:
- Takes **from + to + date window + constraints**
- Finds cheap multi-leg itineraries (0–3 stops)
- Uses **live flight prices** if you set provider keys, otherwise uses a deterministic mock
- Adds **rail shortcuts** from a curated static list (estimated)

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Railway
1. Create a new Railway project → **Deploy from GitHub** (or upload this repo).
2. Set environment variables (optional but recommended):

### Amadeus (optional)
If you set these, the API will attempt live prices for single-leg searches:
- `AMADEUS_KEY`
- `AMADEUS_SECRET`

If not set, the app uses a deterministic mock that still exercises the route engine.

### Other
- `PORT` (Railway sets this automatically)

3. Deploy → open the generated URL.

## Endpoints
- `GET /health` → ok
- `GET /api/places?q=...` → airport autocomplete from bundled data
- `POST /api/search` → compute itineraries

## Notes
- This MVP is **informative** only (no booking / no rail timetables). Prices can change.
- Rail legs are approximate typical prices/durations.


## Amadeus TEST build (LIVE/REPLAY/MOCK)
This build adds:
- Token caching
- Per-leg TTL cache
- 429 cooldown (circuit breaker)
- **Record & Replay** flight-offer responses to keep call counts low
- Per-request external API call budget

### Environment variables
- `AMADEUS_KEY` and `AMADEUS_SECRET` (Amadeus Self-Service **TEST** keys)
- `DATA_MODE`: `LIVE` | `REPLAY` | `MOCK`
  - Default: `LIVE` if keys are set, else `MOCK`
- `API_BUDGET`: max external Amadeus calls per `/api/search` request (default 25)
- `LEG_CACHE_TTL_MS`: per-leg cache TTL (default 3600000 = 1h)
- `AMADEUS_COOLDOWN_MS`: cooldown after 429 (default 180000 = 3m)

### Recommended live testing settings
Use:
- `flexDays: 0` (Exact)
- `maxStops: 1`
- `originScope: UK`
These are now the UI defaults in this build.

### Recordings
Recorded Amadeus responses are saved to `recordings/` and reused automatically.
Set `DATA_MODE=REPLAY` to test with **zero** external calls.
