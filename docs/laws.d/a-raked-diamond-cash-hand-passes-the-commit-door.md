# tests/a-raked-diamond-cash-hand-passes-the-commit-door.law.test.ts

A Diamond cash hand that pays rake must be able to settle. The commit door
fn_ca_commit_hand_settlement used to refuse every one of them, because two of
its rules contradicted each other: a Diamond hand must carry no chip rake
object, and any hand with a rake had to carry one. Migration 20261006154344
keeps the chip rake binding exactly as it was, but only for chip hands, and
keeps the Diamond rule (no chip rake object) in the same check. A Diamond
hand's rake is checked where it is settled: the Diamond settler recomputes it
from the owner's settings, refuses any other number, and records who paid it.
The law fails if the chip binding changes, if a Diamond hand could carry a
chip rake object, or if the settler stops recomputing and recording the rake.
