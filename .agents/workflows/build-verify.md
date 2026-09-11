---
description: Build verification and code quality checks for Club Arena
---

# Build Verification Protocol

> **CRITICAL**: Do NOT use browser_subagent for login-gated testing on smarter.poker.
> The browser automation tool freezes/times out on the Supabase auth login flow.
> Use build verification + code audit instead.

## Verification Steps

// turbo-all

1. Run the production build to catch TypeScript + bundling errors:

```bash
cd /Users/smarter.poker/Documents/club-arena && npm run build 2>&1 | tail -15
```

2. Check for TypeScript errors without building:

```bash
cd /Users/smarter.poker/Documents/club-arena && npx tsc --noEmit 2>&1 | tail -20
```

3. Verify no unused imports or dead code in changed files:

```bash
cd /Users/smarter.poker/Documents/club-arena && git diff --name-only HEAD~1
```

## When to Use Browser Testing

Only use browser_subagent for:

- **Public pages** that don't require login (e.g., landing page screenshots)
- **Visual verification** after the user has already logged in and shared the browser session

For login-gated verification, tell the user:

> "Build verified clean. Please test on smarter.poker and let me know if you see any issues."

## Deploy Checklist

1. Build passes (exit 0)
2. Commit on an isolated Club Arena branch and push with normal hooks
3. Required pull-request gates pass and autopilot merges to Club Arena `main`
4. `publish-club-arena.yml` rsyncs `dist/` directly to the Hetzner static origin
5. Both `https://ca-static.smarter.poker/build-info.json` and the public
   `/hub/club-arena/build-info.json` report the exact Club Arena `main` SHA
6. For `server/**` changes, separately verify the sealed Hetzner engine deploy
   and cache-busted `https://engine.smarter.poker/health`; never force a restart
