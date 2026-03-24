# Club Arena Deployment Guide — Agent Standard Operating Procedure

> **MANDATORY READING** for all Claude agents working on Smarter Poker.
> This document defines the ONLY correct workflow for deploying Club Arena changes.
> Violating these rules causes broken production builds, missing chunks, and hours of wasted debugging.

---

## Architecture Overview

```
Club Arena (CA) repo          World Hub (WH) repo              Production
─────────────────────         ────────────────────────          ──────────────
src/services/*.ts             public/hub/club-arena/            smarter.poker
src/components/*.tsx    →     ├── index.html                →   /hub/club-arena/
src/pages/*.tsx         →     ├── assets/                   →   served by Vercel
                              │   ├── index-{HASH}.js           (hub-vanguard project)
Vite build on Vercel          │   ├── vendor-react-{HASH}.js
(CA Vercel project)           │   ├── vendor-supabase-{HASH}.js
                              │   ├── {ChunkName}-{HASH}.js (200+ files)
                              │   └── *.css
                              └── images/, sounds/, cards/, etc.
```

- **CA repo**: `Smarter-Poker/Smarter-Poker-Club-Arena` (Vite + React SPA source code)
- **WH repo**: `Smarter-Poker/Smarter-Poker-World-Hub` (Next.js app that hosts the SPA)
- **CA Vercel project**: `prj_oaCq8RYhExLRUYizLG93li0uX468` — builds CA source into static assets
- **WH Vercel project (hub-vanguard)**: `prj_op66GkZyZcygXQKm76iyycfVFAQx` — serves `smarter.poker`
- **Vercel team**: `team_SVD8r7AOPH065G3usBxVvrBc`

### Critical: Two Vercel Projects, One Domain

`hub-vanguard` owns the `smarter.poker` domain. All production deployments MUST target this project.
The CA Vercel project only builds the SPA — it does NOT serve production traffic.

### Critical: Git Integration Auto-Deploys

Both repos have Vercel Git integrations. **Every push to `main` automatically triggers a Vercel deployment.** This means if two agents push to WH within minutes of each other, the LAST push wins and becomes production.

---

## The Golden Rule

> **Source changes go to the CA repo. Build output goes to WH. Never mix these up.**

### What this means:

- **If you're fixing a bug in Club Arena code** (services, components, pages, etc.):
  1. Edit the source file in the CA repo
  2. Push/commit to CA `main`
  3. CA Vercel auto-builds from the new commit
  4. Download the COMPLETE build output from CA Vercel
  5. Push ALL assets to WH `public/hub/club-arena/`
  6. WH Vercel auto-deploys

- **If you're fixing something in World Hub** (Next.js API routes, pages, etc.):
  1. Edit the source file in WH repo
  2. Push/commit to WH `main`
  3. WH Vercel auto-deploys
  4. **DO NOT touch `public/hub/club-arena/` unless you are pushing a COMPLETE CA build**

---

## NEVER Do These Things

### 1. NEVER push partial club-arena builds to WH

Every push to `public/hub/club-arena/assets/` MUST include:
- `index.html` (references the entry-point JS/CSS)
- `index-{HASH}.js` (main bundle)
- `vendor-react-{HASH}.js`
- `vendor-supabase-{HASH}.js`
- `index-{HASH}.css`
- **ALL 200+ lazy-loaded chunk files** (JS and CSS)

If you push only some chunks, the missing ones will return HTML (Next.js catch-all) instead of JavaScript, causing `"Failed to fetch dynamically imported module"` errors that **cannot be fixed by refreshing** due to browser cache poisoning with `immutable` cache headers.

### 2. NEVER push a club-arena build from a stale CA commit

Always build from the **current CA `main` HEAD**. If you build from an older commit, you'll ship a build that's missing fixes that other agents have already committed.

Before pushing a CA build to WH, verify:
```
GET /repos/Smarter-Poker/Smarter-Poker-Club-Arena/commits?per_page=1
```
The build commit SHA must match or be the current HEAD.

### 3. NEVER edit minified JS files in WH

The files in `public/hub/club-arena/assets/` are Vite build output. They are minified, hashed, and interconnected. You CANNOT fix bugs by editing these files. Fix the source in CA, rebuild, and push the complete output.

