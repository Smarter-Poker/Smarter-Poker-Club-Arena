# Lightning Pilot Tables Are Kept Full

Dan, 2026-10-15 09:11 Central: "set the Lightning pilot club's horse fleet policy
to keep its tables full (occupancy_bias 9), pilot club only."

The pilot's 72 horses were seated at the fleet's ordinary public-room rhythm (a
random 1..max target per table), which held 4 at the 9-max and 2 at the 6-max.
Phase 3 needs 18 and 27 live to cross the activation thresholds.

`20261015141154_lightning_pilot_tables_are_kept_full.sql` writes one club-scoped
`ca_horse_fleet_policy` row for the pilot through `fn_ca_fleet_set_policy` with
`occupancy_bias` 9 (`applyBias` rounds and caps at the table size, so every
pilot table targets full). It asserts the pilot's effective bias is 9 from the
club row, that no other pilot field moved, and that the global row and every
other club or union row are byte-identical. No chips move and no Lightning
control changes.
