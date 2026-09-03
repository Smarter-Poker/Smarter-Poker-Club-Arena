# The Hamburger Is The Menu

Reverses #2321 ("ban three-bar artwork", merged by autopilot 2026-08-31) and
adds the law that keeps it reverted.

## What #2321 did

It replaced the three-bar hamburger with a metallic gear
(`command-center-v1.png`) on all five menu triggers -- global header, floating
trigger, table command center, and both legacy shell fallbacks -- rebuilt the
baked header artwork around the gear, deleted `menu.png`,
`global-header-desktop.png`, `global-header-approved-source.png` and the three
`btn-hamburger` rasters, and added a service-worker tombstone list so installed
clients would evict the hamburger from their media cache within six hours.

It also added `tests/unit/noThreeBarArtwork.law.test.ts`, which made restoring
the hamburger fail CI.

## Why it is reverted

Dan, 2026-09-01: "Hamburger menus have been removed and replaced globally with
a gear icon, fix this issue." A gear reads as "settings" and sends players
looking for a preferences screen that is not there; the hamburger is the
navigation drawer's glyph and it is not a taste question that gets re-decided
by whoever touches the file next.

The counter-law is deleted rather than weakened. Two laws demanding opposite
artwork is not a stricter repo, it is a coin flip decided by whichever test a
future agent notices first -- and #2321's version was the one that had already
shipped the wrong icon to production.

The service-worker eviction list is removed with it. Left in place it would
keep purging the restored artwork from clients that had already activated the
migrated worker.

## What replaces it

`tests/approvedHamburgerGearGuard.law.test.ts` pins the complete set of menu
triggers, the md5 of every hamburger raster in the repo (this migration changed
the icon with an empty code diff in the files that reference it, which is the
failure mode that took longest to find), the absence of a gear or a grid glyph
in any trigger, the banned `command-center-v1` asset names by name so a re-run
of this migration fails here instead of shipping, and -- separately -- that no
focus ring draws a box over a header or footer icon.

## Also in this change

Dan, same day: "Remove any and all boxes that appear over any header or footer
icon globally on every page and sub pages."

`club-engine.css` paints `button:focus-visible { outline; box-shadow }` on
every button in the app. The chrome icons are transparent hit regions laid over
baked artwork, so that outline is a rectangle sitting on the picture of the
icon, and Safari on macOS matches `:focus-visible` on a plain mouse click, so it
stuck there after every tap. `.artButton`, `.floatingButton` and `.navItem` now
clear the ring on `:focus` as well as `:focus-visible` and show keyboard focus
as a soft radial glow instead.