### 4. NEVER assume your push is the last one

Another agent may push to WH at any time. After pushing, ALWAYS verify production is serving your build:

```javascript
// Fetch index.html and check the entry point hash
const idx = await fetch('https://smarter.poker/hub/club-arena/index.html');
const html = await idx.text();
const match = html.match(/index-([A-Za-z0-9_]+)\.js/);
console.log('Production build:', match[1]); // Should match YOUR build hash
```

---

## Correct Deployment Workflow

### Step 1: Commit source changes to CA repo

Push your code changes to `Smarter-Poker/Smarter-Poker-Club-Arena` on `main`.

**Mandatory before committing:**
```bash
node --max-old-space-size=2048 ./node_modules/typescript/bin/tsc --noEmit
```
TypeScript MUST pass with zero errors.

### Step 2: Wait for CA Vercel build

The Git integration will auto-build. You can also trigger manually:

```javascript
// Trigger a new CA build via Vercel API
POST /v13/deployments?teamId=team_SVD8r7AOPH065G3usBxVvrBc
{
  "name": "club-arena",
  "project": "prj_oaCq8RYhExLRUYizLG93li0uX468",
  "target": "production",
  "gitSource": {
    "type": "github",
    "org": "Smarter-Poker",
    "repo": "Smarter-Poker-Club-Arena",
    "ref": "main"
  }
}
```

Poll until `readyState === "READY"`.

### Step 3: Get the build hash

Fetch `index.html` from the CA Vercel deployment to find the build hash:
```
https://{ca-deploy-url}/index.html
```
Extract: `index-{HASH}.js`, `vendor-react-{HASH}.js`, `vendor-supabase-{HASH}.js`, `index-{HASH}.css`

The CA deployment is SSO-protected. Use the Vercel MCP `get_access_to_vercel_url` tool to get a share URL, or use `_vercel_share` query parameter.

### Step 4: Download ALL assets from the CA build

Extract all chunk filenames from the built `index-{HASH}.js`:
```javascript
const p = /[A-Za-z][A-Za-z0-9_.-]*-[A-Za-z0-9_]{4,10}\.(js|css)/g;
```

Download every file. The total should be 200+ files (150+ JS, 90+ CSS).

### Step 5: Push COMPLETE build to WH repo

Use the GitHub Git Trees API to push all files in a single commit:
1. Create blobs for each file
2. Create a tree with ALL files under `public/hub/club-arena/`
3. Include `index.html`, ALL assets, manifest.json, images, etc.
4. Create a commit on top of current WH `main` HEAD
5. Update `refs/heads/main`

**CRITICAL**: Always fetch the current WH HEAD right before creating the commit. If another agent pushed between your fetch and your push, you'll get a 422 error. Handle this by re-fetching HEAD and retrying.

### Step 6: Verify production

After the WH Vercel deploy completes:

1. **Check index.html** references your build:
   ```
   GET https://smarter.poker/hub/club-arena/index.html
   → Should reference index-{YOUR_HASH}.js
   ```

