-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260911151623; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260911151623   (the stamp IS the apply time, UTC: 2026-09-11 15:16:23)
--   name        a_diamond_transfer_names_both_sides_and_never_burns_what_it_
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 24848 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260911151623 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        ab_ca_diamond_transfer_names_its_counterparty
--     FUNCTION       public.fn_ca_diamond_journal_is_transfer, pg_temp.zz_patch_fn, public.fn_ca_diamond_transfer_names_its_counterparty
--     DROP           FUNCTION public.add_diamonds_to_balance, TRIGGER ab_ca_diamond_transfer_names_its_counterparty
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260911150027_a_diamond_transfer_names_both_sides_and_never_burns_what_it_.sql
--
-- A DIAMOND THAT ONLY MOVES IS NEVER BURNED, AND A TRANSFER NAMES BOTH SIDES.
--
-- THE INCIDENT. ca_drift_incidents 1610f514-d6cc-40ca-b543-6daac6cb159c,
-- raised by fn_ca_diamond_snapshot at 2026-09-11 08:10Z.
--
-- WHAT ACTUALLY HAPPENED. At 07:21:45.149667Z smarterpoker took one paid
-- Diamond Wheel spin on kingfish's club. fn_wheel_spin_core charges the price
-- and hands it to the host's owner (Dan, 2026-09-10). The two legs of that one
-- transfer were journaled differently: the -100 debit through deduct_diamonds
-- with source wheel_spin was classified 'spend' and the register BURNED 100
-- diamonds that were never retired, while the +100 credit was classified
-- 'transferred', which the register correctly skips. Balances moved 0; the
-- register moved -100.
--
-- Full reasoning, measurements and rollback are in the repo copy of this file
-- and in docs/changelog/2026-09-11-a-diamond-that-only-moves-is-never-burned.md.

BEGIN;

-- 0. The origin every existing journal row resolves to TODAY, so step 3 can
--    prove the register's rule did not move underneath 50,763 rows.
CREATE TEMP TABLE zz_origin_before ON COMMIT DROP AS
SELECT dt.id,
       public.fn_ca_diamond_journal_origin(dt.type, dt.transaction_type, dt.source,
                                           dt.issuance_class, dt.amount) AS origin
  FROM public.diamond_transactions dt;

-- 1. ONE definition of "this row is a transfer". Read by the register (which
--    skips these) and by the guard (which refuses one that names nobody).
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_is_transfer(
  p_type text, p_transaction_type text, p_source text, p_issuance_class text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn_is_transfer$
  WITH v AS (
    SELECT lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), '')) AS kind,
           lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), '')) AS class,
           lower(COALESCE(NULLIF(btrim(p_source), ''), '')) AS src
  )
  SELECT CASE
    -- The Mint's own doors register their own rows; the seed door writes its
    -- own 'seed:<id>' row. Neither is a transfer and neither may be judged as
    -- one. Same order, same reasons, as fn_ca_diamond_journal_origin.
    WHEN v.src = 'the_mint' THEN false
    WHEN v.kind = 'signup_bonus' OR v.src = 'handle_new_user' THEN false
    ELSE v.class = 'transferred'
      OR v.kind IN ('transfer', 'diamond_gift_sent', 'diamond_gift_received', 'diamond_received',
                    'live_gift_sent', 'live_gift_received', 'wallet_transfer',
                    'wallet_diamond_transfer', 'stream_gift', 'union_grant_transfer')
      OR v.kind LIKE '%gift%' OR v.kind LIKE '%transfer%'
  END
  FROM v;
$fn_is_transfer$;

COMMENT ON FUNCTION public.fn_ca_diamond_journal_is_transfer(text, text, text, text) IS
  'Player to player: supply moves, none is created or retired. THE one definition, read by fn_ca_diamond_journal_origin (which skips the register for these rows) and by ab_ca_diamond_transfer_names_its_counterparty (which refuses one that names nobody). Two callers, one rule, so the rule that lets a row out of the register can never drift from the rule that demands it name the other side.';

GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_journal_is_transfer(text, text, text, text) TO service_role;

