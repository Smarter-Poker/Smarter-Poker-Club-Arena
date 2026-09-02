-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901181237; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A tournament stack is play chips. It never credits a real wallet - whatever
-- the credit calls itself.
--
-- The existing guard in atomic_credit_wallet_and_log blocks exactly one
-- category:
--
--     IF p_category = 'cashout' AND p_table_id IS NOT NULL AND <tournament>
--
-- which is the shape that was caught on 2026-08-31, and it has refused 523
-- attempts since. But the block is keyed on what the CALLER named the credit,
-- not on what the credit does. Anything arriving with a different category -
-- 'addon_refund', 'refund', 'adjustment' - carrying a tournament table id would
-- pass straight through and turn play chips into real ones. There is a dead
-- helper in the engine (_refundAddOnToWallet) that does precisely that shape
-- with p_category='addon_refund'; it has zero callers today, and "zero callers
-- today" is not a guarantee.
--
-- Measured before widening: across the last 30 days exactly ONE category has
-- ever credited a wallet while carrying a tournament table id, and it is
-- 'cashout' - 1,133 credits. So dropping the category condition blocks nothing
-- that legitimately happens, and closes every other spelling of the same
-- mistake.
--
-- WHAT THIS DOES NOT TOUCH. Prizes, bounties and refunds that belong to a
-- tournament do not carry p_table_id at all - they identify the tournament
-- through p_related_entity_id and are paid by fn_credit_and_log. Nothing about
-- paying a winner changes here.
--
-- THE HISTORY, recorded because it is the largest single drift this platform
-- has had. Before the 08-31 guard, 1,133 of these credits succeeded between
-- 2026-08-06 and 2026-08-31 and 1,064 of them landed in real club wallets:
-- 47,598,560.86 chips across 410 players. 1,132 of the credits went to horses
-- (47,351,460.86); exactly one went to a human, for 247,100.00. Tournament
-- stacks are not counted in the supply watcher's felt, so every one of those
-- chips arrived in counted supply from somewhere uncounted - which is drift by
-- definition. Remediation is a money decision and is Dan's to make; this
-- migration only makes sure it cannot happen again.

DO $patch$
DECLARE
  v_def text;
  v_from text := 'IF p_category = ''cashout'' AND p_table_id IS NOT NULL AND EXISTS (';
  v_to   text := 'IF p_table_id IS NOT NULL AND EXISTS (';
  v_msg_from text := 'engine attempted a real-chip cashout of a tournament-table stack via atomic_credit_wallet_and_log - credit blocked; fix the engine exit path';
  v_msg_to   text := 'a tournament-table stack was about to credit a real wallet via atomic_credit_wallet_and_log - blocked. Tournament chips are play chips. This now blocks EVERY category, not just cashout; the category the caller used is in the metadata.';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_credit_wallet_and_log';

  IF v_def IS NULL THEN RAISE EXCEPTION 'atomic_credit_wallet_and_log does not exist'; END IF;
  IF position(v_from in v_def) = 0 THEN
    RAISE EXCEPTION 'the tournament guard is not the shape this migration expects - widen it by hand';
  END IF;

  v_def := replace(v_def, v_from, v_to);
  IF position(v_msg_from in v_def) > 0 THEN
    v_def := replace(v_def, v_msg_from, v_msg_to);
  END IF;
  /* carry the category into the incident so a new spelling is identifiable */
  v_def := replace(v_def,
    'jsonb_build_object(''user_id'', p_user_id, ''amount'', p_amount));',
    'jsonb_build_object(''user_id'', p_user_id, ''amount'', p_amount, ''category'', p_category));');

  EXECUTE v_def;
END $patch$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_credit_wallet_and_log';
  IF v_src LIKE '%p_category = ''cashout'' AND p_table_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'the guard is still category-scoped';
  END IF;
  IF v_src NOT LIKE '%tournament_mint_blocked%' THEN
    RAISE EXCEPTION 'the patch removed the tournament guard entirely';
  END IF;
  IF v_src NOT LIKE '%p_table_id IS NOT NULL AND EXISTS (%' THEN
    RAISE EXCEPTION 'the widened condition did not land';
  END IF;
END $$;
