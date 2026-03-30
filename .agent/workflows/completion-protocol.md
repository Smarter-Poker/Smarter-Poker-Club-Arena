---
description: MANDATORY end-of-task protocol — push to GitHub, deploy to Vercel, write SQL LAST
---

# Task Completion Protocol — MANDATORY FOR ALL AGENTS

> **ZERO EXCEPTIONS — Every agent MUST follow this protocol at the end of every task.**

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

2. **Build and sync to World Hub:**
```bash
cd /Users/smarter.poker/Documents/club-arena
bash scripts/sync-to-world-hub.sh /Users/smarter.poker/Documents/Smarter-Poker-World-Hub
```

3. **Push World Hub to deploy to Vercel:**
```bash
cd /Users/smarter.poker/Documents/Smarter-Poker-World-Hub
bash scripts/git-safe-push.sh --build-check "chore: update Club Arena — [describe changes]"
```

4. **Verify deployment on production:**
```bash
# Wait for Vercel to deploy, then verify
open https://smarter.poker/hub/club-arena/
```

### Rule 3: Write SQL LAST — After Building and Testing

- **DO NOT** write SQL migrations until you are 100% done with code changes and testing
- SQL migrations are the FINAL step — they go to production immediately and cannot be undone
- Write SQL to `supabase/migrations/` with timestamped filenames
- Execute via the programmatic CLI: `npm run db:push` (from World Hub)
- **NEVER** open the Supabase web dashboard to run SQL (Cloudflare Captcha will block you)

## Execution Order (SACRED)

```
1. WRITE CODE        — Make all changes in the Club Arena repo
2. BUILD             — npm run build (verify it compiles)
3. TYPECHECK         — npx tsc --noEmit (verify no TS errors)
4. PUSH CLUB ARENA   — git add -A && git commit && git push
5. SYNC TO WORLD HUB — bash scripts/sync-to-world-hub.sh
6. PUSH WORLD HUB    — bash scripts/git-safe-push.sh --build-check "message"
7. TEST ON PROD      — Verify on https://smarter.poker/hub/club-arena/
8. WRITE SQL (LAST)  — Only after everything else is confirmed working
9. EXECUTE SQL       — npm run db:push (from World Hub)
```

## What Happens If You Break This Order

- Writing SQL before code is done → schema changes go live before the code that uses them
- Testing on localhost → false confidence, bugs in production
- Not pushing to GitHub → work is lost, other agents see stale code
- Not syncing to World Hub → changes exist in Club Arena repo but are NOT deployed

## DO NOT End a Session Without

- [ ] All code changes committed and pushed to GitHub
- [ ] Club Arena synced to World Hub
- [ ] World Hub pushed (triggers Vercel deployment)
- [ ] SQL migrations written and executed (if any schema changes)
- [ ] MIGRATION-CHANGELOG.md updated (if migration work)
