-- 20261005224736_the_diamond_horse_registers_from_its_own_balance.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against origin/main
-- and every remote branch, so it cannot collide with another agent's work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Diamond Arena tournaments are OPEN (ca_arena_settings.tournaments_enabled =
-- true, cash_games_enabled = false). While they are open, a PERSON can
-- register for a Diamond tournament and a HORSE cannot:
-- fn_register_horse_for_tournament(uuid,uuid,boolean) refused EVERY Diamond
-- event at its first statement, under the comment
--
--   -- DIAMOND PHASE 8: house-funded horse entries are Phase 9.
--
-- That comment scopes itself to HOUSE-FUNDED entries, but the refusal was
-- blanket. The owner's answer to design decision A18 is recorded and live:
--
--   fn_ca_diamond_economic_text('horse_entry_funding','all') = 'own_balance'
--
-- recorded by 20261005151918_diamond_economics_records_the_owner_answers.sql,
-- whose rationale for that row reads, verbatim:
--
--   "So a horse funds its Diamond entry from its own balance, through the
--    ordinary Diamond registration door a person uses."
--
-- and which names this very function and this very md5 as "the assumption
-- 10.5 forbids, and this row is the answer that retires it".
--
-- An entry funded from the horse's OWN balance needs no house funding at all,
-- so the blanket refusal denied what the recorded answer permits. Under
-- CLAUDE.md 10.5 (HORSES ARE PLAYERS, BINDING - NO EXCEPTIONS) that is a live
-- asymmetry, and 10.5 admits no "equal outcome by a different mechanism".
--
-- ───────────────────────────────────────────────────────────────────────────
-- WHY THIS TOUCHES TWO FUNCTIONS AND NOT ONE
-- ───────────────────────────────────────────────────────────────────────────
--
-- Lifting the refusal ALONE would be a money defect, not a fix. The horse
-- registration chain is
--
--   fn_register_horse_for_tournament(uuid,uuid,boolean)      <- the refusal
--     -> fn_register_horse_for_tournament_before_terminal_gate
--       -> fn_register_horse_for_tournament_before_atomic_lifecycle_gate
--         -> fn_register_horse_for_tournament_before_maintenance_gate  <- money
--
-- and that core is CHIPS ONLY. It debits a club wallet through
-- atomic_deduct_wallet_and_log and records the funding receipt with the asset
-- hard-coded 'chips'. Its own comment says so: "This original owner charged
-- chips; the public Diamond refusal and ticket owner remain unchanged." The
-- refusal was therefore load-bearing: it was the only thing keeping a Diamond
-- event out of the chip core. Removing it by itself would have charged CHIPS
-- for a Diamond entry, written a rake_records row for a fee that must stay in
-- custody, recorded the asset as 'chips', and created no Diamond custody row
-- at all - so every later Diamond door (drain, pay, refund, close_custody)
-- would have had nothing to work from. Ruling 16 also forbids a chip account
-- in a Diamond format outright.
--
-- The ordinary own-balance path for a Diamond entry already exists, in the
-- HUMAN door: fn_register_for_tournament_before_atomic_capacity_20260907
-- routes on fn_ca_tournament_unit_cents and charges through
-- fn_poker_diamond_tournament_charge. This migration gives the horse core the
-- SAME arm, statement for statement, so the horse goes through the door the
-- person goes through. It is not a parallel path and not a new mechanism: the
-- Diamond money door, the whole-amount rule, the idempotency-key shape, the
-- refusal-to-reason translation, the custody-named roster id, the rake_records
-- suppression and the funding asset are all the human door's, reused.
--
-- NO ECONOMICS ARE INVENTED. Every amount still comes from
-- fn_tournament_entry_split, exactly as before and exactly as for a person.
-- No stake, rake, guarantee, price or payout figure is introduced here.
--
-- WHAT STAYS REFUSED. 'funding_account' is house money and there is no
-- funding path for it yet, so it is refused BY NAME, and the reason says which
-- setting produced the refusal. An unset or unrecognised answer is refused by
-- name too, rather than guessed at.
--
-- THE SETTING IS READ AT CALL TIME. 'own_balance' is never hard-coded as the
-- decision: fn_ca_diamond_economic_text('horse_entry_funding','all') is called
-- on every Diamond registration, so changing the owner's answer is one INSERT
-- into ca_diamond_economics and no code change.
--
-- MEASURED LIVE 2026-10-05 (read-only, REPEATABLE READ): the Diamond Arena
-- holds ZERO tournaments of any status, so no entry can be attempted by
-- anybody - horse or person - until a Diamond event is created. This change is
-- latent at apply time and moves no Diamond. All 1,000 horses already hold
-- Diamonds in profiles.diamonds (ruling 9), fn_ca_entry_scope_ok admits every
-- profile to the Diamond arena by design, and fn_ca_house_board_allows_automation
-- is true for it because it is is_platform - so when the first Diamond event
-- is created the parity is real and not nominal.
--
-- NEITHER FUNCTION IS ON fn_ca_guard_watchlist() (checked live: false), so no
-- guard-redefinition declaration is required.
--
-- Two asserted substitutions: each live text is pinned by md5, each replaced
-- clause must occur exactly once, and each reverse substitution must reproduce
-- the pinned text, or the whole transaction aborts.
--
-- PINNED LIVE md5(pg_get_functiondef(...)) - both read 2026-10-05:
--   fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)
--     33de93271803a28f46c0a259bb2c01c4
--   fn_register_horse_for_tournament(uuid,uuid,boolean)
--     84c0354e68fb129b5373bc6024cba334
--
-- @live-proof: (SELECT position('horse_entry_funding' in pg_get_functiondef('public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('diamond_horse_funding_not_open' in pg_get_functiondef('public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure)) = 0)
-- @live-proof: (SELECT position('fn_poker_diamond_tournament_charge' in pg_get_functiondef('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('CASE WHEN v_unit=100 THEN' in pg_get_functiondef('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure)) > 0)
--
-- NOT APPLIED by the authoring agent. Apply once, outside the :50-:03 UTC
-- break window, as one transaction.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ───────────────────────────────────────────────────────────────────────────
-- 1. THE CORE LEARNS THE DIAMOND ARM THE HUMAN CORE ALREADY HAS.
--    Done FIRST: the door below must not open onto a core that cannot fund a
--    Diamond entry. Both are in this one transaction, so neither lands alone.
-- ───────────────────────────────────────────────────────────────────────────
DO $m1$
DECLARE
  v_oid oid := 'public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure;
  v_def text;
  v_new_def text;
  v_old text[];
  v_new text[];
  v_i integer;
  v_n integer;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '33de93271803a28f46c0a259bb2c01c4' THEN
    RAISE EXCEPTION
      'fn_register_horse_for_tournament_before_maintenance_gate is not the pinned text (md5 %)',
      md5(v_def);
  END IF;

  -- 1a. The unit decides the asset, as it does in the human door.
  v_old[1] := $o2a$DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  v_t record; v_username text;$o2a$;
  v_new[1] := $n2a$DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  -- 20261005224736 / A18 'own_balance' + CLAUDE.md 10.5: a Diamond entry is
  -- custody, exactly as it is for a person. The unit decides the asset, read
  -- from the same function the human door reads it from.
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);
  v_dia jsonb;
  v_t record; v_username text;$n2a$;

  -- 1b. The charge: a Diamond arm in front of the chip arm, identical to
  --     fn_register_for_tournament_before_atomic_capacity_20260907.
  v_old[2] := $o2b$  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN$o2b$;
  v_new[2] := $n2b$  IF v_split.charge > 0 AND v_unit = 100 THEN
    -- 20261005224736 / A18 'own_balance' + 10.5: THE HORSE PAYS THROUGH THE
    -- DOOR THE PERSON PAYS THROUGH. This arm is the human door's Diamond arm
    -- statement for statement, with the horse's own id in place of auth.uid().
    -- A Diamond entry is custody, not a club-wallet debit; the roster row is
    -- written after the charge and carries the id the custody row was named
    -- with. The horse's Diamonds are its own (profiles.diamonds, ruling 9) -
    -- no house money reaches this path, and fn_horse_fund_from_treasury (a
    -- chip account ruling 16 forbids in a Diamond format) is never called.
    IF v_split.charge <> trunc(v_split.charge) OR v_split.prize <> trunc(v_split.prize)
       OR v_split.rake <> trunc(v_split.rake) OR v_split.bounty <> trunc(v_split.bounty) THEN
      RAISE EXCEPTION 'diamond_tournament_requires_whole_amounts' USING ERRCODE = '23514';
    END IF;
    v_player_id := gen_random_uuid();
    BEGIN
      v_dia := public.fn_poker_diamond_tournament_charge(
        p_user_id, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake,
        v_player_id, 'poker-tournament-entry:' || p_tournament_id::text || ':' || p_user_id::text || ':' || v_player_id::text);
    EXCEPTION WHEN OTHERS THEN
      -- An ordinary refusal is answered the way the chip core answers one,
      -- with a reason the caller can say; anything else is raised.
      IF SQLERRM LIKE '%insufficient_settled_diamonds%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_diamonds');
      ELSIF SQLERRM LIKE '%diamond_tournaments_not_open%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
      ELSIF SQLERRM LIKE '%diamond_debt_requires_settlement%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_debt_requires_settlement');
      ELSIF SQLERRM LIKE '%diamond_tournament_entry_already_held%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
      RAISE;
    END;
  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN$n2b$;

  -- 1c. The roster row carries the id the custody row was named with.
  v_old[3] := $o2c$  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;$o2c$;
  v_new[3] := $n2c$  BEGIN
    IF v_dia IS NOT NULL THEN
      -- 20261005224736: the roster row carries the id the custody row was
      -- named with, and the head rides on it as it does for a chip entry so
      -- the roster trigger does not seed it a second time. The human door's
      -- Diamond insert, with the horse's own id.
      INSERT INTO public.tournament_players
        (id, tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (v_player_id, p_tournament_id, p_user_id, COALESCE(v_username,'Player'),
              v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSIF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;$n2c$;

  -- 1d. A Diamond fee stays in custody; rake_records is the chip estate's fee
  --     rail. The human door gates this on the same unit test.
  v_old[4] := $o2d$  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN$o2d$;
  v_new[4] := $n2d$  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL AND v_unit = 1 THEN$n2d$;

  -- 1e. The funding receipt names its asset, and the entry receipt says which
  --     asset paid and what the wallet holds after it, as the human door does.
  v_old[5] := $o2e$  -- This original owner charged chips; the public Diamond refusal and ticket
  -- owner remain unchanged. Bind only this transaction's actual debit IDs.
  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,
    v_split.charge,'chips',v_original_entitlement,v_original_wallet,NULL);

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'late_registration', v_late_open,
    'seat', v_seat);$o2e$;
  v_new[5] := $n2e$  -- 20261005224736: the asset follows the unit, exactly as the human door
  -- records it. A chip entry still binds this transaction's actual debit IDs;
  -- a Diamond entry binds its custody receipt instead, which is what every
  -- later Diamond door reads.
  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,
    v_split.charge,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,
    v_original_entitlement,v_original_wallet,v_dia);

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'late_registration', v_late_open,
    'asset', CASE WHEN v_dia IS NOT NULL THEN 'diamonds' ELSE 'chips' END,
    'diamonds_after', CASE WHEN v_dia IS NOT NULL
                           THEN (SELECT p.diamonds FROM public.profiles p WHERE p.id = p_user_id) END,
    'seat', v_seat);$n2e$;

  -- Every clause must occur EXACTLY ONCE before anything is replaced.
  v_new_def := v_def;
  FOR v_i IN 1..5 LOOP
    v_n := (length(v_new_def) - length(replace(v_new_def, v_old[v_i], '')))
           / length(v_old[v_i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'fn_register_horse_for_tournament_before_maintenance_gate: clause % occurs % times, expected 1',
        v_i, v_n;
    END IF;
    v_new_def := replace(v_new_def, v_old[v_i], v_new[v_i]);
  END LOOP;

  EXECUTE v_new_def;

  -- The reverse substitution must reproduce the pinned text byte for byte.
  v_new_def := pg_get_functiondef(v_oid);
  FOR v_i IN REVERSE 5..1 LOOP
    v_new_def := replace(v_new_def, v_new[v_i], v_old[v_i]);
  END LOOP;
  IF md5(v_new_def) <> '33de93271803a28f46c0a259bb2c01c4' THEN
    RAISE EXCEPTION
      'fn_register_horse_for_tournament_before_maintenance_gate: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m1$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE DOOR READS THE OWNER'S ANSWER INSTEAD OF ASSUMING IT.
-- ───────────────────────────────────────────────────────────────────────────
DO $m2$
DECLARE
  v_oid oid := 'public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure;
  v_def text;
  v_old text;
  v_new text;
  v_n integer;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '84c0354e68fb129b5373bc6024cba334' THEN
    RAISE EXCEPTION 'fn_register_horse_for_tournament(uuid,uuid,boolean) is not the pinned text (md5 %)',
      md5(v_def);
  END IF;

  v_old := $o1$  -- DIAMOND PHASE 8: house-funded horse entries are Phase 9.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','diamond_horse_funding_not_open');
  END IF;
$o1$;
  v_new := $n1$  -- 20261005224736 / A18 (horse_entry_funding, recorded 2026-10-05) and
  -- CLAUDE.md 10.5 (HORSES ARE PLAYERS - NO EXCEPTIONS). The owner's answer
  -- reads: "a horse funds its Diamond entry from its own balance, through the
  -- ordinary Diamond registration door a person uses." So this is no longer a
  -- blanket refusal resting on a Phase-9 assumption; it is that answer, READ
  -- AT CALL TIME. Changing the answer is one INSERT into ca_diamond_economics
  -- and no code change - 'own_balance' is never hard-coded as the decision.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    DECLARE
      v_horse_entry_funding text;
    BEGIN
      BEGIN
        v_horse_entry_funding :=
          public.fn_ca_diamond_economic_text('horse_entry_funding','all');
      EXCEPTION WHEN SQLSTATE 'P0D01' THEN
        -- No answer recorded. Refuse by name below rather than guess which
        -- funding the owner meant.
        v_horse_entry_funding := NULL;
      END;
      IF v_horse_entry_funding = 'funding_account' THEN
        -- House money, and there is no funding path for it yet. Refused by
        -- name, and the reason names the setting that produced the refusal.
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_funding_account_not_open',
          'horse_entry_funding',v_horse_entry_funding);
      ELSIF v_horse_entry_funding IS DISTINCT FROM 'own_balance' THEN
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_entry_funding_unrecognised',
          'horse_entry_funding',v_horse_entry_funding);
      END IF;
      -- 'own_balance': fall through. The horse takes the same seat-acquisition
      -- lock and the same registration chain a person takes, and pays from its
      -- own profiles.diamonds through the same Diamond door (10.5).
    END;
  END IF;
