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
