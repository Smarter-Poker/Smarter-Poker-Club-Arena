# A missing asset was cached for a year

**2026-09-03.** Found in the final sweep of the origin migration, by asking for
an asset that does not exist:

    GET /hub/club-arena/assets/does-not-exist-xyz.js
    404 Not Found
    Cache-Control: public, max-age=31536000, immutable

Caddy applies `Cache-Control` **by path, not by status**, so every miss under
`/assets/*` and `/fonts/*` was answered "not found, and remember that for a
year".

## Why it matters

Almost every 404 there is a genuine typo and nobody cares. The one that is not
is the publish window: a browser holding a _new_ `index.html` asks for a chunk
in the seconds before that chunk has finished reaching the pool. Today that
returns 404 and the next reload fixes it. With `immutable` on the response, the
browser caches the miss until 2027 - and keeps rendering a broken page for that
viewer, with no recovery but a hard reload they have no reason to think of.

The window is small. The blast radius for whoever lands in it is not, and it is
silent: their session is broken and our logs show one 404.

## The fix

A site-level `handle_errors` block that answers every error with
`Cache-Control: no-store`.

It sits at **site** level deliberately. The first version nested it inside the
`handle @pooled` block, which Caddy refuses outright:

    directive 'handle_errors' is not an ordered HTTP handler, so it cannot be
    used here - try placing within a route block or using the order global option

That was caught by running `caddy validate` against a real Caddy 2.8.4 before
it went anywhere near the box - and it is a good demonstration of why
`deploy-origin-config.sh` now validates a STAGED copy before overwriting the
live `/etc/caddy/Caddyfile` rather than after.

## Verified behaviourally, not by reading

Config served locally on a real Caddy with a fake release tree:

| request            | before                                     | after               |
| ------------------ | ------------------------------------------ | ------------------- |
| real hashed asset  | 200, `max-age=31536000, immutable`         | **unchanged**       |
| missing asset      | 404, `max-age=31536000, immutable`         | 404, **`no-store`** |
| SPA route `/clubs` | 200, `s-maxage=60, stale-if-error=86400`   | **unchanged**       |
| `/build-info.json` | 200, `no-store, no-cache, must-revalidate` | **unchanged**       |

Only the miss changed, which is the whole intent.
