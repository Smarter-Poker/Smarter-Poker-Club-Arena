-- the_journal_window_is_a_snapshot_not_a_clock
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, drift board incidents 36f00e54 and
-- 446fbe37, both CRITICAL, both false):
--
--   "club_members.chip_balance moved 161.12 ... while the journal accounts
--    for 261.12: -100.00 unexplained" (player b83fa747), and
--   "table_seats.stack moved 25712.86 ... journal 25613.71: 99.15 unexplained".
--
-- Read from the rows: a 100.00 cash buy-in for b83fa747 at table 3571a3c5 has
-- its chip_ledger leg stamped created_at 09:34:39.617 and its
-- wallet_transactions row with balance_after 19347.56. The previous replay
-- reading was taken at 09:34:41.869 and recorded a balance of 49518.39 =
-- 19447.56 + 30070.83, the balance BEFORE that debit: the buy-in transaction
-- was still open at 09:34:41 and committed after it. The next reading
-- (06:40 today) opened its journal window at 09:34:41, so the leg - created_at
-- 09:34:39, two seconds before the window - was never counted, while the
-- balance it moved now was. One leg, missed on both sides of a boundary:
-- -100 on the wallet, +100 on the felt. The same crack explains the 99.15.
--
-- fn_ca_ledger_replay windows the journal by created_at, which is the clock
-- at INSERT time inside a transaction; the balance it compares against is what
-- the reading's snapshot could see, which is commit order. Any leg whose
-- transaction straddles a reading falls through for ever, and the replay
-- files it as drift.
--
-- THE FIX, at the reader: the window is the previous reading's SNAPSHOT.
-- Every reading records pg_current_snapshot() from the very statement that
-- read the balances and the journal. The next reading counts a leg when it is
-- NOT visible in the previous snapshot - i.e. it committed after that reading,
-- whatever its created_at says. created_at still bounds the scan (fifteen
-- minutes before the previous instant; a money transaction cannot be open
-- longer than the 5-minute statement_timeout), so the index is still used.
-- A leg's xmin is a 32-bit xid; fn_ca_xid8 restores the epoch from the
-- current snapshot so pg_visible_in_snapshot can judge it. Frozen tuples keep
-- their xmin (PostgreSQL >= 9.4), and a frozen leg is by definition older
-- than any snapshot we hold.
--
-- A change of basis is not drift (the replay's own rule): the basis version
-- becomes one-snapshot-v4, every account is rebaselined once and records its
-- first snapshot, and only readings that hold a previous snapshot are judged.
-- The two false incidents are resolved with this cause; no chips moved
-- wrongly (the buy-in was journaled, paid for and played).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_ledger_replay(integer)'::regprocedure)) <> '2a2c496a11cbd4aa398238182cfd8ab7' THEN
    RAISE EXCEPTION 'fn_ca_ledger_replay changed since this migration was written; re-read it before applying';
  END IF;
END
$pre$;

ALTER TABLE public.ca_account_snapshots ADD COLUMN IF NOT EXISTS read_snapshot text;
COMMENT ON COLUMN public.ca_account_snapshots.read_snapshot IS
  'pg_current_snapshot()::text from the statement that read this balance; the next reading counts a journal leg iff it is not visible in this snapshot';

-- A 32-bit tuple xmin, restored to the 64-bit xid the snapshot functions judge.
CREATE OR REPLACE FUNCTION public.fn_ca_xid8(p_xmin xid)
RETURNS xid8
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  WITH cur AS (
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS cur64
  ), parts AS (
    SELECT cur64, cur64 >> 32 AS epoch, cur64 & 4294967295 AS cur32, p_xmin::text::bigint AS x FROM cur
  )
  SELECT CASE
           /* bootstrap / frozen sentinel: older than everything */
           WHEN x < 3 THEN x
           /* same epoch as the current snapshot, or one epoch back if the
              32-bit counter has already wrapped past it */
           WHEN x <= cur32 THEN (epoch << 32) + x
           ELSE ((epoch - 1) << 32) + x
         END::text::xid8
    FROM parts;
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_xid8(xid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_xid8(xid) TO service_role;

-- The journal since a snapshot: legs that committed after the previous
-- reading, whatever their created_at says. p_prev_at only bounds the scan.
CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts_since_snapshot(p_prev_at timestamp with time zone, p_prev_snapshot pg_snapshot)
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH sides AS (
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.from_label AS other_lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
       AND l.to_entity_id IS NOT NULL
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, l.to_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
       AND l.from_entity_id IS NOT NULL
  ), resolved AS (
    SELECT s.*,
      CASE s.t
        WHEN 'player_wallet'  THEN 'club_members.chip_balance'
        WHEN 'table_stack'    THEN 'table_seats.stack'
        WHEN 'club_treasury'  THEN 'clubs.chip_treasury'
        WHEN 'union_bank'     THEN 'union_wallets.chip_balance'
        WHEN 'spin_reserve'   THEN 'spin_bonus_pools.balance'
        WHEN 'union_wallet'   THEN COALESCE(s.lbl,
               CASE WHEN s.other_lbl LIKE '%promo%'
                         AND EXISTS (SELECT 1 FROM public.unions u WHERE u.id = s.id)
                    THEN 'union_wallets.promo_wallet' END)
        WHEN 'bbj_pool'       THEN s.lbl
        WHEN 'promo_wallet'   THEN COALESCE(s.lbl,
               CASE WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)
                    THEN 'clubs.promo_balance'
                    WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.agents a WHERE a.id = s.id OR a.user_id = s.id)
                    THEN 'agents.promo_wallet_balance'
                    WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.unions u WHERE u.id = s.id)
                    THEN 'union_wallets.promo_wallet' END)
        WHEN 'agent_wallet'   THEN COALESCE(s.lbl, 'agents.agent_wallet_balance')
        ELSE NULL
      END AS col,
      CASE WHEN s.t = 'table_stack' THEN '00000000-0000-0000-0000-0000000fe17e'::uuid ELSE s.id END AS owner
      FROM sides s
     WHERE s.t <> 'prize_liability'
  )
  SELECT k.t || ':' || k.owner::text || ':' || k.col AS account_key,
         k.t, k.owner, NULL::uuid, k.col,
         round(sum(k.amt), 2), count(*), 0::bigint
    FROM resolved k
   WHERE k.col IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5
  UNION ALL
  SELECT NULL, 'unkeyable', NULL, NULL, NULL, round(sum(k.amt), 2), count(*), count(*)
    FROM resolved k
   WHERE k.col IS NULL
  HAVING count(*) > 0;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_replay(p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '540s'
AS $function$
  DECLARE
    v_now timestamptz := clock_timestamp();
    v_read_at timestamptz;
    /* v4 (2026-09-10): THE JOURNAL WINDOW IS A SNAPSHOT, NOT A CLOCK. A leg
       whose transaction straddled the previous reading (created_at before the
       reading, committed after it) fell through the created_at window for
       ever and read as drift (-100 / +100 on 2026-09-10). Every reading now
       records the snapshot it read under; the next reading counts a leg iff it
       was not visible in that snapshot. Every account rebaselines once. */
    v_basis text := 'one-snapshot-v4';
    r record; w record;
    v_checked int := 0; v_baselines int := 0; v_rebased int := 0;
    v_bad int := 0; v_unkeyable bigint := 0;
    v_this numeric; v_two numeric; v_cum numeric;
    v_worst numeric := 0; v_worst_key text; v_sample jsonb := '[]'::jsonb;
  BEGIN
    IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
      RAISE EXCEPTION 'fn_ca_ledger_replay is service only' USING ERRCODE = '42501';
    END IF;

    DROP TABLE IF EXISTS zz_replay_window;
    DROP TABLE IF EXISTS zz_replay_touched;
    DROP TABLE IF EXISTS zz_replay_prev;
    DROP TABLE IF EXISTS zz_replay_net;
    DROP TABLE IF EXISTS zz_replay_read;

    CREATE TEMP TABLE zz_replay_window ON COMMIT DROP AS
      SELECT a.* FROM public.fn_ca_leg_accounts(v_now - interval '26 hours', v_now) a;

    SELECT COALESCE(sum(w.unkeyable), 0) INTO v_unkeyable FROM zz_replay_window w WHERE w.account_type = 'unkeyable';

    CREATE TEMP TABLE zz_replay_touched ON COMMIT DROP AS
      SELECT w.* FROM zz_replay_window w
       WHERE w.account_type <> 'unkeyable'
       ORDER BY abs(w.net) DESC
       LIMIT GREATEST(COALESCE(p_limit, 5000), 1);

    CREATE TEMP TABLE zz_replay_prev ON COMMIT DROP AS
      SELECT t.account_key, s.balance AS prev_balance, s.taken_at AS prev_at,
             s.unexplained AS prev_unexplained, s.cum_unexplained AS prev_cum,
             s.basis_version AS prev_basis, s.read_snapshot AS prev_snapshot
        FROM zz_replay_touched t
        LEFT JOIN LATERAL (
          SELECT x.balance, x.taken_at, x.unexplained, x.cum_unexplained, x.basis_version, x.read_snapshot
            FROM public.ca_account_snapshots x
           WHERE x.account_key = t.account_key ORDER BY x.taken_at DESC LIMIT 1
        ) s ON true;

    /* THE BALANCE, THE JOURNAL AND THE SNAPSHOT ARE READ IN ONE STATEMENT.
       read_snapshot is pg_current_snapshot() evaluated by that statement, so
       it is exactly the visibility horizon the balances were read under, and
       it becomes the next run's window. */
    CREATE TEMP TABLE zz_replay_read (
      account_key text, prev_at timestamptz, prev_snapshot text, expected numeric,
      now_bal numeric, read_at timestamptz, read_snapshot text
    ) ON COMMIT DROP;

    FOR w IN SELECT DISTINCT prev_at, prev_snapshot FROM zz_replay_prev WHERE prev_at IS NOT NULL AND prev_snapshot IS NOT NULL LOOP
      v_read_at := clock_timestamp();
      WITH legs AS MATERIALIZED (
        SELECT a.account_key, a.net
          FROM public.fn_ca_leg_accounts_since_snapshot(w.prev_at, w.prev_snapshot::pg_snapshot) a
         WHERE a.account_key IS NOT NULL
      )
      INSERT INTO zz_replay_read (account_key, prev_at, prev_snapshot, expected, now_bal, read_at, read_snapshot)
      SELECT t.account_key, w.prev_at, w.prev_snapshot, COALESCE(l.net, 0),
             public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name),
             v_read_at, pg_current_snapshot()::text
        FROM zz_replay_touched t
        JOIN zz_replay_prev p ON p.account_key = t.account_key AND p.prev_at = w.prev_at
                             AND p.prev_snapshot = w.prev_snapshot
        LEFT JOIN legs l ON l.account_key = t.account_key;
    END LOOP;

    /* An account nobody has read before, or one whose last reading holds no
       snapshot (every reading before v4), is recorded, not judged. */
    v_read_at := clock_timestamp();
    INSERT INTO public.ca_account_snapshots
      (account_key, account_type, entity_id, club_id, column_name, balance, taken_at, is_baseline, basis_version, note, read_snapshot, cum_unexplained)
    SELECT t.account_key, t.account_type, t.entity_id, t.club_id, t.column_name,
           b.bal, v_read_at, true, v_basis,
           CASE WHEN p.prev_at IS NULL THEN 'baseline: first reading of this account, not judged'
                ELSE format('rebaselined onto %s: the previous reading (%s) windowed the journal by created_at, and a leg that straddled that reading is the reader''s to miss, not the account''s',
                            v_basis, COALESCE(p.prev_basis, 'the unversioned reader')) END,
           pg_current_snapshot()::text,
           0
      FROM zz_replay_touched t
      JOIN zz_replay_prev p ON p.account_key = t.account_key AND (p.prev_at IS NULL OR p.prev_snapshot IS NULL)
      CROSS JOIN LATERAL (
        SELECT public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name) AS bal
      ) b
     WHERE b.bal IS NOT NULL;
    GET DIAGNOSTICS v_baselines = ROW_COUNT;

    v_read_at := clock_timestamp();
    FOR r IN
      SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained, p.prev_cum, p.prev_basis,
             d.expected, d.now_bal, d.read_at, d.read_snapshot
        FROM zz_replay_touched t
        JOIN zz_replay_prev p ON p.account_key = t.account_key
        JOIN zz_replay_read d ON d.account_key = t.account_key AND d.prev_at = p.prev_at
    LOOP
      IF r.now_bal IS NULL THEN CONTINUE; END IF;

      /* A CHANGE OF BASIS IS NOT DRIFT. */
      IF COALESCE(r.prev_basis, '') <> v_basis THEN
        INSERT INTO public.ca_account_snapshots
          (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
           is_baseline, unexplained, cum_unexplained, basis_version, note, read_snapshot)
        VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name,
                r.now_bal, v_read_at, true, NULL, 0, v_basis,
                format('rebaselined onto %s: the previous reading (%s) windowed the journal by created_at, and a leg that straddled that reading is the reader''s to miss, not the account''s',
                       v_basis, COALESCE(r.prev_basis, 'the unversioned reader')),
                r.read_snapshot);
        v_rebased := v_rebased + 1;
        CONTINUE;
      END IF;

      v_checked := v_checked + 1;
      v_this := round((r.now_bal - r.prev_balance) - r.expected, 2);
      v_cum := round(v_this + COALESCE(r.prev_cum, 0), 2);
      v_two := CASE
                 WHEN abs(v_this) >= 100 THEN v_this
                 WHEN v_this <> 0 AND COALESCE(r.prev_unexplained, 0) <> 0
                      AND sign(v_this) = sign(r.prev_unexplained) THEN v_cum
                 ELSE 0
               END;

      INSERT INTO public.ca_account_snapshots
        (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
         is_baseline, unexplained, cum_unexplained, basis_version, note, read_snapshot)
      VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name,
              r.now_bal, v_read_at, false, v_this, v_cum, v_basis,
              format('moved %s, journal %s, unexplained %s this interval (cumulative %s, judged %s) since %s',
                     round(r.now_bal - r.prev_balance, 2), r.expected, v_this, v_cum, v_two, r.prev_at),
              r.read_snapshot);

      IF abs(v_two) > 0.005 THEN
        v_bad := v_bad + 1;
        IF abs(v_two) > abs(v_worst) THEN v_worst := v_two; v_worst_key := r.account_key; END IF;
        IF v_bad <= 20 THEN
          v_sample := v_sample || jsonb_build_object('account', r.account_key, 'moved', round(r.now_bal - r.prev_balance, 2),
                                                     'journal', r.expected, 'unexplained', v_this, 'cumulative', v_cum,
                                                     'since', r.prev_at);
        END IF;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_ledger_replay', 'ledger_imbalance',
          CASE WHEN abs(v_two) >= 100 THEN 'critical' ELSE 'warning' END,
          'ledger-replay:' || r.account_key || ':' || to_char(v_now, 'YYYY-MM-DD'),
          v_two, r.expected, round(r.now_bal - r.prev_balance, 2),
          'ledger', r.account_type, r.entity_id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          format('%s moved %s between %s and now while the journal accounts for %s: %s unexplained this interval, %s over the last two. The journal window is the previous reading''s snapshot, so a leg is counted exactly when it committed after that reading.',
                 r.column_name, round(r.now_bal - r.prev_balance, 2), r.prev_at, r.expected, v_this, v_cum),
          false,
          jsonb_build_object('account_key', r.account_key, 'column', r.column_name,
                             'moved', round(r.now_bal - r.prev_balance, 2), 'journal', r.expected,
                             'unexplained', v_this, 'cumulative', v_cum, 'judged', v_two,
                             'previous_at', r.prev_at, 'basis_version', v_basis));
      END IF;
    END LOOP;

    PERFORM public.fn_ca_kill_switch_trip('fn_ca_ledger_replay', v_worst,
      format('one account disagrees with the journal by %s (%s)', round(COALESCE(v_worst, 0), 2), COALESCE(v_worst_key, 'n/a')));

    RETURN jsonb_build_object('checked', v_checked, 'baselines', v_baselines, 'rebaselined', v_rebased,
                              'disagree', v_bad, 'worst', round(COALESCE(v_worst, 0), 2), 'worst_account', v_worst_key,
                              'unkeyable_legs', v_unkeyable, 'basis_version', v_basis,
                              'sample', v_sample, 'at', v_now);
  END;
  $function$;

