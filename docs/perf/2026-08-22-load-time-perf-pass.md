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

- **App-shell navigation caching** (sw-bus.js): /hub/club-arena/\* navigations
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

## Phase 4 (second session, 2026-08-22 evening) — shipped

Continuation by a second Cowork agent from the Phase 1-3 handoff. Three PRs,
each merged by Autopilot and verified against production build-info.json.

- **Publish race fixed for real** (PR #273). The sync job's stand-down guard
  compared `built_at` TIMES, and `cancel-in-progress: false` lets an
  older-sha run finish after a newer one with the LATER timestamp — it
  regressed production twice on 2026-08-22. The guard now reads the deployed
  `ca_sha` and asks the compare API for ancestry: behind stands down,
  ahead/identical publishes, unanswerable (rewind/unknown sha/API failure)
  falls back to the time comparison. Pinned in
  `tests/shipped-invariants.test.ts` ("ancestry, not wall clock"). The
  dispatch-and-reverify dance after every merge is no longer needed.
- **~30MB of dead public/ weight deleted** (PR #287, 52 files). Every file
  re-grepped against src/, index.html, server/, tests/, public html/js/css
  and World Hub pages/src first. The four unreferenced `cards/backs/*.jpeg`
  (14MB), `shark-card.svg`, both `club-stats-panel.svg` copies,
  `assets/metal-ui/`, the wallet-panel images (matches were aria ids), the
  pre-v4 header icons, pre-v8 cashier tiles and the orphaned hand-histories
  tile. Verified live: deleted paths 404, kept neighbours 200. Shrinks the
  repo, dist/ and the rsync of every deploy.
- **Lobby tiles warm their destination on intent** (PR #298). The plain
  tiles (Player Stats, Daily Challenges, Leaderboards) now fire
  `preloadRoute(tile.route)` on hover/touchstart/focus, matching the
  quick-link tiles — chiefly for PlayerStatsPage's ~314KB recharts chunk,
  which stays out of the boot preload list on purpose.

Still open, in the order the handoff ranked them: TablePage internal split
(HIGH CHURN — coordinate first), CardBackSelector previews to
`cards/backs/table/*.webp`, fonts.css content-hashing, HTML edge caching
(risky), ClubHomePage stale-first hydration (heaviest screen, biggest
remaining win), font subsetting, images/icons WebP+ref pass.

## Phase 5-6 (2026-08-23) — measuring the bundle, then auditing my own work

Two rounds after Phase 4. Everything below was found by measuring or by
re-reading a change already merged, not by planning ahead — which is the point
worth keeping.

### Found by measuring the served bundle

- **Root-level images escaped the optimizer entirely** (PR #343). `ruleFor()`
  returned `null` for anything outside its prefix list, so every image at the
  root of `public/` shipped at full size. The PWA/apple-touch icon went out at
  **637KB** while `manifest.json` declared it `512x512` and the file was
  1024x1024 — and `public/sw.ts` precaches it on install. A catch-all rule now
  closes the gap permanently (an opt-in list silently misses whatever nobody
  remembered to add; a catch-all only ever misses on the safe side) plus an
  explicit 512 cap for the icon: **637KB -> 148KB**, verified 512x512 valid PNG
  out. Also deleted three dead root images with zero references anywhere
  (`poker-table-bg.png` 810KB, `club-arena-design.png` 783KB, root
  `vip-card.png` 616KB — VIPPage uses `images/vip-card.png` and says so).
  _Noted, not changed: `poker-chip-logo.png` and `poker-table-bg.png` are JPEG
  data inside a `.png` filename. Harmless (browsers sniff) but a maskable PWA
  icon wants real PNG alpha — worth a design pass._

### Found by auditing changes that had already merged

- **The service worker precached the bundle and never served it** (PR #376).
  Two silent faults made the versioned cache write-only. `isHashedAsset` was
  `/[-.][a-zA-Z0-9_]{4,}\.(js|css)$/` and matched **none** of the emitted
  files — `vite.config.ts` writes `assets/[name]-[hash]-v6.js`, so every chunk
  ends `-v6.js` and the regex wanted four or more characters where `v6` has
  two. Separately, the never-intercept-documents guard excluded `/assets/` but
  not `/fonts/`. So `PRECACHE_URLS` was written on every install and read for
  nothing but the shell document: chunks hit the network on every load, and the
  offline app shell booted into a page whose scripts could not load — the exact
  failure the shell exists to prevent. Routing now matches on the **directory**
  (`/assets/`, `/fonts/` — precisely what the precache scanner collects), which
  a filename-template change cannot unhook again. `sw-bus.js` and
  `build-info.json` sit at the club-arena root and keep revalidating; a cached
  `build-info.json` would make every deploy verification lie.
- **The publish stand-down guard was comparing the bundle to itself** (PR
  #372). The `Sync dist/` step rsyncs our bundle into
  `world-hub/public/hub/club-arena/` _before_ the commit step, and the guard
  read its "deployed" provenance from exactly that path — so `THEIRS_SHA`
  equalled `OURS_SHA` on attempt 1, every run. The ancestry check added in #273
  was correct and **inert**, live only from attempt 2 after a push had already
  been rejected. That left the original regression open: a losing older-sha run
  that checks World Hub out _after_ the winner pushed overwrites it, compares
  ours-to-ours, and fast-forwards cleanly with every check green. Reproduced
  against real git repos both ways before fixing. Now reads
  `git show origin/main:public/hub/club-arena/build-info.json`.
- **Signing out left the whole account cached on the device** (PR #368).
  `SIGNED_OUT` cleared the store, Sentry and realtime, and no storage at all:
  the next person to use the device got the previous account's club list
  (`club_arena_clubs_cache`), club lobby (`club_home_cache_*`, painted
  _instantly_, before any fetch could correct it), `hand_history_*`, and every
  sessionStorage SWR cache — profile, transaction history, session stats, which
  die with the TAB, not the session, so a sign-out and sign-in in the same tab
  carried them across accounts. Moving ClubHomePage's cache to localStorage for
  the instant paint widened a hole that was already there for eight other
  caches. `clearUserCaches()` now runs in the one place every sign-out passes
  through; device preferences are deliberately kept, and the Supabase auth key
  is never touched.
- **A missing `node` reported itself as a title-case violation** (PR #357, and
  World Hub #664 for the same bug in the bundle gate). A push from a shell
  without `/opt/homebrew/bin` on PATH got `127 command-not-found` and the hook
  announced _"page copy is not Title Cased."_ Worse than the wasted time: the
  false failure stood in front of a **true** one — re-run with node found, the
  same push was correctly stopped on a real `supabase.auth.getUser()`
  violation.

### The pattern worth remembering

Four of the five above are guards that reported success, or reported the wrong
failure, while doing nothing. A precache nothing reads. A stand-down that
compares a file to itself. A purge that never ran. A checker whose absence
looks like a content error. None of them show up as a red tick, and none would
have been found by planning the next optimisation — only by asking what the
shipped thing actually does.

### Anti-drift notes for whoever is next

- `clearUserCaches.ts` types its key list against `STORAGE_KEYS`, so a rename
  fails the build rather than silently skipping a purge; the sessionStorage
  prefixes are the canonical list exported from `staleCacheReaper`, not a copy;
  ClubHomePage imports the one `CLUB_HOME_CACHE_PREFIX` it writes with.
- `tests/unit/swAssetRouting.test.ts` re-implements the SW routing against real
  emitted filenames and asserts against the shipped `sw-bus.js` — it fails on
  2 of 13 against the old file.
- `shipped-invariants.test.ts` pins both publish-guard properties: ancestry not
  wall clock, and reading the deployed file from git rather than the working
  tree.

### Still open, in the order worth doing

1. TablePage internal split (~413KB JS + ~383KB CSS in one chunk). HIGH CHURN —
   7 commits in two days — coordinate before touching.
2. `images/icons/` (~3.2MB) WebP pass with per-component fallbacks.
3. The legacy un-hashed `dist/fonts/fonts.css` can be dropped after a few
   deploy cycles, once no SW-cached shell still references it.
4. HTML edge caching (`s-maxage`) — risky at this deploy cadence; the SW shell
   fallback already covers slow networks.
5. Font subsetting/weight trim — needs a design pass (weight 900 has 69 uses).
6. `tests/components/ClubQuickLinkTile.test.tsx` mocks `images/tiles/cashier.webp`,
   a filename that no longer exists. Harmless (jsdom never fetches it) but
   misleading to read.
