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

## PHASE 2 (same day) — post-build media optimizer + SW shell precache

Audit of what the code ACTUALLY references (93 static media paths) found the
next tier: 51 game-card emblems at ~150KB each (7.9MB — every lobby game
card), 25 club-logo presets at 100-260KB, card-back art up to 1.2MB used as
previews/3D textures, 300-900KB page backgrounds. Rather than touching dozens
of references, Phase 2 added `scripts/optimize-dist-media.mjs`, which runs
after `vite build` and re-encodes every oversized raster IN dist/ — same URL,
same format, render-size-informed max dimensions, replaced only when ≥10%
smaller. Measured: **350 files, 67.89MB → 18.14MB (−73%)**, with zero code
references changed and zero fallback surface added. The committed source
assets are never modified.

The same script now stamps `DEPLOY_TS` in dist/sw-bus.js with the real build
time (the hand-updated placeholder had been stale since April) and injects a
`PRECACHE_URLS` list (entry chunk + modulepreloaded vendors + entry CSS
parsed from dist/index.html); sw-bus.js precaches that shell at install, so
returning players boot entirely from cache and each deploy pre-fetches its
new chunks the moment the SW updates. OneSignal's SDK now injects after
window load + 3s instead of competing with the app bundle during boot
(PushNotificationService already queues via OneSignalDeferred). Font-weight
trimming was evaluated and skipped: weight 900 alone has 69 usages, and the
async loading from Phase 1 already removed the render-blocking cost.

## PHASE 3 (same day) — offline-capable app shell, self-hosted fonts, table warmup

- **App-shell navigation caching** (sw-bus.js): /hub/club-arena/* navigations
  are now network-first with a 3.5s deadline; on timeout, network failure, or
  5xx the SW serves the shell HTML that was precached at install TOGETHER
  with that deploy's exact chunks (same versioned cache, so the fallback is
  always internally consistent). offline.html is the last resort. Deploys
  propagate exactly as before — the fallback only engages when the network
  would have white-screened the player anyway. This is the app-shell pattern
  the native-feeling poker clients use.
- **Self-hosted fonts** (scripts/self-host-fonts.mjs, post-build): downloads
  the Google Fonts css2 payload + all woff2 subsets into dist/fonts/ and
  rewrites dist/index.html to same-origin URLs. Kills two cross-origin TLS
  handshakes on cold boot; the woff2 files fall under the immutable
  Cache-Control rule and the SW media cache (cross-origin font caches are
  partitioned per-site, so Google's CDN gave returning visitors nothing).
  Any failure leaves the Google links untouched. Verified end-to-end on a
  real network: 25 woff2 files, index.html rewritten, zero gstatic refs.
- **Table warmup** (ChunkPreloader): TablePage (~413KB JS + ~383KB CSS, the
  heaviest and most-visited chunk) and MultiTablePage now idle-preload after
  the light pages, so the first tap on a table seats instantly.
- **Data layer**: audited — HomePage/ClubCarouselPage already hydrate from a
  localStorage SWR cache (CLUBS_CACHE); no change needed.

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
