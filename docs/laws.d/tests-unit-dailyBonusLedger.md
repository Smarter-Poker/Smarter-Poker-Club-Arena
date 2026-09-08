# tests/unit/dailyBonusLedger.law.test.ts

The Daily Club Arena Bonus pays diamonds and consumable credits, never chips: the ledger migration pays through `award_diamonds_v2` under `daily_bonus` with a per-slot reference, names no chip credit primitive, keeps the bonus inside the per-player diamond caps with no platform ceiling, caps a calendar tile at the 125-per-claim clamp, keeps the claims journal append-only and the payout table unreadable by browsers, and the migration that retired the chip ladder (`20260907232514`) stays mirrored with every drop it made.
