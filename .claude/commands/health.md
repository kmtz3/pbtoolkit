---
description: Check if the PBToolkit dev server is running. Curls GET /api/health and reports status.
---

Check if the PBToolkit dev server is running.

1. Read `.claude/.env` to get `SERVER_URL` (default to `http://localhost:8080` if not set or file missing).
2. Run: `curl -s -w "\nHTTP %{http_code}" "$SERVER_URL/api/health"`
3. Report in one line: either "Server is up — `{ status: 'ok' }` (HTTP 200)" or "Server is not responding at $SERVER_URL — start it with `npm run dev`".
