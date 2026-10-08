-- 20261008041150_horse_hand_review_receipts_retention.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- HORSE HAND REVIEW RECEIPTS: BOUNDED RETENTION (Horse Brain P14.1 follow-up)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE OPEN LIMIT (docs/horse-brain-phase14-closure-2026-10-07.md, audit;
-- docs/horse-brain-phase15-closure-2026-10-08.md)
--
--   public.horse_hand_review_receipts (20261007020953, P14.1) was created
--   "never pruned": a receipt is what turns a late resend of a hand into
--   'replayed' instead of a second review row and a second horse_review_rollup
--   contribution, and review rows are pruned at 30 days. Read from
--   production at 2026-10-08 04:08Z: 46,590 receipts written since
--   2026-10-07 10:01Z, about 60,000 a day, and nothing ever removed them.
--
-- WHY A RECEIPT COULD NOT SIMPLY BE PRUNED
--
--   fn_hhr_record_atomic accepted a hand of ANY age. With the receipt and the
--   review row both gone, a resend inserts the review again and adds the hand
--   to the permanent rollup a second time. So "never pruned" was the only
--   thing standing between a lost reply and a double count.
--
-- THE ROOT FIX: a publication horizon, and receipts kept until past it
--
--   1. fn_hhr_record_atomic refuses, by name and writing nothing, to APPLY a
--      row whose played_at is more than 30 days before now()
--      (P0001 hhr_publication_expired). Only the first-time apply path is
--      affected: a receipt that still exists answers 'replayed' (or
--      hhr_identity_conflict) whatever the hand's age, and a legacy review
--      row with no receipt still answers 'historical_unknown'. Live hands are
--      published seconds after they settle, so nothing live is refused. The
--      body is patched in place from the exact installed definition (pinned
--      md5 below) with one inserted block; every other line, its
--      configuration and its privileges are unchanged.
--   2. sp_prune_horse_hand_reviews(), the existing owner of review retention
--      (called by the engine, HorseHandReview.ts; no cron, no new loop),
--      also deletes at most 50,000 receipts per call, oldest rollup_day
--      first, and only a receipt whose rollup_day is more than 32 UTC days
--      old AND whose review row no longer exists. rollup_day is the UTC day
--      of the same played_at, so a pruned receipt's hand was played more than
--      31 days ago and any later resend of it is refused by (1): a replay
--      after the prune is named and safe, never a second count. Its four
--      existing statements are byte-identical; the return value adds the
--      receipts removed.
--   3. An index on rollup_day so the bounded delete reads only what it
--      removes.
--
--   Capacity: the engine calls the prune once per process, 10 minutes after
--   its first flagged hand; production engine releases ran 4 to 13 times a
--   day over 2026-10-03..07, so 50,000 per call clears ~60,000 a day with
--   room. The first receipts (rollup_day 2026-10-07) become eligible on
--   2026-11-09 UTC.
--
--   This is retention (CLAUDE.md 10.12, "the two things this does NOT ban"),
--   inside the owner that already prunes reviews. Nothing is backfilled,
--   reset or repaired; horse_review_rollup is never touched.
--
-- Qualified by scripts/ci/test-horse-hand-review-atomic.py on a private
-- PostgreSQL 17 cluster (CI: accounting_postgres, shard 4).
--
-- @live-proof: (SELECT md5(prosrc) = 'ea26b896e3d95a70ed10ba86473c7e72' FROM pg_proc WHERE oid = to_regprocedure('public.sp_prune_horse_hand_reviews()'))
-- @live-proof: (SELECT md5(prosrc) = '315906962e9854aa3054b9ad4bc8ae79' FROM pg_proc WHERE oid = to_regprocedure('public.fn_hhr_record_atomic(jsonb)'))
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────
-- Preimage: exactly the definitions this migration was written against, and
-- never twice.
-- ─────────────────────────────────────────────────────────────────────────
DO $preimage$
BEGIN
  IF pg_catalog.to_regclass('public.horse_hand_review_receipts') IS NULL THEN
    RAISE EXCEPTION 'hhr_retention preimage: public.horse_hand_review_receipts is missing';
  END IF;
  IF pg_catalog.to_regclass('public.horse_hand_review_receipts_rollup_day_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'hhr_retention preimage: public.horse_hand_review_receipts_rollup_day_idx already exists';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc
       WHERE proname = 'fn_hhr_record_atomic' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'hhr_retention preimage: expected exactly one public.fn_hhr_record_atomic';
  END IF;
  IF (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc
       WHERE oid = pg_catalog.to_regprocedure('public.fn_hhr_record_atomic(jsonb)'))
     IS DISTINCT FROM '161e5883ca636e898463e3957b1b6f45' THEN
    RAISE EXCEPTION 'hhr_retention preimage: public.fn_hhr_record_atomic(jsonb) is not the 20261007020953 body';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc
       WHERE proname = 'sp_prune_horse_hand_reviews' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'hhr_retention preimage: expected exactly one public.sp_prune_horse_hand_reviews';
  END IF;
  IF (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc
       WHERE oid = pg_catalog.to_regprocedure('public.sp_prune_horse_hand_reviews()'))
     IS DISTINCT FROM 'd3972fedf8264f57f0ad39737faba044' THEN
    RAISE EXCEPTION 'hhr_retention preimage: public.sp_prune_horse_hand_reviews() is not the 20260905204620 body';
  END IF;
END
$preimage$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The bounded delete reads the oldest receipts by rollup_day.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX horse_hand_review_receipts_rollup_day_idx
  ON public.horse_hand_review_receipts (rollup_day);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The publication horizon, inserted into the first-time apply branch of
--    the installed fn_hhr_record_atomic, ahead of its receipt insert.
-- ─────────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  c_anchor constant text := E'      IF v_review_id IS NOT NULL THEN\n';
  c_block  constant text := E'      IF v_review_id IS NOT NULL THEN\n'
    || E'        -- PUBLICATION HORIZON (20261008041150). This row is about to be\n'
    || E'        -- applied for the first time. A hand played more than 30 days ago is\n'
    || E'        -- refused instead: sp_prune_horse_hand_reviews may already have pruned\n'
    || E'        -- its receipt (rollup_day over 32 UTC days old, review row gone), so\n'
    || E'        -- applying it could count it twice. A receipt that still exists has\n'
    || E'        -- answered above whatever the hand''s age, and a legacy review row\n'
    || E'        -- still answers historical_unknown below. Raising rolls back this\n'
    || E'        -- review insert and every earlier row of the call.\n'
    || E'        IF v_played < pg_catalog.now() - ''30 days''::pg_catalog.interval THEN\n'
    || E'          RAISE EXCEPTION USING ERRCODE = ''P0001'',\n'
    || E'            MESSAGE = pg_catalog.format(''hhr_publication_expired: hand %s horse %s was played at %s, outside the 30-day publication horizon'', v_hand, v_horse, v_played);\n'
    || E'        END IF;\n';
  v_def text;
BEGIN
  v_def := pg_catalog.pg_get_functiondef('public.fn_hhr_record_atomic(jsonb)'::regprocedure);
  IF (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, c_anchor, '')))
     / pg_catalog.length(c_anchor) <> 1 THEN
    RAISE EXCEPTION 'hhr_retention patch: the apply-branch anchor is not unique in fn_hhr_record_atomic';
  END IF;
  EXECUTE pg_catalog.replace(v_def, c_anchor, c_block);
