---
name: browser-recovery
description: 'Automatic browser tool recovery protocol. When the browser_subagent tool fails (timeouts, page not found, no active pages), the agent MUST stop, run this recovery procedure, and then retry. Trigger on: any browser_subagent failure, open_browser_url timeout, "No active pages found", "action timed out" errors.'
---

# Browser Recovery — Automatic Fix Protocol

## RULE (NON-NEGOTIABLE)

**When the browser tool fails, you MUST fix it before continuing.** Do NOT skip visual verification. Do NOT claim "browser unavailable" and move on. FIX IT.

## WHEN TO TRIGGER

This skill activates when ANY of these occur:

- `browser_subagent` returns errors about timeouts
- `open_browser_url` fails with "action timed out"
- `list_browser_pages` returns "No active pages found"
- Browser subagent reports "page not found"
- Any browser interaction fails repeatedly

## RECOVERY PROCEDURE

Execute these steps IN ORDER. After each step, retry the browser operation. Stop as soon as it works.

### Step 1: Kill Stale Browser Processes

```bash
pkill -f "chromium|chrome|playwright|puppeteer|headless" 2>/dev/null
sleep 2
echo "Killed stale browser processes"
```

### Step 2: Check and Free Ports

The dev server might be fighting for ports. Check what's running:

```bash
lsof -i :5173 -i :5174 -i :5175 -i :3000 -i :3001 2>/dev/null | grep LISTEN
```

If the dev server isn't running, restart it:

```bash
cd <project_root> && npm run dev 2>&1 &
```

Wait 3-5 seconds for it to start, then retry the browser.

### Step 3: Try Alternative URLs

If `localhost` fails, try these in order:

1. `http://127.0.0.1:<port>/`
2. `http://localhost:<port>/`
3. `http://0.0.0.0:<port>/`

### Step 4: Restart Dev Server on a Clean Port

Kill ALL dev servers and restart fresh:

```bash
pkill -f "vite|next|node.*dev" 2>/dev/null
sleep 2
cd <project_root> && PORT=4000 npm run dev 2>&1 &
```

Wait 5 seconds, then retry browser at `http://localhost:4000/`.

### Step 5: Use Simple HTTP Server Fallback

If the full dev server won't cooperate, serve the production build:

```bash
cd <project_root> && npm run build && npx -y serve dist -l 4001
```

Then browse to `http://localhost:4001/`.

### Step 6: Verify Through The Owning Release

If local browser verification is completely impossible:

1. Finish the change on a feature branch and pass the repository checks.
2. Follow the pull request through merge.
3. Let `.github/workflows/publish-club-arena.yml` publish the exact Club Arena
   commit to its Hetzner origin.
4. Confirm both cache-busted `build-info.json` endpoints report that exact SHA,
   then use the browser against `https://smarter.poker/hub/club-arena/`.

Never run a Vercel command, copy a bundle into World Hub, or substitute an
unpublished preview for production proof.

## AFTER RECOVERY

1. **Retry your original browser task** — Use `browser_subagent` with the working URL
2. **Take screenshots** — Capture proof that the UI changes are correct
3. **Document what fixed it** — Note which recovery step resolved the issue

## PROHIBITED BEHAVIORS

- ❌ "Browser tool is unavailable" — FIX IT
- ❌ "Cannot visually verify" — FIX THE BROWSER THEN VERIFY
- ❌ Skipping verification because the browser failed — NEVER
- ❌ Claiming success without screenshots for UI changes — NEVER
- ❌ Moving to next task before browser is working — NEVER
