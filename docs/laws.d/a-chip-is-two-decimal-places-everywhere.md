# tests/a-chip-is-two-decimal-places-everywhere.law.test.ts

A chip is two decimal places everywhere. Pins the migration that declares the
unit: that it constrains the journal's running-balance columns, every live
balance, and the other currencies; that it adds each constraint NOT VALID
rather than rewriting a table with ALTER COLUMN TYPE; that it takes every lock
in one statement (a probe deadlocked without that); that its scope is stated
rather than discovered; that the two columns carrying measured historic residue
are left unvalidated with a catalogue comment saying why; and that it is
idempotent. Also pins that phase 9's three written contracts exist and say the
load-bearing things - restatement (clawback forbidden for our own defect, and
who decides by size), journal retention (seven years, never by deleting,
nothing moves without its attestation), and the epoch reset (the closing
position is journalled before anything is zeroed, opening grants come through
the Mint, and one migration can put every balance back).