2. **Verify ALL chunks return JavaScript** (not HTML):
   ```javascript
   // For each chunk filename extracted from index-{HASH}.js:
   const resp = await fetch(`https://smarter.poker/hub/club-arena/assets/${chunk}`);
   const isHTML = (await resp.text()).startsWith('<!DOCTYPE');
   // isHTML should be FALSE for every chunk
   ```

3. **Verify critical fixes are in the build**:
   ```javascript
   // AutoRebuyService must have 'running' in status filter:
   const body = await (await fetch('https://smarter.poker/hub/club-arena/assets/index-{HASH}.js')).text();
   assert(body.includes('"running","active","waiting"') || body.includes('"active","waiting","running"'));

   // Busted horses must use rebuyHorse, not reseatHorse:
   // Find: a.stack===0 ... rebuyHorse (NOT reseatHorse)
   ```

---

## Key Technical Details

### Vite Build Hashes

Every Vite build produces **unique hash suffixes** for every chunk. Two builds from the same source code at the same commit produce **identical** hashes. Two builds from different commits produce **completely different** hashes. There is NO overlap between builds — you cannot mix chunks from different builds.

### Browser Cache Poisoning

Club Arena assets are served with:
```
Cache-Control: public, max-age=31536000, immutable
```

If a chunk URL is served as HTML (because it's missing from the repo and Next.js catch-all serves `index.html`), the browser caches that HTML response for **1 year** with `immutable`. Even after fixing the server, the browser will keep using the cached HTML. The only fix is a **completely fresh browsing context** (new incognito window or cleared cache). ES module dynamic imports have a separate module map that caches failures per URL — even `fetch()` with `cache: 'no-store'` won't fix it.

This is why pushing complete builds is non-negotiable.

### AutoRebuyService Critical Fixes (MUST be preserved)

These fixes are in the CA source at `src/services/AutoRebuyService.ts`. They MUST remain:

1. **Status filter includes 'running'**:
   ```typescript
   .in('status', ['active', 'waiting', 'running'])
   ```
   Tables transition `waiting → active → running` during gameplay. Without 'running', horses at live tables get no auto-rebuy.

2. **Busted horses use rebuyHorse, NOT reseatHorse**:
   ```typescript
   if (horse.stack === 0) {
     const rebuyAmount = this.rebuyStackBB * bigBlind;
     await this.rebuyHorse(horse.horseId, tableId, rebuyAmount);
   }
   ```
   `reseatHorse()` does a destructive remove+reseat cycle that conflicts with HeadlessTableEngine, causing duplicate seats and phantom chip drain.

### Rake Rules

Rake is NEVER a fixed amount. It's calculated from the formula in `RakeConfig.ts`:
- 10% of pot, capped per stakes-based `RAKE_SCHEDULE`
- No flop = no drop
- Same rules for BBJ

### Horse Rules

- Horses are regular players — NEVER labeled as "horses" or "bots" in the UI
- No "Horses" tab anywhere
- Max 4 horses per cash table (unlimited in tournaments)
- If a real player is waiting, a horse must leave before their BB
- Horses have NO player wallets — `WalletService.getWallet` returns null
- Horse profiles are in `profiles` table with `is_horse=true`

---

## Environment References

| Resource | ID / URL |
|----------|----------|
| Supabase URL | `https://kuklfnapbkmacvwxktbh.supabase.co` |
| CA repo | `Smarter-Poker/Smarter-Poker-Club-Arena` |
| WH repo | `Smarter-Poker/Smarter-Poker-World-Hub` |
| CA Vercel project | `prj_oaCq8RYhExLRUYizLG93li0uX468` |
| WH Vercel project (hub-vanguard) | `prj_op66GkZyZcygXQKm76iyycfVFAQx` |
| Vercel team | `team_SVD8r7AOPH065G3usBxVvrBc` |
| Production domain | `smarter.poker` |
| Dan's TEST GAME table | `6f992e14-a735-40f2-9b9b-4a4275c1e053` |
| Shark NLH 1/2 table | `3bbb6664-f72b-4890-8b3d-9d2fd0bce229` |
| JAQK PLO 2/5 table | `b2422fbd-ee5b-4cd2-8ef7-868479abaa5b` |
| SHARK CLUB | `a41434bb-8d0c-400a-8f0d-e8b3d65afed4` (Midway Union) |
| Club JAQK | `a0000000-0000-0000-0000-000000000001` (standalone) |
| Midway Union | `fade0000-0000-0000-0000-000000000001` |

---

## Troubleshooting

### "Failed to fetch dynamically imported module"
→ Missing chunks. Check if the chunk URL returns HTML instead of JS. If yes, push the complete build.

### Production shows old build after my push
→ Another agent pushed after you. Check WH HEAD and latest Vercel deployment. Re-push if needed.

### CA build produces different hash than expected
→ The build is from a different commit. Verify the CA HEAD matches your expected commit SHA.

### `table_seats` unique constraint violation
→ The `(table_id, seat_number)` constraint doesn't account for `left_at`. Departed rows with `left_at` set block new INSERTs. Clean up departed rows first.

### VM disk full (ENOSPC)
→ 9.6GB disk, ~80-84% used. Cannot do full `npm install`. Use Vercel CA project to build instead.

---

*Last updated: 2026-03-24 by Gravity (cash game audit agent)*
*Both AutoRebuyService fixes verified in production build BLShtKdk*