-- 2. The register's own rule now READS that definition instead of holding a
--    second copy of it. Behaviour is unchanged and step 3 proves it.
DO $patch_origin$
DECLARE
  v_src text; v_old text; v_new text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_journal_origin';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_diamond_journal_origin is missing; refusing to guess at the register rule';
  END IF;
  IF position('fn_ca_diamond_journal_is_transfer' in v_src) > 0 THEN
    RETURN;  -- already applied
  END IF;

  v_old := $frag$  IF v_class = 'transferred'
     OR v_kind IN ('transfer', 'diamond_gift_sent', 'diamond_gift_received', 'diamond_received',
                   'live_gift_sent', 'live_gift_received', 'wallet_transfer',
                   'wallet_diamond_transfer', 'stream_gift', 'union_grant_transfer')
     OR v_kind LIKE '%gift%' OR v_kind LIKE '%transfer%' THEN
    RETURN NULL;
  END IF;$frag$;

  v_new := $frag$  IF public.fn_ca_diamond_journal_is_transfer(p_type, p_transaction_type, p_source, p_issuance_class) THEN
    RETURN NULL;
  END IF;$frag$;

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'fn_ca_diamond_journal_origin: expected exactly one transfer branch, found % - somebody else has edited it, read the live body before re-running', v_hits;
  END IF;
  EXECUTE replace(v_src, v_old, v_new);
END
$patch_origin$;

-- 3. THE REGISTER'S RULE DID NOT MOVE. Every journal row that exists must still
--    resolve to the origin it resolved to before step 2.
DO $assert_origin_unchanged$
DECLARE v_diff bigint; v_example text;
BEGIN
  SELECT count(*),
         min(b.id::text || ' was ' || COALESCE(b.origin, '(skipped)') ||
             ' now ' || COALESCE(public.fn_ca_diamond_journal_origin(dt.type, dt.transaction_type,
                                   dt.source, dt.issuance_class, dt.amount), '(skipped)'))
    INTO v_diff, v_example
    FROM zz_origin_before b
    JOIN public.diamond_transactions dt ON dt.id = b.id
   WHERE b.origin IS DISTINCT FROM
         public.fn_ca_diamond_journal_origin(dt.type, dt.transaction_type, dt.source,
                                             dt.issuance_class, dt.amount);
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'the register rule changed for % existing journal rows, e.g. %. Factoring the predicate out must not reclassify anything.', v_diff, v_example;
  END IF;
END
$assert_origin_unchanged$;

-- 4. One substitution helper, in pg_temp (11.5 rule 4: never in public).
CREATE OR REPLACE FUNCTION pg_temp.zz_patch_fn(p_name text, p_old text, p_new text, p_marker text)
RETURNS void
LANGUAGE plpgsql
AS $zz_patch$
DECLARE v_src text; v_hits int; v_overloads int;
BEGIN
  SELECT count(*) INTO v_overloads
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_name;
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'public.% has % definitions; a substitution cannot tell which one to edit', p_name, v_overloads;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_name;
  IF position(p_marker in v_src) > 0 THEN
    RETURN;  -- already applied
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, p_old, ''))) / length(p_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'public.%: expected exactly one occurrence of the fragment being replaced, found %. The live body has changed since this migration was written - read it, do not force this.', p_name, v_hits;
  END IF;
  EXECUTE replace(v_src, p_old, p_new);
END
$zz_patch$;

-- 5. THE ROOT CAUSE. A debit that NAMES A RECIPIENT is a transfer, whatever its
--    source is called.
SELECT pg_temp.zz_patch_fn(
  'deduct_diamonds',
  $old$    IF COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')$old$,
  $new$    -- A DEBIT THAT NAMES WHERE THE MONEY WENT IS A TRANSFER. This used to be
    -- decided by the source list below alone, so every new transfer path had to
    -- remember to add itself to it - and on 2026-09-11 the Diamond Wheel did not,
    -- so its spin price was journaled a spend, the register retired 100 diamonds
    -- that were sitting in the host owner's balance, and the hourly detector read
    -- 100 of unexplained supply. The classification follows the money now.
    IF COALESCE(p_metadata->>'recipient_id', '') <> ''
       OR COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')$new$,
  $marker$COALESCE(p_metadata->>'recipient_id', '') <> ''$marker$);

-- 6. A transfer CREDIT can now say who it came from.
SELECT pg_temp.zz_patch_fn(
  'add_diamonds_to_balance',
  $old$p_reference_id text DEFAULT NULL::text)$old$,
  $new$p_reference_id text DEFAULT NULL::text, p_counterparty_id uuid DEFAULT NULL::uuid)$new$,
  $marker$p_counterparty_id$marker$);

