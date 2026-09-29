-- Seed: production's MEASURED population shape, so the candidate migration can
-- be applied to this cluster byte-for-byte, including its production-population
-- assertion (166 held / 539 released, 2026-09-25).
--
--   164 expired 'held' holds on an IN-SCOPE club          -> must be reported
--     1 expired 'held' hold on an OUT-OF-SCOPE club, the
--       OLDEST of all, so it enters the bounded batch      -> scanned, files nothing
--     1 'held' hold that has NOT yet expired               -> must not be reported
--   539 expired 'released' holds                           -> must not be reported
--     1 expired 'captured' hold                            -> must not be reported
--     1 expired 'expired' hold                             -> must not be reported
BEGIN;

-- Fixture seeding only: the estate's auto-ledger triggers journal REAL balance
-- movements, and these rows are scaffolding, not movements. The role is reset
-- before anything is asserted, so every assertion runs with the triggers live.
SET LOCAL session_replication_role = replica;

TRUNCATE public.chip_escrow_holds;
DROP TABLE IF EXISTS public.zz_escrow_rehearsal_fingerprint;

INSERT INTO public.wallets (id, user_id, wallet_type, balance)
SELECT ('c0ffee00-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       u.id, 'PLAYER', 1000.00
  FROM generate_series(1, 9) g
  JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM auth.users) u ON u.rn = ((g - 1) % 9) + 1
ON CONFLICT (id) DO NOTHING;

-- 164 in-scope expired holds, staggered so "oldest 25" is a real ordering.
INSERT INTO public.chip_escrow_holds
  (wallet_id, user_id, club_id, hold_type, related_id, amount, status, expires_at, created_at)
SELECT w.id, w.user_id, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', 'other',
       '00000000-0000-0000-0000-000000000301',
       (1000 * g)::numeric, 'held',
       now() - interval '40 days' + (g * interval '1 minute'),
       now() - interval '41 days'
  FROM generate_series(1, 164) g
  JOIN (SELECT id, user_id, row_number() OVER (ORDER BY id) rn FROM public.wallets
         WHERE id::text LIKE 'c0ffee00%') w ON w.rn = ((g - 1) % 9) + 1;

-- the out-of-scope one, oldest of all, so the bounded batch must scan it
INSERT INTO public.chip_escrow_holds
  (id, wallet_id, user_id, club_id, hold_type, related_id, amount, status, expires_at, created_at)
SELECT 'e50f0000-0000-0000-0000-000000000099'::uuid,
       w.id, w.user_id, '00000000-0000-0000-0000-000000000101', 'other',
       '00000000-0000-0000-0000-000000000301', 777.00, 'held',
       now() - interval '90 days', now() - interval '91 days'
  FROM public.wallets w WHERE w.id::text LIKE 'c0ffee00%' ORDER BY w.id LIMIT 1;

-- a held hold that has not expired: the TTL is a TTL, not "every hold"
INSERT INTO public.chip_escrow_holds
  (id, wallet_id, user_id, club_id, hold_type, related_id, amount, status, expires_at, created_at)
SELECT 'e5aa0000-0000-0000-0000-000000000001'::uuid,
       w.id, w.user_id, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', 'other',
       '00000000-0000-0000-0000-000000000301', 500.00, 'held',
       now() + interval '3 days', now() - interval '1 day'
  FROM public.wallets w WHERE w.id::text LIKE 'c0ffee00%' ORDER BY w.id LIMIT 1;

-- 539 already-released holds, expired, carrying production's released_reason
INSERT INTO public.chip_escrow_holds
  (wallet_id, user_id, club_id, hold_type, related_id, amount, status, expires_at,
   created_at, released_at, released_reason)
SELECT w.id, w.user_id, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', 'other',
       '00000000-0000-0000-0000-000000000301', (100 * g)::numeric, 'released',
       now() - interval '40 days', now() - interval '41 days',
       now() - interval '41 days', 'table_unlock'
  FROM generate_series(1, 539) g
  JOIN (SELECT id, user_id, row_number() OVER (ORDER BY id) rn FROM public.wallets
         WHERE id::text LIKE 'c0ffee00%') w ON w.rn = ((g - 1) % 9) + 1;

-- a captured and an expired hold, both long past their TTL
INSERT INTO public.chip_escrow_holds
  (id, wallet_id, user_id, club_id, hold_type, related_id, amount, status, expires_at, created_at)
SELECT v.id::uuid, w.id, w.user_id, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', 'other',
       '00000000-0000-0000-0000-000000000301', 500.00, v.status,
       now() - interval '40 days', now() - interval '41 days'
  FROM (VALUES ('e5aa0000-0000-0000-0000-000000000003', 'captured'),
               ('e5aa0000-0000-0000-0000-000000000004', 'expired')) v(id, status)
  CROSS JOIN (SELECT id, user_id FROM public.wallets WHERE id::text LIKE 'c0ffee00%' ORDER BY id LIMIT 1) w;

SET LOCAL session_replication_role = origin;

-- Fingerprint the money book so the sweep can be proved to have moved nothing.
CREATE TABLE public.zz_escrow_rehearsal_fingerprint AS
SELECT (SELECT count(*) FROM public.chip_escrow_holds)                             AS holds,
       (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'held')        AS held,
       (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'released')    AS released,
       (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'captured')    AS captured,
       (SELECT count(*) FROM public.chip_escrow_holds WHERE status = 'expired')     AS expired,
       (SELECT COALESCE(sum(balance), 0) FROM public.wallets)                       AS wallet_total,
       (SELECT count(*) FROM public.wallet_transactions)                            AS wt_rows,
       (SELECT count(*) FROM public.chip_ledger)                                    AS cl_rows,
       (SELECT md5(string_agg(id::text || status || amount::text, ',' ORDER BY id))
          FROM public.chip_escrow_holds)                                            AS holds_hash;

DO $$
DECLARE v_exp bigint; v_held bigint; v_rel bigint;
BEGIN
  SELECT count(*) FILTER (WHERE status = 'held'),
         count(*) FILTER (WHERE status = 'released')
    INTO v_held, v_rel FROM public.chip_escrow_holds;
  SELECT count(*) INTO v_exp FROM public.chip_escrow_holds
   WHERE status = 'held' AND expires_at < now() - interval '10 minutes';
  IF v_held <> 166 OR v_rel <> 539 THEN
    RAISE EXCEPTION 'seed failed: %/% held/released, expected production''s 166/539', v_held, v_rel;
  END IF;
  IF v_exp <> 165 THEN
    RAISE EXCEPTION 'seed failed: % expired held holds, expected 165', v_exp;
  END IF;
  RAISE NOTICE 'SEED OK: 166 held / 539 released, 165 expired held (164 in scope, 1 out), 1 unexpired held, 1 captured, 1 expired';
END $$;

COMMIT;
