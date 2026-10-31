# Every trace of the Lightning Internal Pilot is removed

Owner, 2026-10-31: "REMOVE THE LIGHTNING INTERNAL PILOT, AND ANY AND ALL TRACES OF IT IF ITS NO LONGER NEEDED FOR ANYTHING." Lightning runs live in Midway Union. Migration `20261031184340` retired the pilot club (95087) and returned its whole estate to the Mint. This change removes everything that existed only for it.

## Engine

- `LightningPilotSeatScope` is gone. The horse fleet read the pilot assignment every cycle, refused an assigned horse new seats outside the pilot club, and loosened the bankroll bar at a pilot seat. The assignment has been inactive since 2026-10-24, so every one of those branches already answered "no opinion"; every seat now uses the horse's own temperament policy (`bankrollPolicyFor`), which is what it was getting.

## Database (migration `20261031202247`)

This is `20261031202247`. The first file, `20261031190132`, was refused whole by the database (a CHECK constraint on the assignment table calls one of the doors, so the doors cannot be dropped before the table); nothing committed, and it is marked superseded.

- `lightning_pilot_assignment`, `lightning_pilot_assignment_receipts` and their seven doors are dropped.
- `fn_register_horse_for_tournament` and `fn_seat_horse_in_seat_first_game` lose the `fn_lightning_pilot_assignment_blocks` gate. With no active assignment it was always false, so no outcome changes; horse registration stops taking that shared advisory lock.
- `fn_lightning_rollout_readiness` loses its dead md5 exemption for the pilot's set door.
- The withdrawal door's money-registry row is marked `retired`; the pilot's horse-roster exemption, its Clusters' run-state rows and its open integrity signals (horse against horse in a retired house club) are cleared with the reason recorded. Hands, drain history and the retired club's records stay.

## Tooling

- Removed the pilot workflows (assignment, roster, roster expansion, stage, witness, private setup, qualification, latency qualification) and their `scripts/ops` tools, the pilot-only native tests (`test-lightning-pilot-assignment.sh`, `test-lightning-pilot-thresholds.sh`) and fixtures, `tests/lightning/private-pilot-preparation.test.ts`, and the pilot roster manifests.
- `release-gates.json` keeps every gate; L05, L09, L40 and L41 keep their remaining maintained qualification files. The latency qualifier only ever read the pilot's Clusters, so an R19 verdict for Midway needs one aimed at Midway.
- The schema manifest carries a removal tombstone until the next regeneration.

Historical migrations, their native fixtures and dated changelogs still name the pilot. They are the record of what ran and are not edited.