$n1$;

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'fn_register_horse_for_tournament: the Diamond refusal clause occurs % times, expected 1', v_n;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);

  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '84c0354e68fb129b5373bc6024cba334' THEN
    RAISE EXCEPTION
      'fn_register_horse_for_tournament: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m2$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. POST-APPLY ASSERTIONS. The end state, stated precisely enough to be
--    machine-checked, so "it looked right" is never load-bearing.
-- ───────────────────────────────────────────────────────────────────────────
DO $a$
DECLARE
  v_door text := pg_get_functiondef('public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure);
  v_core text := pg_get_functiondef('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure);
BEGIN
  -- The blanket refusal is gone, and the setting is what decides.
  IF position('diamond_horse_funding_not_open' in v_door) <> 0 THEN
    RAISE EXCEPTION 'the blanket Diamond horse refusal is still in the door';
  END IF;
  IF position($q$fn_ca_diamond_economic_text('horse_entry_funding','all')$q$ in v_door) = 0 THEN
    RAISE EXCEPTION 'the door does not read horse_entry_funding at call time';
  END IF;
  -- House funding is still refused, by name.
  IF position('diamond_horse_funding_account_not_open' in v_door) = 0 THEN
    RAISE EXCEPTION 'the door no longer refuses funding_account by name';
  END IF;
  IF position('diamond_horse_entry_funding_unrecognised' in v_door) = 0 THEN
    RAISE EXCEPTION 'the door no longer refuses an unrecognised answer by name';
  END IF;
  -- The core funds a Diamond entry through the Diamond door, in whole
  -- Diamonds, and no longer hard-codes the chip asset.
  IF position('fn_poker_diamond_tournament_charge' in v_core) = 0 THEN
    RAISE EXCEPTION 'the horse core does not charge through the Diamond door';
  END IF;
  IF position('diamond_tournament_requires_whole_amounts' in v_core) = 0 THEN
    RAISE EXCEPTION 'the horse core does not require whole Diamonds';
  END IF;
  IF position($q$v_split.charge,'chips',v_original_entitlement$q$ in v_core) <> 0 THEN
    RAISE EXCEPTION 'the horse core still records the funding asset as chips unconditionally';
  END IF;
  IF position('CASE WHEN v_unit=100 THEN' in v_core) = 0 THEN
    RAISE EXCEPTION 'the horse core does not route the funding asset by unit';
  END IF;
  -- No house money, and no chip treasury, on this path.
  IF position('fn_horse_fund_from_treasury' in v_core) <> 0
     OR position('fn_horse_fund_from_treasury' in v_door) <> 0 THEN
    RAISE EXCEPTION 'a chip treasury call reached the Diamond horse entry path (ruling 16)';
  END IF;
  -- The owner's answer still reads as player parity (CLAUDE.md 10.5).
  IF public.fn_ca_diamond_economic_text('horse_entry_funding','all') <> 'own_balance' THEN
    RAISE EXCEPTION 'horse_entry_funding is no longer own_balance; re-read A18 before relying on this apply';
  END IF;
  -- Both functions still compile as plpgsql and keep their signatures.
  IF position('fn_register_horse_for_tournament_before_terminal_gate' in v_door) = 0 THEN
    RAISE EXCEPTION 'the door no longer continues into the ordinary registration chain';
  END IF;
END $a$;

COMMIT;
