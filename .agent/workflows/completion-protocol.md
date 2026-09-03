> **SUPERSEDED 2026-09-03 - READ THIS FIRST.**
> Club Arena no longer publishes by committing its build into the World Hub
> repo. It publishes by rsync to its own origin, `https://ca-static.smarter.poker`
> (`/srv/club-arena` on the Hetzner box: `releases/<ca_sha>/`, an atomically
> swapped `current` symlink, an additive `pool/`), and the World Hub carries a
> single Next.js rewrite `/hub/club-arena/:path*` to it. `public/hub/club-arena/`
> is GONE from that repo and a law test refuses to let it back.
>
> **Every `sync-club-arena.sh` / `build-club-arena.sh` / `sync-to-world-hub.sh`
> command below is dead.** Those scripts are deleted from `main`. If you find one
> on disk you are on a stale branch - it still works, and running it would
> re-vendor the bundle and shadow the origin.
>
> **You do not publish by hand at all now:** push a branch, and
> `agent-open-pr` -> `agent-autopilot` -> `publish-club-arena` does the rest.
> The current path is `.agent/architecture/deploy-paths.md`.

---

## description: MANDATORY end-of-task protocol — push to GitHub, deploy to Vercel, write SQL LAST

# Task Completion Protocol — MANDATORY FOR ALL AGENTS

> **ZERO EXCEPTIONS — Every agent MUST follow this protocol at the end of every task.**

> [!CAUTION]
> **If your deploy isn't showing up on smarter.poker — READ THIS FIRST:**
> `/deploy-troubleshooting` — the full guide covering every known failure mode.
> The #1 silent killer: a broken build in Club Arena means NOTHING ever reaches Vercel.
> **Always verify the build succeeds before doing anything else.**

## The Three Rules

### Rule 1: ALL Testing on smarter.poker ONLY

- **NEVER** test on `localhost`, `127.0.0.1`, or any local dev server
- **NEVER** test on `club-arena.vercel.app` or any Vercel preview app
- **ONLY** test on `https://smarter.poker` (production)
- See `/browser-testing` workflow for full details

### Rule 2: Push ALL Work to GitHub + Vercel

After you are **fully finished building and testing**, you MUST:

1. **Push Club Arena to GitHub:**

```bash
cd /Users/smarter.poker/Documents/club-arena
npx tsc --noEmit
git add -A && git commit -m "your message" && git push origin main
```

2. **Build and atomically deploy to World Hub & Vercel:**

   This script handles compiling the Vite SPA, cleaning the old hashes in World Hub, safely pushing the update as an atomic commit, AND triggering Vercel – all in one command.

   ```bash
   cd /Users/smarter.poker/Documents/Smarter-Poker-World-Hub
   bash scripts/sync-club-arena.sh "chore: update Club Arena — [describe changes]"
   ```

   > [!WARNING]
   > `build-club-arena.sh` is a deprecated shim — it forwards to `sync-club-arena.sh`.
   > Always use `sync-club-arena.sh` directly. Both repos need `BypassSandbox: true`
   > for all git operations. See `/deploy-troubleshooting` for failure recovery.

3. **VERIFY the deploy actually landed (mandatory — do not skip):**

   ```bash
   # Wait ~2 minutes, then check which index bundle is live:
   curl -sL https://smarter.poker/hub/club-arena/ | grep -o 'assets/index-[^"]*\.js'
   # Compare to your local: ls ~/Documents/club-arena/dist/assets/index-*.js
   # They MUST match. If they don't — the deploy did NOT land. See /deploy-troubleshooting.
   ```

````

4. **Verify deployment on production:**
```bash
# Wait for Vercel to deploy, then verify
open https://smarter.poker/hub/club-arena/
````

### Rule 3: Write SQL LAST — After Building and Testing

- **DO NOT** write SQL migrations until you are 100% done with code changes and testing
- SQL migrations are the FINAL step — they go to production immediately and cannot be undone
- Write SQL to `supabase/migrations/` with timestamped filenames
- Execute via the programmatic CLI: `npm run db:push` (from World Hub)
- **NEVER** open the Supabase web dashboard to run SQL (Cloudflare Captcha will block you)

## Execution Order (SACRED)

```
1. WRITE CODE        — Make all changes in the Club Arena repo
2. BUILD VERIFY      — npx vite build (MUST end with ✓ — fix any errors before continuing)
3. TYPECHECK         — npx tsc --noEmit (verify no TS errors)
4. PUSH CLUB ARENA   — git add <files> && git commit && git push (BypassSandbox: true)
5. ATOMIC DEPLOY     — cd ~/Documents/Smarter-Poker-World-Hub && bash scripts/sync-club-arena.sh "message"
6. VERIFY ON PROD    — curl to check index hash matches local dist (see above)
7. TEST ON PROD      — Verify on https://smarter.poker/hub/club-arena/
8. WRITE SQL (LAST)  — Only after everything else is confirmed working
9. EXECUTE SQL       — npm run db:push (from World Hub)
```

> [!IMPORTANT]
> Step 2 is the most important step. If the Vite build fails, STOP and fix it.
> A broken build is invisible — git push succeeds, sync script runs, but NOTHING
> ever changes on production. This caused a 3-hour outage on 2026-07-25.

## What Happens If You Break This Order

- Writing SQL before code is done → schema changes go live before the code that uses them
- Testing on localhost → false confidence, bugs in production
- Not pushing to GitHub → work is lost, other agents see stale code
- Not syncing to World Hub → changes exist in Club Arena repo but are NOT deployed

## DO NOT End a Session Without

- [ ] All code changes committed and pushed to GitHub
- [ ] Club Arena code pushed to origin/main
- [ ] `npx vite build` succeeded locally before syncing
- [ ] Atomic build run via `scripts/sync-club-arena.sh` in the World Hub
- [ ] Production index hash verified via curl (matches local dist)
- [ ] SQL migrations written and executed (if any schema changes)
- [ ] MIGRATION-CHANGELOG.md updated (if migration work)

> [!TIP]
> If anything in the deploy goes wrong, read `/deploy-troubleshooting` —
> it covers every known failure mode with exact fix commands.
