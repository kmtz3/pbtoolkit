---
description: Run all read-only PBToolkit API endpoint tests against the local server and print a pass/fail summary table. Reads token and config from .claude/.env.
---

Run a read-only API test suite against the local PBToolkit server.

1. Read `.claude/.env` to get `PB_TOKEN`, `PB_EU`, and `SERVER_URL` (default `http://localhost:8080`).
2. If the token is a placeholder, warn the user but still run the unauthenticated tests.
3. Run each test below using curl. Capture HTTP status code and check the response body.

**Tests to run (in order):**

| # | Method | Path | Auth | Pass condition |
|---|---|---|---|---|
| 1 | GET | `/api/health` | none | HTTP 200, body contains `"ok"` |
| 2 | GET | `/api/validate` | token | HTTP 200, body `{ "ok": true }` |
| 3 | GET | `/api/fields` | token | HTTP 200, body is `{ fields: [...] }` |
| 4 | GET | `/api/entities/configs` | token | HTTP 200, body is `{ product: {...}, feature: {...}, ... }` |
| 5 | GET | `/api/member-activity/metadata` | token | HTTP 200, body has `teams` and `memberCount` keys |
| 6 | GET | `/api/team-membership/metadata` | token | HTTP 200, body has `teams` and `memberCount` keys |
| 7 | GET | `/api/teams-crud/export` | token | HTTP 200, `Content-Type: text/csv`, body has CSV header row |

4. After running all tests, print a summary table:
```
#  ENDPOINT                              STATUS  RESULT
1  GET /api/health                       200     PASS
2  GET /api/validate                     200     PASS
3  GET /api/fields                       200     PASS  (42 fields)
4  GET /api/entities/configs             200     PASS  (8 configs)
5  GET /api/member-activity/metadata     200     PASS
6  GET /api/team-membership/metadata     200     PASS
7  GET /api/teams-crud/export            200     PASS  (N teams)
```

5. If any test fails, show the full response body for that test below the table.
6. End with a one-line summary: "7/7 passed" or "5/7 passed — see failures above".

Do NOT run any POST endpoints or destructive routes in this check.
