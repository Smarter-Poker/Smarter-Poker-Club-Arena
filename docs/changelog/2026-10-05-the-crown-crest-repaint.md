# The Crown Crest Repaint

The tournament result card and the five other VIP-crest surfaces now use a
painted crown with dimensional chrome bevels, a dark quilted body, a thin
keystone rim, and a blue LED at the base. The share painter uses the same new
head. Three generated candidates were seated in the existing console and
compared at 393px against the approved spade; candidate three was selected.

The new files are `source/crest-vip-v2.png` and `top-vip-v2.png`. The original
crown source, head, and source README all have sealed bytes and remain intact.
The recipe therefore lives in `source/README-vip-v2.md`, rather than changing
the sealed README proposed by the handoff. The existing immutable-media law
also seals the new source and head. No card copy, layout, money formatting,
engine, database, or first-paint loading behavior changed.

Validation: TypeScript passed; card/host, close-control, palette, painted-zone,
class, error-handling, hover, and popup tests passed (219 tests excluding the
8-test media suite). The media suite passed after preserving the sealed
README. The matte gate passed across 200 assets; all four copy gates passed.
The production build passed at 312 kB initial gzip, below 320 kB, with no new
module entering first paint. Renders covered the result, zero payout, long
event name, and VIP member/nonmember states with verified fonts.

Development evidence and the continuation checkpoint are retained under
`/Volumes/SmarterArchives/agent-evidence/codex-crown-20261005-01a10e6f/`.
Protected merge, provider publication, and live verification are recorded in
that checkpoint when observed. Physical iOS share-sheet testing after a real
free tournament remains a device-specific verification item.

Pixel comparison also found that the seating script reconstructed the entire
head from an older flat slice. It now restores exact master pixels outside
the crest, its shadow, and its rail junctions. Existing sealed heads are never
regenerated. The new head was re-seated and its unpublished seal updated.
