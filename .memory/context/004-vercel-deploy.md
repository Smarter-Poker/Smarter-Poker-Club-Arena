# Club Arena Frontend Publication Authority

**Type:** CONTEXT

**Rewritten:** 2026-09-10

**Project:** Smarter Poker Club Arena

Club Arena does not deploy through Vercel or World Hub. The Club Arena
repository owns its frontend publisher:

1. A feature branch reaches Club Arena through the normal pull-request checks.
2. Club Arena `main` triggers `.github/workflows/publish-club-arena.yml`.
3. That workflow builds the exact Club Arena commit and publishes to the
   Hetzner-backed origin at `https://ca-static.smarter.poker`.
4. World Hub exposes only a rewrite from `/hub/club-arena/:path*` to that
   origin. It does not build, copy, mutate, or publish the Club Arena bundle.

The retired `public/hub/club-arena/` vendored tree, World Hub synchronization
scripts, Vercel CLI/API fallback, direct rsync, and manual host publication are
not recovery paths. If the owning workflow fails, fix it forward and send the
`publish-club-arena` repository event with the exact full protected `main` SHA.
Selectable-ref workflow dispatch is not a recovery path.

Completion requires terminal workflow success and cache-busted
`build-info.json` responses from both the direct origin and public rewrite,
with both `ca_sha` values equal to the exact Club Arena `main` commit.

Credential values never belong in this file or a local environment example.
The workflow consumes the Club Arena repository's write-only
`CA_ORIGIN_HOST`, `CA_ORIGIN_SSH_KEY`, and `CA_ORIGIN_HOST_KEY` secrets.
