-- THE OUTBOX LEAVES THE REALTIME PUBLICATION (2026-09-10).
--
-- `hand_projection_outbox` is a queue, not a subject: one row is inserted per
-- accepted hand and deleted the moment the projection worker has it. It was in
-- `supabase_realtime` for exactly one reason - the engine used a Realtime
-- subscription as its wake signal - and it is the highest-churn table on the
-- platform, so every insert AND every delete went through WAL decoding for a
-- single in-process listener.
--
-- WHY IT IS SAFE TO REMOVE NOW. #4115 (deployed as 86aab0e645 at 07:55 UTC
-- today) gave the projection worker two wake sources that owe Realtime
-- nothing: a local in-process signal raised by the engine that wrote the row,
-- and a 5 s idle poll underneath it. Measured on production one minute after
-- that build resumed play:
--
--   poker_hand_projection_wakes_total{source="local"}    257
--   poker_hand_projection_wakes_total{source="realtime"} 257
--
-- The local counter tracks the Realtime counter one for one - every wake
-- Realtime delivered, the engine had already raised itself. Dropping the
-- publication removes a duplicate, not a signal.
--
-- WHY IT MATTERS. Realtime was also the half that failed. Its channel entered
-- CHANNEL_ERROR at about 03:14 UTC today and the build then deployed had no
-- net beneath it, so projection stopped dead and the outbox reached 130,129
-- rows, the oldest four hours old. The wake path that broke is the one being
-- removed; the two that replaced it cannot break the same way, because
-- neither leaves the process.
--
-- ENGINE_PG_LISTEN_URL stays unset deliberately - the LISTEN source in
-- handOutboxListener.ts exists for a future out-of-process projector and is
-- inert without it. `local` plus `poll` is the whole contract today.
--
-- ROLLBACK: ALTER PUBLICATION supabase_realtime ADD TABLE public.hand_projection_outbox;

BEGIN;

ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_projection_outbox;

COMMIT;
