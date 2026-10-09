# A Diamond Hand Snapshot Is Written Too

## What Happened

Every crash-recovery snapshot write on a Diamond cash table threw "Do not know how to serialize a BigInt" inside the engine. The hand config records the Diamond rake schedule, whose exact decimal units are BigInt, and JSON has no BigInt. Measured 2026-10-09 05:13 UTC: 86 refusals in 20 minutes, and four live Diamond tables with 95 hands in 15 minutes had never had a snapshot. Chip cash and tournament tables were unaffected (712 tables, all snapshotting).

## What Is Now True

When a snapshot carries a Diamond schedule, its state and config are written with every BigInt as its exact decimal string. No reader turns config_json back into arithmetic, so recovery reads are unchanged. Chip and tournament snapshots are passed through as the identical objects, with no extra serialization pass.

## Proof

`server/src/services/supabase/aDiamondHandSnapshotIsWritten.test.ts`: a Diamond snapshot serializes with exact strings, a chip snapshot is passed through untouched, and non-BigInt values are kept exactly.
