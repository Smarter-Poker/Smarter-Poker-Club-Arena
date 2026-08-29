# A click that went nowhere was still a click

2026-08-29, Cowork session `cowork-ads3`. Client half. The server half (the
same rule applied where `target_url` is written) is a World Hub PR of the same
name.

## Why I went looking

The house ads handoff of 2026-08-28 closed with a standard worth keeping: read
your own merged diff and ask "is every new function actually called, and does
every write do what it says?" I asked it of the whole ads surface. Four things
answered badly, and three of them are here.

## 1. The session summary ad routed underneath a modal that never closed

`SessionSummaryHost` is a `createPortal` overlay. Nothing takes it down but
`clearSessionSummary()` — the backdrop calls it, the card stops propagation,
and the ad lives inside the card. So `onNavigate={(path) => navigate(path)}`
routed the page and left Session Complete sitting on top of wherever the player
had just been sent.

The click was logged. In the panel that is indistinguishable from a campaign
that works.

`close()` now runs before `navigate()`.

## 2. The lobby strip logged the click before it checked where it went

`target_url` is admin-entered text, and every client already refuses one that is
not a rooted, same-origin path. The strip did the refusing in the wrong order:

```
AdService.logClick(...)          // recorded
if (isSafeAdTarget(url)) { ... } // then decided
onOpen?.()                       // and fell through
```

It also decided whether to render a button from the raw column
(`Boolean(ad.targetUrl)`), so an ad pointing off-site rendered as a tappable
strip with a pointer cursor and a focus ring, took the tap, counted it, and did
nothing.

Those events are worse than no events. They inflate the click-through rate an
operator reads when choosing what to run next, and they inflate it precisely on
the campaigns that are broken.

The destination is now resolved and validated once, into `houseTarget`, before
anything downstream looks at it. `logClick` sits inside the branch that has one.
`isActivatable` reads the checked value, not the raw column.

`HouseAdCard` was already right — it validates into `activatable` and returns
early. There is now a pin holding it that way.

## 3. The weight box asked for a weight the database refuses

`ad_catalog_weight_positive` requires `weight > 0`. PATCH clamps to 1 and says
why in a comment. Create clamps to 0, and the input allowed 0 — and a cleared
number field gives `Number('') === 0`, which is finite, so it passes the
`Number.isFinite` guard on the way to the constraint. The operator got "Could
not create that ad" with no mention of the field that caused it.

`min={1}` here. The server-side clamp is in the World Hub PR.

## Also

The delete confirm was the only dialog on the page in sentence case, and the
only one that deletes an ad together with its whole performance history.
CLAUDE.md 5.7 applies to it like everything else. It is Title Case now.

## Verification

- `npx vitest run tests/unit/houseAds.test.ts` — 92 passed (85 before, 7 new).
- `npx tsc --noEmit` — exit 0.
- Live data checked first: no ad in `ad_catalog` currently carries an unsafe
  `target_url`, so nothing in the 589 events recorded to date is a phantom
  click. This is a latent path closed before it was walked, not a cleanup.

## Not fixed here

`ad_placement.target_url` is a live per-placement override that
`fn_resolve_ads` prefers over `ad_catalog.target_url`, and eight placements
carry one. The panel never reads or writes that column, so editing "Links To"
on those campaigns reports "Saved." and changes nothing on the surface that is
actually serving. Separate change; it needs the read, the row, and both verbs.