-- Post-conditions: the helper judges the very leg that fell through, and the
-- two false incidents close with their cause.
DO $post$
DECLARE v_leg_xid8 xid8; v_cur pg_snapshot := pg_current_snapshot(); v_rows integer;
BEGIN
  SELECT public.fn_ca_xid8(l.xmin) INTO v_leg_xid8 FROM public.chip_ledger l WHERE l.id = '4706a571-17e3-4db1-a55a-044c206fb236';
  IF v_leg_xid8 IS NULL THEN RAISE EXCEPTION 'the straddling leg 4706a571 is not readable'; END IF;
  IF NOT pg_visible_in_snapshot(v_leg_xid8, v_cur) THEN
    RAISE EXCEPTION 'post-condition: fn_ca_xid8 misjudges a committed leg as invisible (xid8 %)', v_leg_xid8;
  END IF;
  IF position('fn_ca_leg_accounts_since_snapshot(' IN pg_get_functiondef('public.fn_ca_ledger_replay(integer)'::regprocedure)) = 0
     OR position('one-snapshot-v4' IN pg_get_functiondef('public.fn_ca_ledger_replay(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'post-condition: the replay does not window by snapshot';
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_ca_ledger_replay windowed the journal by chip_ledger.created_at (the clock at INSERT time inside a transaction) while comparing against balances read under a snapshot (commit order). A 100.00 buy-in leg for b83fa747 at table 3571a3c5 was stamped 09:34:39.617 and committed after the 09:34:41.869 reading, so the next window (opened at 09:34:41) never counted it while the balance it moved was counted: -100 on the wallet, +100 on the felt. Fixed in migration the_journal_window_is_a_snapshot_not_a_clock: every reading records its snapshot and the next reading counts a leg iff it committed after it.',
         correction_ref = 'migration the_journal_window_is_a_snapshot_not_a_clock',
         resolution = 'No chips moved wrongly: the buy-in is journaled (chip_ledger 4706a571, wallet_transactions balance_after 19347.56) and was played. Reader defect; every account rebaselines onto one-snapshot-v4 on the next run.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_ledger_replay'
     AND i.id IN ('36f00e54-4dc5-4dda-b42f-fa3d9be8c5e7', '446fbe37-a06c-414b-a94e-23b8cbc7526e');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN RAISE EXCEPTION 'expected to resolve 2 replay incidents, resolved %', v_rows; END IF;
END
$post$;

COMMIT;
