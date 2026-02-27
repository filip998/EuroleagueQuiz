---
name: Run Frontend
description: Start the EuroLeague Quiz React frontend dev server
---

# Run Frontend

Start the React (Vite) frontend development server.

## Steps

```bash
cd frontend
```

Install dependencies (first time or after changes):
```bash
npm install
```

Start the dev server:
```bash
npm run dev
```

The frontend will be available at http://localhost:5173.

Alternatively, use the startup script from the project root:
```bash
scripts\start-frontend.bat
```

## Notes

- The frontend expects the backend API running at http://localhost:8000 (CORS is configured).
- Hot module replacement (HMR) is enabled — changes to `.jsx` files reload instantly.
