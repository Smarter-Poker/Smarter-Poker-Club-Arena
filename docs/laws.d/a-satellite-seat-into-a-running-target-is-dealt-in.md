# tests/a-satellite-seat-into-a-running-target-is-dealt-in.law.test.ts

A door that admits a paid entrant into a tournament that is already RUNNING
takes their chair in the same transaction, through the canonical
`fn_seat_late_registrant`, or it does not admit them at all.
`fn_ca_settle_satellite_cohort`'s `'seat'` delivery used to write the target
registration with a raw INSERT and leave the chair to a launch that, for a
RUNNING target, has already happened and never runs again - so on 2026-09-22 a
satellite winner held a paid registration, `status = 'registered'`, no chair
and no stack for three days, and the tournament chip-conservation sentinel
correctly reported the event holding 120,000 against the 150,000 its five
entrants were issued: one starting stack that was never created, across 473
samples with zero hands dealt. The delivery now seats the winner and reads the
live chair back before booking anything, and a refusal aborts the delivery
rather than booking an entry the tournament will never deal in. The law also
pins the three sentinel functions unchanged, so the cheap fix - teaching the
checker to skip an entrant who has no chair, or widening
`p_tolerance_per_player` - fails CI instead of hiding the next one.
