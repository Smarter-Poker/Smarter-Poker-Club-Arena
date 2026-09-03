# Club Arena publishes to its own origin

2026-09-03. Dan: "SO CAN CLUB ARENA WRITE, PUSH AND PUBLISH DIRECTLY NOW, OR
DOES IT STILL NEED TO DO THAT WEIRD THING WHERE IT PUSHES TO THE WORLD HUB
FIRST AND CAUSES THE DUPLICATE WORK? ... MAKE IT HAPPEN!"

## Before

`smarter.poker/hub/club-arena` is a path on the World Hub's Vercel
deployment. The only way a file reached it was a commit into that repo's
`public/hub/club-arena/`, so every Club Arena merge produced a
`chore(club-arena): sync build` commit in the World Hub and a 4-5 minute
rebuild of the entire World Hub - about twenty times a day - before a
player saw the change.

## After

- **Origin:** Caddy on `estate-ci-1` at `ca-static.smarter.poker` (Vercel
  DNS A record; Let's Encrypt, allowed by the domain's CAA). Layout:
  `releases/<ca_sha>/`, `current` symlink, an additive `pool/{assets,fonts}`
  for hashed files (pruned by age, never by bundle membership - the
  runtime-asset-retention rule), and `static/{cards,images,club-logos,
videos,game-card-icons}` for the bulky media that was only ever in the
  World Hub's `public/` tree. Bootstrapped from the bundle World Hub main
  carried (`ebf50c1fb`).
- **Publisher:** `sync-to-world-hub` is replaced by `publish-to-origin` in
  `publish-club-arena.yml`: same gate (needs the build AND every test
  shard), same stand-down rule (never overwrite a newer bundle - it reads the
  origin's `current/build-info.json` over ssh first), then rsync the release,
  additive pool sync, atomic symlink swap, prune to ten releases, verify
  `ca_sha` at the origin. `contents: read` - the job can no longer commit
  anywhere. Secrets `CA_ORIGIN_SSH_KEY` / `CA_ORIGIN_HOST` /
  `CA_ORIGIN_HOST_KEY`; the publisher connects as the unprivileged `ci` user
  that owns `/srv/club-arena`.
- **World Hub** (separate PR): one rewrite `/hub/club-arena/:path*` -> the
  origin; the 1,383-file `public/hub/club-arena/` tree deleted; the
  sync-era checks that read it retired. The browser stays on
  `smarter.poker`; Vercel proxies the rewrite; the shared session is
  untouched. Cache behaviour is preserved twice: Caddy sets the same
  Cache-Control the World Hub's `vercel.json` sets, and the `vercel.json`
  headers still apply to the rewritten responses.

## Pins moved with the mechanism (same commit)

`no-commit-left-behind.law` (publisher count, checkouts, provenance,
permissions), `deployAndPublishAreHonest`, `shipped-invariants` (stand-down
guard reads the deployed file), `runtimeAssetRetention` (now pins the
additive pool + age prune). Nine legacy deploy scripts and
`scripts/ci/sync-club-arena-dist.mjs` removed; CLAUDE.md 1.1 rewritten.

## Rollback

Origin: `ln -sfn /srv/club-arena/releases/<older sha> /srv/club-arena/current`.
Whole design: revert the World Hub PR (the `public/` tree comes back with it)
and this one.