END
$patch$;

-- The patch keeps the function's privileges; restated so the grant is read here.
REVOKE ALL ON FUNCTION public.fn_hhr_record_atomic(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_hhr_record_atomic(jsonb) TO service_role;

COMMENT ON FUNCTION public.fn_hhr_record_atomic(jsonb) IS
  'Atomic horse hand-review publication for one hand (1..10 horse rows carrying exactly the HorseReviewRow keys). One transaction: review row inserted once, horse_review_rollup arithmetic applied once (identical to fn_hhr_rollup_add), replay receipt kept. Returns {version:1, hand_id, rows:[{horse_user_id, status: applied|replayed|historical_unknown}]} in canonical horse order. Refuses with P0001 hhr_* on any invalid row or identity conflict, writing nothing; refuses hhr_publication_expired to apply a row played more than 30 days ago (its receipt may have been pruned). service_role only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The existing review-retention owner also bounds the receipts. Its four
--    existing statements are unchanged.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sp_prune_horse_hand_reviews() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare n int; m int; k int; j int; q int;
begin
  delete from horse_hand_reviews where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from horse_daily_nets where day < current_date - 180;
  get diagnostics m = row_count;
  delete from horse_daily_play where day < current_date - 180;
  get diagnostics k = row_count;
  delete from horse_tournament_daily where day < current_date - 180;
  get diagnostics j = row_count;
  -- Receipts (20261008041150): at most 50,000 per call, oldest first, and
  -- only once the receipt's UTC rollup_day is more than 32 days old AND its
  -- review row is gone. fn_hhr_record_atomic refuses to apply a hand played
  -- more than 30 days ago, so no resend can ever need a receipt removed here.
  delete from public.horse_hand_review_receipts r
   using (select c.hand_id, c.horse_user_id
            from public.horse_hand_review_receipts c
           where c.rollup_day < (pg_catalog.now() at time zone 'UTC')::date - 32
             and not exists (select 1 from public.horse_hand_reviews v
                              where v.hand_id = c.hand_id
                                and v.horse_user_id = c.horse_user_id)
           order by c.rollup_day
           limit 50000) old
   where r.hand_id = old.hand_id and r.horse_user_id = old.horse_user_id;
  get diagnostics q = row_count;
  return n + m + k + j + q;
end $$;

-- Daemon only, exactly as 20260905202805 left it (CREATE OR REPLACE keeps the
-- grant; restated so the definer-authorization check reads it here).
REVOKE ALL ON FUNCTION public.sp_prune_horse_hand_reviews() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sp_prune_horse_hand_reviews() TO service_role;

COMMENT ON TABLE public.horse_hand_review_receipts IS
  'Replay receipt for public.fn_hhr_record_atomic: one row per (hand, horse) whose review row and horse_review_rollup contribution were committed together. No foreign key. Kept while its review row exists and until its UTC rollup_day is more than 32 days old, then pruned by sp_prune_horse_hand_reviews (at most 50,000 per call, oldest first); fn_hhr_record_atomic refuses to apply any hand played more than 30 days ago, so a resend after the prune is refused (hhr_publication_expired), never counted twice. identity_digest is the sha256 of the typed immutable review values. Written only by fn_hhr_record_atomic.';

-- ─────────────────────────────────────────────────────────────────────────
-- Postimage: exact bodies, unchanged configuration and privileges.
-- ─────────────────────────────────────────────────────────────────────────
DO $postimage$
DECLARE
  v_p pg_catalog.pg_proc%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
     WHERE i.indexrelid = 'public.horse_hand_review_receipts_rollup_day_idx'::regclass
       AND i.indrelid = 'public.horse_hand_review_receipts'::regclass
       AND i.indisvalid AND NOT i.indisunique
  ) THEN
    RAISE EXCEPTION 'hhr_retention postimage: rollup_day index missing or invalid';
  END IF;

  SELECT * INTO v_p FROM pg_catalog.pg_proc WHERE oid = 'public.fn_hhr_record_atomic(jsonb)'::regprocedure;
  IF pg_catalog.md5(v_p.prosrc) <> '315906962e9854aa3054b9ad4bc8ae79'
     OR NOT v_p.prosecdef
     OR v_p.proconfig::text IS DISTINCT FROM '{"search_path=pg_catalog, pg_temp",lock_timeout=5s,statement_timeout=15s}'
     OR v_p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'hhr_retention postimage: fn_hhr_record_atomic is not the expected definition (md5 %, config %, acl %)',
      pg_catalog.md5(v_p.prosrc), v_p.proconfig, v_p.proacl;
  END IF;

  SELECT * INTO v_p FROM pg_catalog.pg_proc WHERE oid = 'public.sp_prune_horse_hand_reviews()'::regprocedure;
  IF pg_catalog.md5(v_p.prosrc) <> 'ea26b896e3d95a70ed10ba86473c7e72'
     OR NOT v_p.prosecdef
     OR v_p.proconfig::text IS DISTINCT FROM '{search_path=public}'
     OR v_p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'hhr_retention postimage: sp_prune_horse_hand_reviews is not the expected definition (md5 %, config %, acl %)',
      pg_catalog.md5(v_p.prosrc), v_p.proconfig, v_p.proacl;
  END IF;
END
$postimage$;

COMMIT;
