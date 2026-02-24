---
name: Run Tests
description: Run the backend test suite with pytest
---

# Run Tests

Run the Python test suite for the backend.

## Steps

```bash
cd backend
.venv\Scripts\activate
```

Run all tests:
```bash
pytest -q
```

Run only API tests:
```bash
pytest tests/test_api.py -q
```

Run only TicTacToe tests:
```bash
pytest tests/test_tictactoe_api.py -q
```

Run a single test:
```bash
pytest tests/test_api.py::test_root -q
```

## Notes

- TicTacToe tests use an isolated in-memory SQLite database (no real data needed).
- API tests (`test_api.py`) use the real `data/euroleague.db` — run data ingestion first if tests fail with missing data.
