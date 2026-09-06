-- 20260905230611_phase_7_1_the_journal_replays_every_account_it_named.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 7.1, 2026-09-05 23:1x UTC):
--
-- Phase 7's headline: "nightly ledger-replay sampling (derive balances from
-- the journal and diff)". The platform already has the total (the hourly
-- supply meter), the jackpot (ca_bbj_pool_snapshots), the tournaments
-- (tournament_escrow against its shadow) and the chain checksum (the daily
-- attestation). What none of them can do is name the ACCOUNT: the supply
-- meter says the world moved by 5.44 and cannot say whose wallet it was.
--
-- THE REPLAY, and why it is exact rather than a sample. Every account keeps
-- its own snapshot; the check between any two consecutive snapshots of one
-- account is
--
--     stored_balance_now  -  stored_balance_at_previous_snapshot
--       ==  the journal's net for that account between those two instants
--
-- so an account is verified across its OWN two most recent readings, however
-- far apart, and an account that never moves needs no reading at all. The
-- first snapshot of an account is its baseline and is not judged; from the
-- second on, every chip that entered or left it has to be in the journal.
--
-- Sized against the rows before writing: over 24 hours the journal names 991
-- player wallets, 336 table felts, 5 club treasuries, 4 promo wallets, 2
-- union wallets, 2 BBJ pools and 2 spin reserves. That is the whole platform,
-- nightly, in one pass - "sampling" was a concession to a size this database
-- does not have.
--
-- NOT REPLAYED, each for a reason:
--   * prize_liability (10,992 events a day). It has a better check already:
--     tournament_escrow is its per-event balance, maintained by triggers in
--     the same transaction as every operational row and compared to its own
--     shadow every hour (Phase 5.1). A second, weaker replay of the same
--     accounts would only add noise.
--   * a leg whose side carries no label where the label is what names the
--     column (a union wallet has six, an agent two). 66 of 10,596 union legs
--     and 66 promo legs in six hours. They are counted and reported as
--     'unkeyable' rather than guessed at, and the count is the work item.
--
-- The finding is per account and says both numbers, so it localises drift to
-- one wallet on one night instead of one hour on one platform. It is judged
-- over TWO intervals, not one: a leg that commits between the balance read
-- and the window's end lands in one interval and reverses in the next, which
-- three player wallets demonstrated while this was being built (3.00 each,
-- gone on the following pass). Same rule as the BBJ meter, same reason.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_account_snapshots (
  id           bigserial PRIMARY KEY,
  account_key  text NOT NULL,
  account_type text NOT NULL,
  entity_id    uuid,
  club_id      uuid,
  column_name  text,
  balance      numeric NOT NULL,
  taken_at     timestamptz NOT NULL DEFAULT now(),
  is_baseline  boolean NOT NULL DEFAULT false,
  unexplained  numeric,
  note         text
);
CREATE INDEX IF NOT EXISTS ix_ca_account_snapshots_key_at ON public.ca_account_snapshots (account_key, taken_at DESC);
ALTER TABLE public.ca_account_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_account_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_account_snapshots TO service_role;
COMMENT ON TABLE public.ca_account_snapshots IS
  'Chip standard Phase 7.1: one balance reading per account per replay. fn_ca_ledger_replay checks that the change between an account''s two most recent readings equals the journal''s net for that account over the same interval.';

/* The account a leg touches, one row per side, keyed the same way on both
   sides so a journal net can be summed per account. NULL where the side
   names no account this replay can key (prize_liability, or a labelled
   column the leg did not carry). */
CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts(p_since timestamptz, p_until timestamptz)
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH sides AS (
    SELECT l.to_type AS t, l.to_entity_id AS id, l.club_id, l.to_label AS lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.to_entity_id IS NOT NULL
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.club_id, l.from_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.from_entity_id IS NOT NULL
  ), keyed AS (
    SELECT s.*,
      CASE s.t
        WHEN 'player_wallet'  THEN CASE WHEN s.club_id IS NOT NULL THEN 'club_members.chip_balance' END
        WHEN 'table_stack'    THEN 'table_seats.stack'
        WHEN 'club_treasury'  THEN 'clubs.chip_treasury'
        WHEN 'union_bank'     THEN 'union_wallets.chip_balance'
        WHEN 'spin_reserve'   THEN 'spin_bonus_pools.balance'
        WHEN 'union_wallet'   THEN s.lbl
        WHEN 'bbj_pool'       THEN s.lbl
        WHEN 'promo_wallet'   THEN s.lbl
        WHEN 'agent_wallet'   THEN COALESCE(s.lbl, 'agents.agent_wallet_balance')
        ELSE NULL
      END AS col
      FROM sides s
     WHERE s.t <> 'prize_liability'
  )
  SELECT k.t || ':' || k.id::text || ':' || COALESCE(k.club_id::text, '-') || ':' || k.col AS account_key,
         k.t, k.id, CASE WHEN k.t = 'player_wallet' THEN k.club_id ELSE NULL END, k.col,
         round(sum(k.amt), 2), count(*),
         0::bigint
    FROM keyed k
   WHERE k.col IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5
  UNION ALL
  SELECT NULL, 'unkeyable', NULL, NULL, NULL, round(sum(k.amt), 2), count(*), count(*)
    FROM keyed k
   WHERE k.col IS NULL
  HAVING count(*) > 0;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_account_balance(p_type text, p_entity uuid, p_club uuid, p_col text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v numeric;
BEGIN
  CASE p_col
    WHEN 'club_members.chip_balance' THEN
      SELECT COALESCE(sum(chip_balance), 0) INTO v FROM public.club_members WHERE user_id = p_entity AND club_id = p_club;
    WHEN 'table_seats.stack' THEN
      SELECT COALESCE(sum(stack), 0) INTO v FROM public.table_seats WHERE table_id = p_entity AND left_at IS NULL;
    WHEN 'clubs.chip_treasury' THEN
      SELECT COALESCE(chip_treasury, 0) INTO v FROM public.clubs WHERE id = p_entity;
    WHEN 'clubs.promo_balance' THEN
      SELECT COALESCE(promo_balance, 0) INTO v FROM public.clubs WHERE id = p_entity;
    WHEN 'clubs.insurance_balance' THEN
      SELECT COALESCE(insurance_balance, 0) INTO v FROM public.clubs WHERE id = p_entity;
    WHEN 'union_wallets.chip_balance' THEN
      SELECT COALESCE(chip_balance, 0) INTO v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.rake_wallet' THEN
      SELECT COALESCE(rake_wallet, 0) INTO v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.bbj_wallet' THEN
      SELECT COALESCE(bbj_wallet, 0) INTO v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.promo_wallet' THEN
      SELECT COALESCE(promo_wallet, 0) INTO v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.insurance_wallet' THEN
      SELECT COALESCE(insurance_wallet, 0) INTO v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.spin_reserve_wallet' THEN
      SELECT COALESCE(spin_reserve_wallet, 0) INTO v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'bbj_pools.main_balance' THEN
      SELECT COALESCE(main_balance, 0) INTO v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'bbj_pools.backup_balance' THEN
      SELECT COALESCE(backup_balance, 0) INTO v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'bbj_pools.promo_balance' THEN
      SELECT COALESCE(promo_balance, 0) INTO v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'spin_bonus_pools.balance' THEN
      SELECT COALESCE(sum(balance), 0) INTO v FROM public.spin_bonus_pools WHERE club_id = p_entity OR id = p_entity;
    WHEN 'agents.promo_wallet_balance' THEN
      SELECT COALESCE(sum(promo_wallet_balance), 0) INTO v FROM public.agents WHERE id = p_entity OR user_id = p_entity;
    WHEN 'agents.agent_wallet_balance' THEN
      SELECT COALESCE(sum(agent_wallet_balance), 0) INTO v FROM public.agents WHERE id = p_entity OR user_id = p_entity;
    ELSE
      v := NULL;
  END CASE;
  RETURN v;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_account_balance(text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_account_balance(text, uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_replay(p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  r record; v_at timestamptz;
  v_checked int := 0; v_baselines int := 0; v_bad int := 0; v_unkeyable bigint := 0;
  v_this numeric; v_two numeric;
  v_worst numeric := 0; v_worst_key text; v_sample jsonb := '[]'::jsonb;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_ca_ledger_replay is service only' USING ERRCODE = '42501';
  END IF;

  /* ONE SCAN PER INSTANT, NOT ONE PER ACCOUNT. Every account read in a run
     shares this run's end instant, and in the ordinary case they share the
     previous run's instant too, so the journal is read once per distinct
     previous reading (one, most nights) rather than once per wallet. The
     first shape of this function called the reader inside the loop: 200
     accounts meant 200 scans of a day of journal, and it did not finish. */
  /* Two runs in one transaction (the probe, and the assertion below) must not
     collide on the scratch names. */
  DROP TABLE IF EXISTS zz_replay_window;
  DROP TABLE IF EXISTS zz_replay_touched;
  DROP TABLE IF EXISTS zz_replay_prev;
  DROP TABLE IF EXISTS zz_replay_net;

  /* One read of the window for both answers: what moved, and what could not
     be keyed. The journal is the biggest table on the platform; it is scanned
     once here and once per distinct previous reading below, and nowhere else. */
  CREATE TEMP TABLE zz_replay_window ON COMMIT DROP AS
    SELECT a.* FROM public.fn_ca_leg_accounts(v_now - interval '26 hours', v_now) a;

  SELECT COALESCE(sum(w.unkeyable), 0) INTO v_unkeyable FROM zz_replay_window w WHERE w.account_type = 'unkeyable';

  CREATE TEMP TABLE zz_replay_touched ON COMMIT DROP AS
    SELECT w.* FROM zz_replay_window w
     WHERE w.account_type <> 'unkeyable'
     ORDER BY abs(w.net) DESC
     LIMIT GREATEST(COALESCE(p_limit, 5000), 1);

  CREATE TEMP TABLE zz_replay_prev ON COMMIT DROP AS
    SELECT t.account_key, s.balance AS prev_balance, s.taken_at AS prev_at, s.unexplained AS prev_unexplained
      FROM zz_replay_touched t
      LEFT JOIN LATERAL (
        SELECT x.balance, x.taken_at, x.unexplained FROM public.ca_account_snapshots x
         WHERE x.account_key = t.account_key ORDER BY x.taken_at DESC LIMIT 1
      ) s ON true;

  CREATE TEMP TABLE zz_replay_net (account_key text, prev_at timestamptz, net numeric) ON COMMIT DROP;
  FOR v_at IN SELECT DISTINCT prev_at FROM zz_replay_prev WHERE prev_at IS NOT NULL LOOP
    INSERT INTO zz_replay_net (account_key, prev_at, net)
    SELECT a.account_key, v_at, a.net FROM public.fn_ca_leg_accounts(v_at, v_now) a WHERE a.account_key IS NOT NULL;
  END LOOP;

  FOR r IN
    SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained,
           COALESCE((SELECT n.net FROM zz_replay_net n WHERE n.account_key = t.account_key AND n.prev_at = p.prev_at), 0) AS expected,
           public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name) AS now_bal
      FROM zz_replay_touched t JOIN zz_replay_prev p ON p.account_key = t.account_key
  LOOP
    IF r.now_bal IS NULL THEN CONTINUE; END IF;

    IF r.prev_at IS NULL THEN
      INSERT INTO public.ca_account_snapshots (account_key, account_type, entity_id, club_id, column_name, balance, taken_at, is_baseline, note)
      VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name, r.now_bal, v_now, true,
              'baseline: first reading of this account, not judged');
      v_baselines := v_baselines + 1;
      CONTINUE;
    END IF;

    v_checked := v_checked + 1;
    v_this := round((r.now_bal - r.prev_balance) - r.expected, 2);

    /* TWO INTERVALS, ONE FINDING. A leg that commits between the balance read
       and the window's end lands in one interval and reverses in the next, so
       a single interval's residue is noise and the two-interval sum is the
       finding - the same rule the BBJ meter uses, and for the same reason.
       Measured while building this: two passes microseconds apart reported
       three player wallets as 3.00 unexplained; every one was a buy-in that
       committed between the two reads, and every one cancelled next pass. */
    v_two := v_this + COALESCE(r.prev_unexplained, 0);

    INSERT INTO public.ca_account_snapshots (account_key, account_type, entity_id, club_id, column_name, balance, taken_at, is_baseline, unexplained, note)
    VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name, r.now_bal, v_now, false, v_this,
            format('moved %s, journal %s, unexplained %s (two intervals %s) since %s', round(r.now_bal - r.prev_balance, 2), r.expected,
                   v_this, v_two, r.prev_at));

    IF abs(v_two) > 0.005 THEN
      v_bad := v_bad + 1;
      IF abs(v_two) > abs(v_worst) THEN v_worst := v_two; v_worst_key := r.account_key; END IF;
      IF v_bad <= 20 THEN
        v_sample := v_sample || jsonb_build_object('account', r.account_key, 'moved', round(r.now_bal - r.prev_balance, 2),
                                                   'journal', r.expected, 'unexplained', v_this, 'two_intervals', v_two,
                                                   'since', r.prev_at);
      END IF;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_ledger_replay', 'ledger_imbalance',
        CASE WHEN abs(v_two) >= 100 THEN 'critical' ELSE 'warning' END,
        'ledger-replay:' || r.account_key || ':' || to_char(v_now, 'YYYY-MM-DD'),
        v_two, r.expected, round(r.now_bal - r.prev_balance, 2),
        'ledger', r.account_type, r.entity_id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        format('%s moved %s between %s and now while the journal accounts for %s: %s unexplained this interval, %s over the last two. The journal names every chip that entered or left an account; this one disagrees with its own balance.',
               r.column_name, round(r.now_bal - r.prev_balance, 2), r.prev_at, r.expected, v_this, v_two),
        false,
        jsonb_build_object('account_key', r.account_key, 'column', r.column_name,
                           'moved', round(r.now_bal - r.prev_balance, 2), 'journal', r.expected,
                           'unexplained', v_this, 'two_intervals', v_two, 'previous_at', r.prev_at));
    END IF;
  END LOOP;

  PERFORM public.fn_ca_kill_switch_trip('fn_ca_ledger_replay', v_worst,
    format('one account disagrees with the journal by %s (%s)', round(COALESCE(v_worst, 0), 2), COALESCE(v_worst_key, 'n/a')));

  RETURN jsonb_build_object('checked', v_checked, 'baselines', v_baselines, 'disagree', v_bad,
                            'worst', round(COALESCE(v_worst, 0), 2), 'worst_account', v_worst_key,
                            'unkeyable_legs', v_unkeyable, 'sample', v_sample, 'at', v_now);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_replay(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_replay(integer) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_ledger_replay', 'approved', 'chip standard Phase 7.1 (2026-09-05): derives each account''s expected movement from the journal and diffs it against the stored balance; writes snapshots, moves nothing'),
  ('fn_ca_leg_accounts', 'approved', 'chip standard Phase 7.1: reads the journal per account for a window; moves nothing'),
  ('fn_ca_account_balance', 'approved', 'chip standard Phase 7.1: reads one account''s stored balance by its column name; moves nothing')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

INSERT INTO public.ca_detector_registry (source, owner, sla_hours, auto_resolve_hours, note) VALUES
  ('fn_ca_ledger_replay', 'chip standard', 24, 72, 'per-account journal replay; a finding names the wallet, not just the hour')
ON CONFLICT (source) DO UPDATE SET auto_resolve_hours = EXCLUDED.auto_resolve_hours, note = EXCLUDED.note;

INSERT INTO public.ca_kill_switch_policy (detector, threshold_chips, armed, scopes, note) VALUES
  ('fn_ca_ledger_replay', 1000, true, ARRAY[]::text[], 'escalates when one account disagrees with the journal by 1,000 chips; a person opens the freeze')
ON CONFLICT (detector) DO NOTHING;

DO $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-ledger-replay-nightly';
  IF v_id IS NULL THEN
    PERFORM cron.schedule('ca-ledger-replay-nightly', '40 6 * * *',
      $c$ SET statement_timeout = '600s';
          SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-ledger-replay'))
                      THEN (public.fn_ca_ledger_replay(5000))::text
                      ELSE 'locked' END; $c$);
  END IF;
END $$;

DO $$
DECLARE v jsonb;
BEGIN
  IF to_regclass('public.ca_account_snapshots') IS NULL THEN RAISE EXCEPTION 'the snapshot table is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-ledger-replay-nightly') THEN RAISE EXCEPTION 'the replay is not scheduled'; END IF;
  -- a first pass over a small slice: every account it reads becomes a baseline, none is judged
  v := public.fn_ca_ledger_replay(25);
  IF (v->>'disagree')::int <> 0 THEN
    RAISE EXCEPTION 'the first pass judged an account it had never read: %', v;
  END IF;
  RAISE NOTICE 'replay first pass: %', v;
END $$;

COMMIT;
