---
description: Validate the Productboard API token stored in .claude/.env. Hits GET /api/validate and reports whether the token is accepted.
---

Validate the Productboard API token from `.claude/.env`.

1. Read `.claude/.env` and extract `PB_TOKEN`, `PB_EU`, and `SERVER_URL` (default SERVER_URL to `http://localhost:8080`).
2. If `PB_TOKEN` is missing or still says `your_productboard_api_token_here`, tell the user to fill it in and stop.
3. Build the curl command:
   - Always include `-H "x-pb-token: $PB_TOKEN"`
   - If `PB_EU=true`, also include `-H "x-pb-eu: true"`
4. Run: `curl -s -w "\nHTTP %{http_code}" -H "x-pb-token: ..." "$SERVER_URL/api/validate"`
5. Report result:
   - HTTP 200 + `{ "ok": true }` → "Token is valid"
   - HTTP 401 → "Token is invalid — check that you copied it correctly"
   - HTTP 403 → "Token doesn't have permission for this workspace"
   - Server unreachable → "Server is not running — start it with `npm run dev`"