-- No overload is left behind: the five-argument door is closed, and every
-- existing five-argument caller keeps working through the new default. It is
-- closed HERE, between the two substitutions, because zz_patch_fn refuses to
-- edit a name that has two definitions.
DROP FUNCTION IF EXISTS public.add_diamonds_to_balance(uuid, integer, text, text, text);

SELECT pg_temp.zz_patch_fn(
  'add_diamonds_to_balance',
  $old$    v_issuance_class := 'transferred'; v_counterparty := 'player:unknown';$old$,
  $new$    -- NAME THE OTHER SIDE. ab_ca_diamond_transfer_names_its_counterparty refuses
    -- a transfer that cannot, because the register skips a transfer on the row's own
    -- word that a matching leg exists somewhere.
    v_issuance_class := 'transferred';
    v_counterparty := 'player:' || COALESCE(p_counterparty_id::text, 'unknown');$new$,
  $marker$p_counterparty_id::text$marker$);

GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text, uuid) TO postgres;

-- 7. The three diamond-game money paths name the player on the other side.
SELECT pg_temp.zz_patch_fn(
  'fn_wheel_spin_core',
  $old$'commit_id', p_commit_id, 'segment_version', cfg.segment_version),$old$,
  $new$'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),$new$,
  $marker$'recipient_id', v_owner$marker$);

SELECT pg_temp.zz_patch_fn(
  'fn_wheel_spin_core',
  $old$'wheel:' || v_spin_id::text || ':intake');$old$,
  $new$'wheel:' || v_spin_id::text || ':intake', v_user);$new$,
  $marker$':intake', v_user)$marker$);

SELECT pg_temp.zz_patch_fn(
  'fn_diamond_game_pay_diamonds',
  $old$'transfer', p_note, p_reference || ':host');$old$,
  $new$'transfer', p_note, p_reference || ':host', p_user);$new$,
  $marker$':host', p_user)$marker$);

SELECT pg_temp.zz_patch_fn(
  'fn_diamond_game_pay_diamonds',
  $old$'transfer', p_note, p_reference);$old$,
  $new$'transfer', p_note, p_reference, p_owner);$new$,
  $marker$p_note, p_reference, p_owner)$marker$);

SELECT pg_temp.zz_patch_fn(
  'fn_diamond_game_take_bet',
  $old$'transfer', p_owner_note, p_reference || ':intake');$old$,
  $new$'transfer', p_owner_note, p_reference || ':intake', p_user);$new$,
  $marker$':intake', p_user)$marker$);

-- 8. THE GUARD.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn_guard$
DECLARE v_cp text := btrim(COALESCE(NEW.counterparty, ''));
BEGIN
  IF COALESCE(NEW.amount, 0) = 0 THEN
    RETURN NEW;
  END IF;
  -- COALESCE, not NOT: an unreadable answer must not be read as "refuse". The
  -- register follows anything this says no to, so nothing goes unrecorded either way.
  IF COALESCE(public.fn_ca_diamond_journal_is_transfer(NEW.type, NEW.transaction_type,
                                                       NEW.source, NEW.issuance_class), false) = false THEN
    RETURN NEW;   -- the register will follow this row; nothing to prove here
  END IF;
  IF v_cp ~* '^player:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = substring(v_cp from 8)::uuid) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a diamond transfer must name the player on the other side: % of % diamonds for % carries counterparty %',
    COALESCE(NEW.transaction_type, NEW.type, 'transfer'), NEW.amount, NEW.user_id,
    COALESCE(NULLIF(v_cp, ''), '(none)')
    USING ERRCODE = 'P0408',
          HINT = 'The Mint register skips a transfer because supply only moves - which is only true if another leg moved it back. Name the counterparty: add_diamonds_to_balance p_counterparty_id, or recipient_id in the deduct_diamonds metadata.';
