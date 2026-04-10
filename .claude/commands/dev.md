---
description: Start (or restart) the PBToolkit dev server using nodemon. Kills any existing process on port 8080, then runs npm run dev in the project root.
---

Start (or restart) the PBToolkit development server.

1. Check if something is already running on port 8080:
   ```bash
   lsof -ti :8080
   ```
2. If a process is found, kill it:
   ```bash
   kill $(lsof -ti :8080)
   ```
   Wait 1 second to let the port free up.
3. Start the dev server in the background:
   ```bash
   npm run dev
   ```
   Use `run_in_background: true` so the server keeps running.
4. After ~2 seconds, verify with a health check:
   ```bash
   curl -s -w "\nHTTP %{http_code}" http://localhost:8080/api/health
   ```
5. Report: "Dev server started — listening on http://localhost:8080" or show the startup error if it failed.
