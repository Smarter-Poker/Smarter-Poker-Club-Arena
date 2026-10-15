# The Table Art Arrives Together (2026-10-15)

Dan, with a screenshot of a live table drawing its seats, pot and masthead on a bare navy gradient: "SOMETIMES THE 'LIVE GAME PLAY PAGE' LOADS LIKE THIS ... THIS CAN'T HAPPEN AND NEEDS TO BE FIXED. IT MUST ALWAYS LOAD THE ACTUAL TABLE AND BACKGROUND IMAGES AND EVERYTHING AT ONCE."

## Cause

- The felt (~0.8 MB PNG) and the room (~0.3 MB JPG) went straight into an `<img>` and a CSS `url()`. Nothing preloaded, decoded or retried them, so on a cold cache the seats painted first, on the CSS floor alone.
- `public/sw-bus.js` answered an image fetch that failed with no cached copy with a 0-byte `200 image/png`. That paints nothing, fires no error and is never retried, so on a dropped first fetch the felt and room stayed missing for the whole session.

## Fix

- `sw-bus.js` returns `Response.error()` instead, so the page sees the failure.
- `src/hooks/useTableArt.ts` loads and decodes both rasters, retries a failed or 0x0 image with a fresh URL on a short backoff, and remembers decoded URLs for the session (a second table or remount is instant).
- `TablePage` paints only the URLs the loader decoded and shows a "Loading Table" cover over the whole page until both are ready, so felt, room and seats appear in one frame. A theme change keeps the previous art until the new pair has decoded. The cover lifts after 12 seconds at most, so art can never lock a player out of a turn.

Pinned by `tests/the-table-art-arrives-together.law.test.ts`.