END
$fn_guard$;

COMMENT ON FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty() IS
  'Refuses a diamond journal row that the Mint register would skip as a transfer while naming nobody on the other side. Written after ca_drift_incidents 1610f514, where a Diamond Wheel intake of 100 was journaled transferred with counterparty player:unknown, skipped by the register, and showed up an hour later as unexplained supply.';

DROP TRIGGER IF EXISTS ab_ca_diamond_transfer_names_its_counterparty ON public.diamond_transactions;
CREATE TRIGGER ab_ca_diamond_transfer_names_its_counterparty
  BEFORE INSERT ON public.diamond_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_transfer_names_its_counterparty();

-- 9. THE MIGRATION PROVES ITSELF, in a subtransaction it rolls back.
DO $prove_the_identity$
DECLARE
  v_player uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';  -- smarterpoker
  v_owner  uuid := '47965354-0e56-43ef-931c-ddaab82af765';  -- kingfish, the host's owner
  v_bet integer; v_b0 numeric; v_b1 numeric; v_r0 numeric; v_r1 numeric;
  v_ref text := 'migration-probe:' || gen_random_uuid()::text;
  v_d jsonb; v_c jsonb; v_msg text; v_unexplained numeric;
BEGIN
  SELECT LEAST(100, GREATEST(COALESCE(diamonds, 0), 0))::integer INTO v_bet
    FROM public.profiles WHERE id = v_player;
  IF COALESCE(v_bet, 0) < 1 THEN
    RAISE EXCEPTION 'the probe account holds nothing to bet; pick another before re-running';
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SELECT COALESCE(sum(diamonds), 0) INTO v_b0 FROM public.profiles;
    SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_r0
      FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player';

    v_d := public.deduct_diamonds(v_player, v_bet, 'Migration probe spin', 'wheel_spin', 'wheel_spin',
             jsonb_build_object('recipient_id', v_owner), v_ref, 0);
    v_c := public.add_diamonds_to_balance(v_owner, v_bet, 'transfer', 'Migration probe intake',
             v_ref || ':intake', v_player);

    SELECT COALESCE(sum(diamonds), 0) INTO v_b1 FROM public.profiles;
    SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_r1
      FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player';

    -- The RAISE is what undoes every row above. An error is the success case.
    RAISE EXCEPTION 'ZZPROBE:%:%:%', COALESCE(v_d->>'success', 'null'),
      COALESCE(v_c->>'success', 'null'), ((v_b1 - v_b0) - (v_r1 - v_r0));
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg NOT LIKE 'ZZPROBE:%' THEN
      RAISE EXCEPTION 'the probe could not run the fixed wheel path at all: %', v_msg;
    END IF;
  END;

  IF split_part(v_msg, ':', 2) <> 'true' OR split_part(v_msg, ':', 3) <> 'true' THEN
    RAISE EXCEPTION 'the fixed wheel path refused its own money: %', v_msg;
  END IF;
  v_unexplained := split_part(v_msg, ':', 4)::numeric;
  IF v_unexplained <> 0 THEN
    RAISE EXCEPTION 'the fix does not hold: a wheel spin still leaves % of player supply the Mint register cannot explain', v_unexplained;
  END IF;
END
$prove_the_identity$;

-- 10. AND THE GUARD REFUSES THE SHAPE THAT CAUSED THE INCIDENT.
DO $prove_the_guard$
DECLARE
  v_owner uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  v_refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.add_diamonds_to_balance(v_owner, 1, 'transfer', 'Guard probe intake',
              'guard-probe:' || gen_random_uuid()::text);
    RAISE EXCEPTION 'ZZGUARD:not_refused';
  EXCEPTION
    WHEN SQLSTATE 'P0408' THEN v_refused := true;
    WHEN OTHERS THEN
      IF SQLERRM = 'ZZGUARD:not_refused' THEN
        v_refused := false;
      ELSE
        RAISE EXCEPTION 'the guard probe failed for an unrelated reason: %', SQLERRM;
      END IF;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'ab_ca_diamond_transfer_names_its_counterparty accepted a transfer credit naming nobody; the hole this migration exists to close is still open';
  END IF;
