---
name: Run Data Ingestion
description: Fetch EuroLeague data from the official API into the local database
---

# Run Data Ingestion

Fetch player, team, game, and box score data from the EuroLeague API.

## Steps

```bash
cd backend
source .venv/bin/activate
```

Full ingestion (all seasons):
```bash
python -m ingestion.ingest --start-season 2000 --end-season 2025
```

Single season:
```bash
python -m ingestion.ingest --start-season 2024 --end-season 2024
```

Single step for a season:
```bash
python -m ingestion.ingest --step rosters --start-season 2024 --end-season 2024
```

## Steps available

`seasons`, `rosters`, `boxscores`, `aggregate`, `all` (default)

## Rate limiting

Set `ELQ_API_RATE_LIMIT_SECONDS` to control delay between API calls (default: 1.0s):
```bash
export ELQ_API_RATE_LIMIT_SECONDS="0.25"
python -m ingestion.ingest --start-season 2024 --end-season 2025
```

## Notes

- Boxscores make 1 API call per game (~330/season), so expect ~5-10 min per season at 0.25s rate limit.
- Data is committed per season. If a season fails, previous seasons are preserved.
