# server/src/services/TheTunerStreamSeeksNotSkips.law.test.ts

`HorseSelfTuner` streams cash hands from `hand_history` by keyset on `(created_at, id)`, never by `.range(offset)`, and a failed stream costs only the horses it gap-fills, never the night. OFFSET paging over a table where cash is a minority cost over 25 s per deep page against the engine's 8 s timeout; when the fleet swung toward tournaments on 2026-09-26 the timeout killed the whole study, and the tuner claimed 2026-09-26, 09-27 and 09-28 while writing zero rows.
