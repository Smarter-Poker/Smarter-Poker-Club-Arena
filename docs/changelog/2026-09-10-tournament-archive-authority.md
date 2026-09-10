# Tournament Archive Reads Keep Their Event Identity

Phase 3 control CA-03-12, client results acceptance.

## Verified Defects

- Delayed standings, hand history, or mystery award reads could replace the selected event with a prior event's records. Failed reads retained those records without a visible error.
- Biggest Hits replaced a recorded zero or missing winner prize with buy-in times multiplier. That amount is the total Spin pool, not an individual winner's recorded award.
- A direct results link could not resolve when the filtered list was empty, and a directly loaded event was selected without being inserted into the rendered list.

## Correction And Verification

Implemented and verified: 260 tests across 14 files passed; full root TypeScript exited 0. The complete per-flow evidence and limitations are in `docs/audits/2026-09-10-phase-three-client-wiring-acceptance.md`. This changes client reads and presentation only. It performs no database, wallet, engine, or settlement mutation.

Full Phase 3 acceptance remains with the root integration lane. Local synthetic read tests do not certify live registration, payout, or funding authority.
