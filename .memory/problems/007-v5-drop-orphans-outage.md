# PROBLEM 007 — v5 drop-orphans production outage (2026-04-15)

**Type:** PROBLEM (solved)
**Severity:** HIGH — site blank "Loading failed" for all users that hit prod during the window.
**Root cause:** push-to-WH Node script over-aggressively dropped orphaned asset blobs.

## What broke

The v5 bundle push via the GitHub Contents API ran a "drop orphans" pass:

```js
for (const it of cur.tree) {
  if (it.type !== 'blob') continue;
  if (!it.path.startsWith('public/hub/club-arena/assets/')) continue;
  if (keep.has(it.path)) continue;
  tree.push({ path: it.path, mode: '100644', type: 'blob', sha: null }); // DELETE
}
```

`keep` only contained the paths my fresh Vite build wrote. Any asset under `public/hub/club-arena/assets/` that wasn't in the local build got SHA-null'd (deleted from git). Because Vite emits **only the chunks that MAIN PAGE entries need** by default, and vendor chunks were reused by SHA (same content), Vite omitted them from the output directory. The drop pass then deleted them from the remote — specifically `vendor-supabase-BLlQ2fJ4.js`.

## Observed symptoms

1. `GET /hub/club-arena/assets/vendor-supabase-BLlQ2fJ4.js` returned 200 but with Vercel's SPA fallback body (`<!DOCTYPE html>…`, 6.6 KB).
2. Browser saw `content-type: application/javascript` + HTML body → "Failed to fetch dynamically imported module" in Chromium.
3. Main bundle `index-*.js` loaded fine; imports to the broken chunk aborted → React never mounted → bootstrap retry logic fired 3x → "Loading failed / Clear Cache & Reload" UI.
4. Cache-Control: `public, max-age=31536000, immutable` — so browsers that hit prod during the window had the 6 KB HTML cached for a YEAR under the valid chunk URL. Even after the hotfix, those browsers served the poisoned cache.

## Three fixes layered

1. **Hotfix `b01aed56`** — re-pushed the missing chunks (local build had them) WITHOUT a drop step. New-visitor bug resolved.
2. **Cache-bust `c25085fc`** — modified `vite.config.ts` so every emitted chunk has a `-v6` suffix. Browsers that cached the poisoned version now request fresh URLs: `vendor-supabase-BLlQ2fJ4-v6.js`.
3. **Permanent push-script rule** — `/tmp/wh-push-v6.mjs` removed the drop-orphans block. All future pushes are additive. Orphaned files on the remote are harmless (no link to them from `index.html`).

## Code change

`vite.config.ts`:

```ts
rollupOptions: {
  output: {
    entryFileNames: 'assets/[name]-[hash]-v6.js',
    chunkFileNames: 'assets/[name]-[hash]-v6.js',
    assetFileNames: 'assets/[name]-[hash]-v6[extname]',
  }
}
```

Bump `-v6` → `-v7` on any future emergency cache-bust.

## Rule for all future pushes

> NEVER delete blobs from WH via the GitHub Contents API push script. Orphans are harmless; broken-chunk 404s (which SPA fallback turns into HTML-parsed-as-JS) take the whole site down.

## Verification

- `curl -sI https://smarter.poker/hub/club-arena/assets/vendor-supabase-BLlQ2fJ4-v6.js` → `HTTP/2 200`, `content-type: application/javascript`, 172 KB.
- Live tab: React mounts, hand flows, ring shrinks on active seat, pot grows across streets, winners paid.

## Commit ladder

| Repo | Commit                 | Purpose                                                                  |
| ---- | ---------------------- | ------------------------------------------------------------------------ |
| WH   | `2fa7c88e`             | v5 ship that broke (class-collision fix + accidental drop)               |
| WH   | `b01aed56`             | HOTFIX: restored deleted vendor-supabase + 2 other chunks                |
| WH   | `c25085fc`             | v6 cache-bust: every chunk renamed with `-v6` suffix                     |
| CA   | `c25085fc` source side | vite.config.ts entry/chunk/asset name change + main.tsx cache-bust token |
