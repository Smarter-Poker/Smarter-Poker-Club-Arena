# The satellite art was live and nobody could see it — a 30-day cache on an unchanged URL

Dan, 2026-08-28: "YOU DIDN'T CHANGE THE LOGO AT ALL WTF?"

He was right about the screen and I was right about the server, which is the
worst possible split.

## What actually happened

The artwork was replaced twice at the SAME path,
`public/images/satellite-seat-icon.png`. Files under `public/` are copied
through the Vite build verbatim — Vite content-hashes code chunks, it does NOT
hash these — and production serves them:

    cache-control: public, max-age=2592000, stale-while-revalidate=86400

Thirty days. So every browser that had already loaded the old icon kept
painting it from local disk, and no amount of correct deploying was ever going
to change that. My earlier verification is exactly why I missed it: I fetched
the asset with `?cb=<timestamp>` appended, which is a URL no cache has ever
seen, so it returned the new bytes every time. I proved the CDN was right and
called that "live". The user's browser was never asking that URL.

## The fix

- `public/images/satellite-winner-v3.png` — the same 120px dish, new name.
  A URL that has never been requested cannot be stale. This is the convention
  already sitting in the same folder: `btn-hamburger-v4.png`,
  `header-help-v4.png`, `btn-hub-v4.png`. Lesson learned once, not written
  down, learned again.

- `public/images/satellite-seat-icon.png` — kept, holding the SAME bytes, so a
  browser still running the previous JS chunk paints the new art instead of a
  broken-image box in the minutes before it picks up this build. No importer
  left in `src/`.

- `SatelliteSeatBadge.tsx` — points at the versioned name, and now carries the
  reason in a comment so the next person renaming this art does not have to
  rediscover the cache header.

## The rule this leaves behind

Changing the CONTENT of a file under `public/` without changing its NAME is a
deploy that cannot reach anyone who has already visited. Bump the filename.
And never verify a cached asset with a cache-busting query string — that
tests the origin, not what a returning visitor sees. `curl -I` on the bare URL
is the honest check.