END
$prove_the_guard$;

-- 11. THE 100 THAT ALREADY MOVED. Corrected forward, never by editing 03c1bad4.
DO $correct_the_register$
DECLARE
  v_spin   constant text := '84aba5a7-32e0-4aec-a1c2-d7fbdc32466b';
  v_burn   constant text := 'diamond-journal:spend:8b1fedc6-0532-4d84-bdea-c36adfa11864';
  v_op     constant text := 'register-correction:wheel:84aba5a7-32e0-4aec-a1c2-d7fbdc32466b';
  v_payer  constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_burned numeric; v_intake_registered int; v_net numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger WHERE op_id = v_op) THEN
    RETURN;  -- already corrected
  END IF;

  -- The register is append-only, so these two facts cannot have moved. Live
  -- balances are deliberately NOT asserted: they change every minute for
  -- honest reasons, and none of them is evidence about this defect.
  SELECT amount INTO v_burned FROM public.ca_mint_ledger
   WHERE op_id = v_burn AND action = 'burn' AND asset = 'diamonds'
     AND holder_type = 'player' AND holder_id = v_payer;
  IF v_burned IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'the register row this corrects is not the 100-diamond burn it was measured to be (found %); read the board again before correcting it', COALESCE(v_burned::text, 'nothing');
  END IF;

  SELECT count(*) INTO v_intake_registered
    FROM public.ca_mint_ledger m
   WHERE m.diamond_tx_id = '38a3f40b-fef7-4cd0-ba8a-6bb710506f45';
  IF v_intake_registered <> 0 THEN
    RAISE EXCEPTION 'the wheel intake is already in the register (% rows); correcting again would double count', v_intake_registered;
  END IF;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id, created_at)
  SELECT
    v_op, 'mint', 'diamonds', 'player', p.id,
    COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text),
    100,
    COALESCE(p.diamonds, 0), COALESCE(p.diamonds, 0),
    (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
       FROM public.ca_mint_ledger WHERE asset = 'diamonds') + 100,
    'Register correction: the Mint retired nothing here. The 100 diamonds charged for Diamond Wheel spin '
      || v_spin || ' were transferred to the host owner, not destroyed, so register row ' || v_burn
      || ' recorded a retirement that never happened and player supply read 100 short of what players hold. '
      || 'This row puts those 100 back into measured supply. No player balance is changed by it, and nothing '
      || 'is clawed back. See migration 20260911150027 and ca_drift_incidents 1610f514-d6cc-40ca-b543-6daac6cb159c.',
    -- ca_mint_ledger.origin is GENERATED from op_id; a 'register-correction:'
    -- key resolves to 'operator', which is what this is: the house correcting
    -- its own books, not a movement any journal row asked for.
    NULL, 'migration 20260911150027', NULL, NULL, now()
    FROM public.profiles p WHERE p.id = v_payer
  ON CONFLICT (op_id) DO NOTHING;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_net
    FROM public.ca_mint_ledger WHERE op_id IN (v_burn, v_op);
  IF v_net <> 0 THEN
    RAISE EXCEPTION 'the correction did not close the spin: the register still moves % for spin %', v_net, v_spin;
  END IF;
END
$correct_the_register$;

