# Union operations name their union (2026-09-24)

Assignment CA-PRODUCT-COMPLETION-2026-09-22, Phase 6.1 (union administration).

## What was wrong

`UnionOpsPanel` declared `unionId = MIDWAY_UNION_ID` as a default prop, and
the platform Financial Admin Hub (`/financial-admin`) rendered it as
`<UnionOpsPanel canRun />` with no union at all. So the hub's Union Integrity
section read, previewed, settled and swept one hardcoded union (Midway,
`fade0000-0000-0000-0000-000000000001`) whatever the staff member looking at
it meant. Nothing on the page said which union it was acting on.

`UnionOpsService` had already stopped defaulting its union-scoped calls (they
refuse a blank id with `No Union Selected`), and `UnionDashboardPage` already
rendered the panel only for the union it had authorized. The panel's own
default was the last place the hardcoded union survived in the client.

## Shipped

- `src/components/union/UnionOpsPanel.tsx`: `unionId` is a required `string`
  with no default. A blank id handed over at runtime renders
  `No Union Selected` and the panel asks the database nothing: no read, no
  preview, no settlement, no sweep.
- `src/pages/FinancialAdminHub.tsx`: the Union Integrity section now has a
  `Union` selector filled from the existing `unionService.getUnions()` read
  (the unions this viewer can read; no new database function). Until a union
  is chosen the panel is not rendered, so nothing can run. A list that cannot
  be read says `Unions Could Not Be Loaded` with a Retry, and an empty list
  says `No Unions Available`. The panel is keyed by the chosen union, so a
  settlement preview opened for one union is discarded when the selector
  moves, and can never be confirmed against another. Reuses the existing
  `admin-label`, `admin-input`, `admin-btn` and `admin-empty-state` styles;
  the select is full width, so it fits 375px.
- `src/services/UnionOpsService.ts`: `MIDWAY_UNION_ID` is removed from the
  client (nothing in `src/` or `tests/` has a legitimate use for it; the
  engine keeps its own copy in `server/`). `getClubExitBlockers` and
  `expelClub` now refuse a blank union id like every other union-scoped call.
- `src/pages/UnionDashboardPage.tsx`: comment only. The page already renders
  the panel only with its authorized union id and never passes `undefined`.

## Evidence

- `tests/components/union-operations-name-their-union.test.tsx` (new): the
  panel refuses `''` and `'   '` and calls nothing; the hub renders no panel
  and runs nothing before a union is chosen; the hub reads and sweeps the
  chosen union and never another; an open preview is dropped when the
  selector moves; a failed union list renders no panel. Six of the seven fail
  on the previous code; the preview test also fails if the panel is not keyed.
- `tests/unit/UnionOpsService.settlement.test.ts`: the blank-id refusal list
  now includes `getClubExitBlockers` and `expelClub`; the rest moved off the
  removed constant to a local id.
- `tests/components/union-ops-settlement-receipt.test.tsx`: renders the panel
  with an explicit union and asserts the cascade was asked for that union.

## Deliberately not changed

- Server-side authorization is unchanged: the union RPCs still decide whether
  the viewer may see or run anything for the chosen union.
- `unionService.getUnions()` returns at most 100 unions, newest first; the
  selector sorts them by name.
