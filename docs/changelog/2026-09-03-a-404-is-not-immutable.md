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

---

## Correction, same day: two things above are overstated

Written while verifying the deploy. Both corrections make the bug _smaller_,
and leaving the original wording would have handed the next agent a scarier
story than the truth.

**1. The publish-window race is not real on the normal path.** I described a
browser holding a new `index.html` asking for a chunk that had not arrived
yet. It cannot: `publish-club-arena.yml` uploads the release and fills
`pool/{assets,fonts}` **before** it swaps the `current` symlink. By the time
any browser can see the new index, its chunks are already served.

The genuine source of a hashed-asset 404 is the **30-day pool prune**: a tab
left open longer than that asks for a chunk that has since been aged out.
Rarer than I implied, and the fix is still right - caching _that_ 404 for a
year is what turns a recoverable stale tab into a permanently broken one.

**2. The fix does not reach a player yet, because Vercel overrides it.**
The origin is correct - `curl https://ca-static.smarter.poker/assets/nope.js`
returns `404` with `cache-control: no-store`. But every player arrives through
`smarter.poker`, and Vercel applies its OWN header rules to the proxied
response, overwriting the origin's. Measured:

| path                   | origin says                           | player gets                                 |
| ---------------------- | ------------------------------------- | ------------------------------------------- |
| `/assets/<missing>.js` | `no-store`                            | `public, max-age=31536000, immutable`       |
| `/build-info.json`     | `no-store, no-cache, must-revalidate` | that **plus** `proxy-revalidate, max-age=0` |

The rule doing it is `"/hub/:orb*/assets/(.*)"` in the World Hub's
`vercel.json`.

**I tried to fix that and backed the change out.** Excluding club-arena from
that rule does not make Vercel pass the origin's header through - everything
under `/hub/` is also matched by a blanket rule, so the assets would have
fallen through to `no-cache, must-revalidate` and a 525 KB entry chunk would
be revalidated on **every navigation**. That is a real, permanent performance
regression traded against a rare, recoverable 404. Vercel header rules match
on path only and cannot be made conditional on status, so there is no
formulation that expresses "immutable when found, no-store when missing".

So: the origin is right, the edge still overrides it, and the honest state is
that this is **fixed at the origin and known-unfixed at the edge**. Closing it
properly means either serving Club Arena from a host we control end to end, or
accepting the trade deliberately - not a regex.

---

## Decided, 2026-09-03: accept it at the edge. Do not "fix" this.

Dan handed the call over, so it is made rather than left open. **The edge keeps
its `immutable` rule. We do not exclude Club Arena from it.**

The trade, stated plainly:

|              | cost                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Leave it** | a viewer whose tab is older than the 30-day pool prune caches one 404 for a year, and sees a broken page until they hard-reload |
| **"Fix" it** | a 525 KB entry chunk revalidates on **every navigation, for every player, forever**                                             |

The first is rare, recoverable, and hits one person. The second is certain,
permanent, and hits everyone on every page load. There is no third option:
Vercel header rules match on path only, so nothing there can say "immutable
when found, no-store when missing", and simply dropping the rule hands the
paths to a blanket `/hub/` rule that is _worse_ than either.

**What actually shrinks the exposure is not a header.** The 404 requires a tab
older than `find pool -mtime +30`. Raising that retention costs a little disk
and removes the trigger outright - that is the lever, if anyone wants to pull
it. The header is the wrong end of the problem.

The origin fix stays regardless: it is correct there, it costs nothing, and it
is what a future direct-to-origin path would get.

`.github/scripts/origin-contract.sh` reflects this exactly - it **fails** on the
origin's own behaviour, which is ours to control, and only **warns** on the
edge, which is not. Do not promote that warning to a failure without changing
the underlying trade; a permanently red watchdog is how the last two guards
went unnoticed for a fortnight.