-- 12. The incident is answered in its own row (10.9).
UPDATE public.ca_drift_incidents
   SET status = 'resolved',
       root_cause = 'fn_wheel_spin_core charged the spin price through deduct_diamonds with source wheel_spin, which is not on that function''s hardcoded transfer list, so the debit was journaled issuance_class spend and fn_ca_diamond_journal_origin had the Mint register BURN 100 diamonds. The matching credit to the host owner was journaled transferred, which the register correctly skips. One transfer, two classifications: balances moved 0 and the register moved -100.',
       correction_ref = 'migration 20260911150027; ca_mint_ledger op_id register-correction:wheel:84aba5a7-32e0-4aec-a1c2-d7fbdc32466b',
       resolution = 'The 100 diamonds are where they should be: smarterpoker paid 100 for one Diamond Wheel spin at 07:21:45Z and kingfish, the host club''s owner, took them in, which is exactly Dan''s 2026-09-10 ruling that diamonds taken in are credited to the club owner. All three mirrors agree with profiles for both accounts, so nothing was lost and no balance is adjusted here. Only the register was wrong, and it is corrected forward by one compensating row rather than by editing the burn. The writer is fixed so both legs of a diamond-game movement are transfers the register skips together, and ab_ca_diamond_transfer_names_its_counterparty now refuses any journal row that escapes the register while naming nobody on the other side. The detector keeps its 50-diamond threshold and its measurement unchanged.',
       resolved_at = now(),
       last_seen_at = GREATEST(last_seen_at, now())
 WHERE id = '1610f514-d6cc-40ca-b543-6daac6cb159c'
   AND status <> 'resolved';

-- 13. Post-apply assertions. Everything this migration claims, checked.
DO $assert_the_shape$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'add_diamonds_to_balance';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'add_diamonds_to_balance has % definitions; exactly one is required or a five-argument call becomes ambiguous', v_n;
  END IF;
  IF to_regprocedure('public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'the six-argument add_diamonds_to_balance is not there';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'diamond_transactions' AND NOT t.tgisinternal
                    AND t.tgname = 'ab_ca_diamond_transfer_names_its_counterparty') THEN
    RAISE EXCEPTION 'the transfer guard trigger is not installed';
  END IF;
  IF 'ab_ca_diamond_transfer_names_its_counterparty' <= 'aa_ca_diamond_journal_classifier' THEN
    RAISE EXCEPTION 'the guard would fire before the classifier fills counterparty';
  END IF;

  IF NOT public.fn_ca_diamond_journal_is_transfer('wheel_spin', 'wheel_spin', 'wheel_spin', 'transferred') THEN
    RAISE EXCEPTION 'a named wheel debit is no longer read as a transfer';
  END IF;
  IF public.fn_ca_diamond_journal_is_transfer('wheel_spin', 'wheel_spin', 'wheel_spin', 'spend') THEN
    RAISE EXCEPTION 'an unnamed spend is being read as a transfer';
  END IF;
  IF public.fn_ca_diamond_journal_is_transfer('earn', 'mint', 'the_mint', 'transferred') THEN
    RAISE EXCEPTION 'the Mint''s own door is being read as a transfer; it registers its own rows';
  END IF;
  IF public.fn_ca_diamond_journal_origin('wheel_spin', 'wheel_spin', 'wheel_spin', 'transferred', -100) IS NOT NULL THEN
    RAISE EXCEPTION 'the register still follows a wheel spin that only moved diamonds';
  END IF;
  IF public.fn_ca_diamond_journal_origin('wheel_spin', 'wheel_spin', 'wheel_spin', 'spend', -100) <> 'spend' THEN
    RAISE EXCEPTION 'a genuine spend no longer registers';
  END IF;
  IF public.fn_ca_diamond_journal_origin('daily_challenge_claim', 'daily_challenge_claim', NULL, 'earned', 20) <> 'reward' THEN
    RAISE EXCEPTION 'a reward no longer registers';
  END IF;

  IF (SELECT position($m$'recipient_id', v_owner$m$ in p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_wheel_spin_core') = 0 THEN
    RAISE EXCEPTION 'fn_wheel_spin_core does not name the host owner on the spin price';
  END IF;
  IF (SELECT position($m$p_metadata->>'recipient_id'$m$ in p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'deduct_diamonds') = 0 THEN
    RAISE EXCEPTION 'deduct_diamonds still decides a transfer from its source list alone';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents
              WHERE id = '1610f514-d6cc-40ca-b543-6daac6cb159c' AND status <> 'resolved') THEN
    RAISE EXCEPTION 'the drift incident is still open';
  END IF;
END
$assert_the_shape$;

COMMIT;
