# Load-Time Performance Pass — 2026-08-22 (Cowork session)

Dan: "MASSIVELY UPGRADE THE LOAD TIMES ON PAGES INSIDE THE CLUB ARENA...
USE THE USERS DEVICES TO CACHE ITEMS, OR ANYTHING ELSE POSSIBLE."

This doc records what was found, what shipped, and why. It stands in for the
MIGRATION-CHANGELOG entry — that file is 662KB, past the GitHub-MCP push
ceiling, so it cannot be updated from this session without clobber risk.

## What was actually slow (measured, not guessed)

1. **Every static asset re-validated on every page load.** Vercel serves
   `public/` files with `Cache-Control: max-age=0, must-revalidate`. Club Arena
   ships ~500 hashed files in `assets/` plus ~60MB of media. Nothing was
   HTTP-cached on players' devices — every visit paid dozens of 304 round-trips
   before paint. This was the single biggest cause.

2. **The service worker excluded all media by a precedence bug.** In
   `public/sw-bus.js`, the navigation guard
   `url.pathname.startsWith('/hub/club-arena/') && !url.pathname.includes('/assets/')`
   made the SW ignore everything under `cards/`, `images/`, `game-card-icons/`,
   `club-logos/`, `videos/` — exactly the heavy media. Only `assets/` chunks
   were ever cached. Its single deploy-versioned cache also nuked all cached
   media on every deploy.

3. **Card faces were 750x1050 PNGs, ~66KB each.** A deck = 3.4MB, fetched one
   card at a time as dealt, at a render size of at most 80x120 CSS px.

4. **Google Fonts CSS was render-blocking** (3 families, 14 weights), and the
   first Supabase connection paid DNS+TLS with no preconnect.

5. **Cards loaded at deal time** — early hands showed card pop-in, one round
   trip per card.

## What shipped

### World Hub repo (`next.config.js` headers)
- `/hub/club-arena/assets/*` → `public, max-age=31536000, immutable`
  (filenames carry content hashes; index.html stays must-revalidate, so
  deploys still propagate on next navigation).
- `/hub/club-arena/{cards,images,game-card-icons,club-logos,videos}/*` and
  apex `/cards/*` → `public, max-age=2592000, stale-while-revalidate=604800`.
- `/hub/club-arena/sw-bus.js` → `no-cache, must-revalidate` (a stale SW must
  never pin an old cache policy).

### Club Arena repo
- **sw-bus.js**: media-precedence bug fixed; split into a deploy-versioned
  chunk cache + a persistent `club-arena-media-v1` cache that survives
  deploys; media entries capped at 600; DEPLOY_TS bumped.
- **WebP cards**: `scripts/generate-webp-media.mjs` runs in `npm run build`
  (self-installs sharp with `--no-save`; failure is non-fatal). Converts both
  decks to 360px WebP: **6.55MB PNG → 1.02MB WebP** (~8KB/card). Generated
  files are gitignored (agents push via GitHub MCP, which cannot carry
  binaries). `getCardImagePath()` now emits `.webp`; `CardImage` falls back
  WebP → PNG → text glyph, `PremiumCard` uses `withPngFallback`. So a build
  without the generation step degrades gracefully to PNGs.
- **Deck warmer** (`src/utils/deckWarmer.ts`, wired via ChunkPreloader): after
  idle chunk preloading, fetches all 52 cards of the player's deck style
  (~500KB once per device, then served from the SW media cache forever).
  Skips Data Saver and 2g connections.
- **index.html**: Google Fonts stylesheet loads async (`media="print"`
  onload swap + noscript fallback — display=swap already prevented FOIT);
  `preconnect` to `kuklfnapbkmacvwxktbh.supabase.co`; `dns-prefetch` for
  OneSignal.
- **HandReplay3D**: card textures were root-absolute (`/cards/...`), bypassing
  the Club Arena media path and both cache layers; now `MEDIA_BASE`-relative.

## Expected effect
- **Repeat visits** (the common case): all JS/CSS/media served from disk with
  zero revalidation round-trips; only index.html + live data hit the network.
- **First visit**: fonts no longer block render; Supabase handshake overlaps
  JS download; cards are 87% smaller and pre-warmed before the first deal.

## Verification done this session
- `npx tsc --noEmit` → clean.
- Full vitest suite (2,906 tests) → green (run from a local copy; the FUSE
  mount is too slow for vitest).
- Full production `vite build` → green; dist contains 104 card WebPs, the new
  sw-bus.js, and the async-font index.html.
- `node --check` on the edited World Hub `next.config.js` → clean.

## Follow-ups worth doing (not in this pass)
- Convert the big lobby PNGs (`images/tiles/player-stats-v9.png` 712KB, the
  wallet panels ~500KB each, `images/icons/*` 3.2MB total) to WebP the same
  way and update their references.
- `cards/backs/` still carries 14MB of unused JPEG/WebP originals (red.jpeg
  alone is 3.8MB); the table only uses `cards/backs/table/*.webp` (~38KB
  each). Prune or convert the strays that UI still references
  (`club-branded.jpg`, `diamond-foil.jpg` in CardBackSelector previews).
- TablePage ships 413KB JS + 383KB CSS in one chunk; splitting its modals
  would cut first table load further.
- Consider precaching the entry + vendor chunks in sw-bus.js at install time
  (needs a build-time manifest injection).
