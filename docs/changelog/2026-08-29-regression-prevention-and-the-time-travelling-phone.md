# 2026-08-29 — Regression prevention, and the time-travelling phone

Dan, with a 9:18 screenshot of a still-narrow table taken an hour after the
edge-to-edge fix was verified live: "YOU NEED TO ADD PREVENTIVE REGRESSION TO
ALL ASPECTS OF SMARTER.POKER ... WE DON'T EVER WANT THINGS RANDOMLY
REGRESSING ... THE TABLES HAVE NOT RE ADJUSTED IN SIZE."

## Part 1: why his phone still showed the old table

Production was verified serving the new felt (388x641 at 390x844, measured in
the live DOM) before his screenshot was taken. His phone was not seeing
production — it was running an older bundle from the service worker's
cache-first shell, and NOTHING on the resume path could ever tell it
otherwise:

- sw-bus.js serves the shell cache-first and revalidates on NAVIGATION;
- the browser re-checks sw-bus.js itself on NAVIGATION;
- `reg.update()` ran once, at app START.

An installed PWA brought back from the app switcher does none of those — the
old JS resumes. A phone that lives in the switcher runs a replaced bundle for
days, then rotates at some arbitrary later launch. From the user's chair that
is indistinguishable from "things randomly regressing": fixes appear late,
old bugs reappear when an old bundle finally rotates forward past several
deploys, and no report ever correlates with what was actually shipped that
day. This same mechanism is the likely explanation for the 2026-08-28
card-size report and was directly observed on 2026-08-28 (a session executing
TablePage chunks four deploys behind build-info's sha).

### The fix (useShellUpdateGate.ts)

On every return to visibility, and on pageshow, throttled to once a minute,
the app now does the two things a navigation would have done:

1. `reg.update()` — a rotated sw-bus.js installs, controllerchange fires,
   the existing gate path runs;
2. fetches the live shell (`cache: 'no-cache'`; a page `fetch` is not
   intercepted by the SW's navigation branch) and compares its entry chunk
   name (`assets/index-<hash>.js` — the build's identity) to the one this
   session is executing. Mismatch → the gate's `pending` flag.

WHEN to reload is unchanged and still Dan's law: never at a table, never
hidden, 10-minute cooldown, once per mount. This fix only makes the app KNOW
it is stale — the half that was missing.

New spec: `tests/unit/shellUpdateGate.test.ts` — the hook claimed "Exported
for the unit test" since 2026-08-28 and no test existed. It pins the reload
rules, the entry-name extraction, and the probe throttle.

## Part 2: the geometry baseline — sizes cannot change silently any more

The proportion beats pin RATIOS, and ratios cannot see the whole table
shrinking — when the felt loses 26px and everything on it scales down in
step, every fraction stays flat. That is exactly how #950 shipped a narrower
felt for three days with green checks.

`tests/e2e/support/geometry-baseline.json` now pins the ABSOLUTE numbers:
nine CSS-derived box sizes (feltW, feltH, btnH, card2W, card2H, avatar,
heroAvatar, seatW, plo4Row) on all thirteen devices. A new beat in
table-proportions.spec.ts (runs in css-beats-e2e, a required check) fails on
any drift beyond 1px, naming the device, the field, and the pixels.

An INTENDED size change ships by regenerating the baseline in the same
commit — `node scripts/dev/update-geometry-baseline.mjs` — reading the diff,
and stating the change in the PR. An unexplained baseline hunk is to be
treated exactly like a weakened law-test pin: it IS the regression, wearing
a green check.

## Part 3: the estate-wide picture

Club Arena now has: ruleset-enforced required checks, the law tests
(animations, no-auto-table-switch, action bar, hand completion), the
proportion beats, the edge-to-edge beat, the geometry baseline, and a
staleness-aware client. The same two patterns — measure-and-baseline for
anything visual, and required-check discipline for everything — are the
transferable core for the World Hub and Club Commander; a plan for extending
them lives in the World Hub repo under `.agent/`.

For any device still showing the old table today: fully close the app and
reopen it (twice if the first launch still shows old — the first launch after
an update serves the previous shell while the new one installs). From this
deploy forward the resume probe makes that self-healing.
