# 2026-08-29 — Sixteen specs in no job, three of them red

Dan: "go through it all line by line, check for any bugs, stubs, gaps,
errors, regressions or wiring issues."

The wiring issue was in the test estate itself. ci.yml's own comment warns
that "a spec that is not named here runs in NO job" — hero-card-row sat
unexecuted for 39 commits once. An inventory found the trap had fired at
scale: SIXTEEN of the twenty e2e spec files ran in no CI job. Every one is a
guard somebody wrote after a real defect, and none of them could fail
anything.

## Wired into the css-beats-e2e gate (self-contained: no server, no login)

top-rail-seat, pot-above-chips, flop-fan-open, hero-cards-no-glitch,
raise-panel-covers-chat, customization-controls, customization-studios —
seven specs, joining the four already gated. The job now runs eleven.

## Three were already red, and each red is its own lesson

- **top-rail-seat** pinned the side/bottom avatar at the literal 84px — the
  px-ladder rung #1650 deliberately replaced with 15.8%-of-felt. Updated to
  assert the proportional law (and its harness now republishes --table-w the
  way the app does, so it measures a felt that ships).
- **pot-above-chips** asserted the pot's position matches a frozen 2026-08-19
  fixture to half a pixel — a one-time migration invariant, red by 330px
  against two deliberate redesigns since. The beat is retired with its
  reasoning; the z-order beats (the spec's actual purpose) and their control
  stay, still green against the real stylesheets.
- **raise-panel-covers-chat** lost its geometry when --sp-action-reserve
  moved into TablePage.css — the same failure mode its own 2026-08-25 comment
  documents, second occurrence. TablePage.css joined its stylesheet list.

## Also in this commit

- Comment reconciliation from the aspect retirement: the base .table-scaler
  comment no longer claims a changed aspect moves seats off the rail (false
  since object-fit: fill), the overruled "NOT taken to 100%" paragraph is
  marked as history, and tableGeometry.ts's NOMINAL_SCALER note names the
  0.605–0.7 mobile range.
- Zombie PRs #1750/#1769 (conflicted precursors of merged #1751/#1770)
  closed, branches deleted.

## Deliberately not done, and why

The run-it-twice board stack stays at 68% of the felt. Widening it without
moving seats is a lie — measured, the stack already threads between the side
seat plates, and the honest cap under the CURRENT ring is narrower than what
ships. Making multi-board cards bigger means moving side seats out of the
stack's band mid-hand (the #1571 treatment, applied vertically), which
changes where players sit during a live runout: that needs Dan's eyes on a
design, not an agent's assumption — the horses-law incident is what an agent
assuming a design decision looks like. Meanwhile the felt-fill work already
grew those boards ~13% on real phones (0.68 × 344 → 0.68 × 390). The
remaining orphan specs need logins or a deployed URL; they belong in a
post-deploy job, listed by name in ci.yml's comment for whoever builds it.
