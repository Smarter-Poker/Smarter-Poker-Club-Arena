-- 20260921024924_the_measurement_functions_say_what_they_measure
--
-- RENAME ONLY. No behaviour changes in this migration.
--
-- 20260921023309 introduced two READ-ONLY measurement functions and named them
-- inside the `reconcile` family they sit next to:
--
--     fn_ca_reconcile_treasury_positions()
--     fn_ca_reconcile_remeasure(text, uuid)
--
-- `scripts/ci/check-no-new-band-aids.mjs` refused that branch, and it was
-- RIGHT to: `reconcile` is one of the band-aid words, because in this estate a
-- newly declared `_reconcile_` function has almost always been repair
-- machinery - a thing that pays, tops up or re-drives what the live path
-- should have done correctly (CLAUDE.md 10.12).
--
-- These two are not that. Both are STABLE and neither writes anything:
--
--   * fn_ca_treasury_positions() computes each club's treasury position -
--     ca_treasury_baseline opening + post-cutover chip_ledger flow, against
--     clubs.chip_treasury. reconcile_ledger_nightly RECORDS what it returns.
--   * fn_ca_remeasure_entity(entity_type, entity_id) asks whether a stored
--     ledger_reconcile_log finding is still true right now, and answers
--     measurable + severity, or measurable=false meaning CANNOT TELL.
--
-- So the guard is not being weakened and nothing is being added to
-- band-aid.allowlist.json - that file is existing DEBT and may only ever get
-- shorter, and a read-only measurement is not debt. The names were simply
-- wrong: neither function reconciles anything. One MEASURES a position, the
-- other RE-MEASURES an entity. The new names say that, and they carry no
-- band-aid word.
--
-- This is the branch-scope declare-then-drop the checker documents, and the
-- same shape as the 2026-09-07 precedent it cites (the live Stripe refund
-- handler `reconcile_diamond_purchase_refund` renamed to
-- `fn_diamond_purchase_refund`, whose already-applied mirror could not
-- otherwise have landed on main). 20260921023309 is already applied to
-- production and recorded byte-exactly in schema_migrations, so it is not
-- edited; this migration renames forward.
--
-- The two callers are recreated because plpgsql resolves a called function by
-- NAME at run time - renaming underneath them would leave the reconciler and
-- the escalator calling functions that no longer exist.
--
-- ASSERTED AT APPLY TIME:
--   * the renamed function returns exactly what the old one did, for every
--     club, before the old one is dropped;
--   * the old names are gone afterwards;
--   * Deep Stack Society still re-measures ok with drift 0.00.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. THE POSITION, UNDER A NAME THAT SAYS WHAT IT IS -------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_treasury_positions()
RETURNS TABLE(
  club_id        uuid,
  ledger_balance numeric,
  stored_balance numeric,
  opening        numeric,
  credited       numeric,
  debited        numeric,
  severity       text,
  unbaselined    boolean,
  cutover        timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH cut AS (
    SELECT MIN(taken_at) AS t0 FROM public.ca_treasury_baseline
  ),
  base AS (
    SELECT b.club_id, b.opening_balance FROM public.ca_treasury_baseline b
  ),
  credits AS (
    SELECT cl.to_entity_id AS club_id, SUM(cl.amount) AS amt
      FROM public.chip_ledger cl, cut
     WHERE cl.to_type = 'club_treasury' AND cl.to_entity_id IS NOT NULL
       AND cl.created_at >= cut.t0
     GROUP BY cl.to_entity_id
  ),
  debits AS (
    SELECT cl.from_entity_id AS club_id, SUM(cl.amount) AS amt
      FROM public.chip_ledger cl, cut
     WHERE cl.from_type = 'club_treasury' AND cl.from_entity_id IS NOT NULL
       AND cl.created_at >= cut.t0
     GROUP BY cl.from_entity_id
  ),
  ids AS (
    SELECT b.club_id FROM base b
    UNION SELECT c.club_id FROM credits c
    UNION SELECT d.club_id FROM debits d
  ),
  ledger AS (
    SELECT i.club_id,
           b.opening_balance + COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance,
           b.opening_balance   AS opening,
           COALESCE(c.amt, 0)  AS credited,
           COALESCE(d.amt, 0)  AS debited
      FROM ids i
      LEFT JOIN base    b ON b.club_id = i.club_id
      LEFT JOIN credits c ON c.club_id = i.club_id
      LEFT JOIN debits  d ON d.club_id = i.club_id
  ),
  stored AS (
    SELECT c.id AS club_id, COALESCE(c.chip_treasury, 0) AS balance
      FROM public.clubs c
  ),
  merged AS (
    SELECT COALESCE(l.club_id, s.club_id) AS club_id,
           l.balance               AS ledger_balance,
           COALESCE(s.balance, 0)  AS stored_balance,
           l.opening               AS opening,
           COALESCE(l.credited, 0) AS credited,
           COALESCE(l.debited, 0)  AS debited
      FROM ledger l FULL OUTER JOIN stored s USING (club_id)
     WHERE (COALESCE(l.balance, 0) <> 0 OR COALESCE(s.balance, 0) <> 0)
  )
  SELECT m.club_id,
         COALESCE(m.ledger_balance, m.stored_balance),
         m.stored_balance,
         m.opening,
         m.credited,
         m.debited,
         /* A MISSING BASELINE IS NOT AN OPENING OF ZERO (2026-09-08). */
         CASE
           WHEN m.ledger_balance IS NULL                         THEN 'warn'
           WHEN ABS(m.stored_balance - m.ledger_balance) = 0     THEN 'ok'
           WHEN ABS(m.stored_balance - m.ledger_balance) <= 1.00 THEN 'warn'
           ELSE 'critical'
         END,
         (m.ledger_balance IS NULL),
         (SELECT MIN(taken_at) FROM public.ca_treasury_baseline)
    FROM merged m
   WHERE m.club_id IS NOT NULL;
$fn$;

COMMENT ON FUNCTION public.fn_ca_treasury_positions() IS
'The one definition of a club treasury position: ca_treasury_baseline opening + post-cutover chip_ledger flow, compared with clubs.chip_treasury. Read by reconcile_ledger_nightly (which records it) and by fn_ca_remeasure_entity (which asks it whether a stored finding is still true). Read-only and STABLE: it measures, it never repairs. Do not copy this arithmetic into a third place.';

-- PROVE THE RENAMED FUNCTION IS THE SAME FUNCTION, BEFORE DROPPING THE OLD ONE
DO $assert$
DECLARE
  v_diff integer;
  v_old  integer;
  v_new  integer;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM (
       (SELECT * FROM public.fn_ca_reconcile_treasury_positions()
        EXCEPT ALL
        SELECT * FROM public.fn_ca_treasury_positions())
       UNION ALL
       (SELECT * FROM public.fn_ca_treasury_positions()
        EXCEPT ALL
        SELECT * FROM public.fn_ca_reconcile_treasury_positions())
     ) d),
    (SELECT COUNT(*) FROM public.fn_ca_reconcile_treasury_positions()),
    (SELECT COUNT(*) FROM public.fn_ca_treasury_positions())
  INTO v_diff, v_old, v_new;

  IF v_diff <> 0 OR v_old <> v_new THEN
    RAISE EXCEPTION
      'the renamed treasury function is not the same function: % differing rows (old=%, new=%)',
      v_diff, v_old, v_new;
  END IF;

  RAISE NOTICE 'rename proved identical across % clubs', v_new;
END;
$assert$;

-- 2. THE RE-MEASURE, UNDER A NAME THAT SAYS WHAT IT IS ------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_remeasure_entity(
  p_entity_type text,
  p_entity_id   uuid)
RETURNS TABLE(measurable boolean, ledger_balance numeric, stored_balance numeric, severity text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  /* THREE OUTCOMES, NEVER TWO (CLAUDE.md 10.86 rule 1). "I cannot measure
     this entity type" is its own answer and must never be dressed up as
     'ok' - that would silence a real critical - nor as 'critical', which
     is the bug this function exists to stop. */
  IF p_entity_type = 'club_treasury' AND p_entity_id IS NOT NULL THEN
    RETURN QUERY
      SELECT true, p.ledger_balance, p.stored_balance, p.severity
        FROM public.fn_ca_treasury_positions() p
       WHERE p.club_id = p_entity_id;

    IF FOUND THEN
      RETURN;
    END IF;

    -- Absent from the merged set means no stored treasury AND no flow since
    -- the cutover. That is a measurement of zero, not a failure to measure.
    RETURN QUERY SELECT true, 0::numeric, 0::numeric, 'ok'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_remeasure_entity(text, uuid) IS
'Asks whether a stored ledger_reconcile_log finding is STILL true, right now. Returns measurable=false for entity types it cannot compute - callers must treat that as UNKNOWN and say so, never as ok. Read-only and STABLE. Extend it by teaching it an entity type, never by returning a guess.';

-- 3. THE TWO CALLERS NOW CALL THE NEW NAMES ----------------------------------
-- plpgsql resolves a called function by NAME at run time, so these must move in
-- the same transaction as the rename or they break the moment the old names go.

CREATE OR REPLACE FUNCTION public.reconcile_ledger_nightly()
 RETURNS TABLE(total_checked integer, ok_count integer, warn_count integer, critical_count integer, worst_drift numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_total   INT := 0;
  v_ok      INT := 0;
  v_warn    INT := 0;
  v_crit    INT := 0;
  v_worst   NUMERIC := 0;
  v_frozen  NUMERIC;
  v_now     NUMERIC;
  v_left    NUMERIC;
BEGIN
  DELETE FROM public.ledger_reconcile_log WHERE run_date = CURRENT_DATE AND entity_type = ANY (public.fn_ca_reconcile_owned_entity_types());

  SELECT frozen_total INTO v_frozen
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  -- The frozen pool is the PRE-FREEZE rows. Post-freeze rows belong to
  -- certification accounts whose harness chips cycle through the no-club
  -- fallback and are deleted by the certification cleanup; they are not the
  -- stranded pool. And a pre-freeze row can LEAVE, because public.wallets
  -- cascades from profiles and auth.users - a deleted row is not a write, so
  -- recorded departures are added back before comparing. An attributable
  -- teardown nets to zero; an unrecorded change still pages. This is the same
  -- arithmetic fn_ca_quick_reconcile has used since 2026-09-02.
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets
   WHERE created_at < '2026-08-22';
  SELECT COALESCE(SUM(deleted_balance), 0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  v_now := v_now + COALESCE(v_left, 0);
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  VALUES (
    'frozen_wallets_pool', NULL, COALESCE(v_frozen, 0), v_now,
    CASE WHEN v_frozen IS NULL THEN 'critical'
         WHEN v_now = v_frozen  THEN 'ok'
         ELSE 'critical' END,
    jsonb_build_object(
      'source', 'reconcile_ledger_nightly',
      'rule', 'pool frozen 2026-08-21: any movement means a money path is writing to the dead pool',
      'baseline', v_frozen, 'observed', v_now));

  /* CLUB TREASURY, MEASURED FROM THE LINE (2026-08-31).
     The arithmetic lives in fn_ca_treasury_positions() (2026-09-21) so that
     the escalator can re-measure a stored finding with the SAME formula this
     records. Do not inline it again here: two copies of a tuned formula is
     how one of them silently stops matching. */
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'club_treasury', p.club_id, p.ledger_balance, p.stored_balance, p.severity,
    jsonb_build_object('source', 'reconcile_ledger_nightly',
                       'unbaselined', p.unbaselined,
                       'note', CASE WHEN p.unbaselined
                         THEN 'no ca_treasury_baseline row for this club, so its opening balance is unknown and no drift is computed; trg_ca_club_gets_a_baseline writes one for every club created from 2026-09-08'
                         END,
                       'basis', 'ca_treasury_baseline + post-cutover chip_ledger flow',
                       'opening_balance', p.opening,
                       'credited_since', p.credited,
                       'debited_since', p.debited,
                       'cutover', p.cutover)
  FROM public.fn_ca_treasury_positions() p;

  -- INSURANCE + EV-CASHOUT BANK (2026-08-28)
  WITH led AS (
    SELECT bank_type, bank_entity_id,
           SUM(COALESCE(premium,0) - COALESCE(payout,0)) AS bal,
           COUNT(*) AS contracts
    FROM public.insurance_transactions
    WHERE bank_entity_id IS NOT NULL
    GROUP BY bank_type, bank_entity_id
  ),
  joined AS (
    SELECT l.bank_type, l.bank_entity_id, l.bal AS ledger_balance, l.contracts,
           COALESCE(
             CASE WHEN l.bank_type = 'union'
                  THEN (SELECT w.insurance_wallet FROM public.union_wallets w
                         WHERE w.union_id = l.bank_entity_id)
                  ELSE (SELECT c.insurance_balance FROM public.club_wallets c
                         WHERE c.club_id = l.bank_entity_id) END,
             0) AS stored_balance
    FROM led l
  )
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'insurance_bank', j.bank_entity_id, j.ledger_balance, j.stored_balance,
    CASE
      WHEN ABS(j.stored_balance - j.ledger_balance) = 0     THEN 'ok'
      WHEN ABS(j.stored_balance - j.ledger_balance) <= 0.01 THEN 'warn'
      ELSE 'critical'
    END,
    jsonb_build_object('source', 'reconcile_ledger_nightly',
                       'bank_type', j.bank_type, 'contracts', j.contracts)
  FROM joined j;

  -- INSURANCE FUNNEL INTEGRITY (added 2026-08-28): every offer must resolve.
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'insurance_offer_unresolved', u.player_id, u.offered, u.resolved, 'critical',
         jsonb_build_object('source', 'reconcile_ledger_nightly',
                            'table_id', u.table_id, 'hand_number', u.hand_number,
                            'last_offer', u.last_offer)
  FROM public.fn_unresolved_insurance_offers('1 day'::interval) u;

  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'seat_stack_exit', x.user_id, x.stack, 0, 'critical',
         jsonb_build_object(
           'source', 'fn_unaccounted_seat_exits',
           'exit_id', x.exit_id, 'table_id', x.table_id,
           'club_id', x.club_id, 'exit_kind', x.exit_kind,
           'db_role', x.db_role, 'app_name', x.app_name,
           'occurred_at', x.occurred_at)
  FROM public.fn_unaccounted_seat_exits('1 day'::interval) x;

  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'chip_circulation', c.club_id, c.on_the_felt, c.total, 'ok',
         jsonb_build_object(
           'source', 'fn_club_chip_circulation',
           'club_name', c.club_name,
           'member_wallets', c.member_wallets,
           'on_the_felt', c.on_the_felt,
           'treasury', c.treasury)
  FROM public.fn_club_chip_circulation() c
  WHERE c.total <> 0;

  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'cashout_escrow_stuck', e.player_id, e.amount, 0, 'critical',
         jsonb_build_object(
           'source', 'cashier_integrity',
           'escrow_id', e.id, 'cashout_id', e.cashout_request_id,
           'club_id', e.club_id, 'request_status', cr.status,
           'shape', CASE WHEN e.released_at IS NULL THEN 'unreleased_on_closed_request'
                         ELSE 'released_on_pending_request' END)
  FROM public.chip_escrow e
  JOIN public.cashout_requests cr ON cr.id = e.cashout_request_id
  WHERE (e.released_at IS NULL AND cr.status <> 'pending')
     OR (e.released_at IS NOT NULL AND cr.status = 'pending');

  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'negative_balance', t.entity_id, t.amount, 0, 'critical',
         jsonb_build_object('source', 'cashier_integrity', 'pool', t.pool, 'club_id', t.club_id)
  FROM (
    SELECT a.user_id AS entity_id, a.agent_wallet_balance AS amount, 'agent_wallet' AS pool, a.club_id
      FROM public.agents a WHERE COALESCE(a.agent_wallet_balance, 0) < 0
    UNION ALL
    SELECT a.user_id, a.promo_wallet_balance, 'promo_wallet', a.club_id
      FROM public.agents a WHERE COALESCE(a.promo_wallet_balance, 0) < 0
    UNION ALL
    SELECT m.user_id, m.chip_balance, 'player_wallet', m.club_id
      FROM public.club_members m WHERE COALESCE(m.chip_balance, 0) < 0
    UNION ALL
    SELECT c.id, c.chip_treasury, 'club_treasury', c.id
      FROM public.clubs c WHERE COALESCE(c.chip_treasury, 0) < 0
  ) t;

  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'over_claimed_send', ct.from_user_id,
         COALESCE((ct.metadata ->> 'claimed_back')::numeric, 0), ct.amount, 'critical',
         jsonb_build_object('source', 'cashier_integrity',
                            'transaction_id', ct.id, 'club_id', ct.club_id)
  FROM public.chip_transactions ct
  WHERE ct.transaction_type = 'agent_wallet_send'
    AND COALESCE((ct.metadata ->> 'claimed_back')::numeric, 0) > ct.amount;

  -- BOMB-POT AWARD LEDGER (added 2026-08-29)
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'bomb_award_ledger_gap', NULL, g.net_winnings, g.ledger_total, 'critical',
         jsonb_build_object(
           'source', 'fn_bomb_pot_ledger_gaps',
           'hand_history_id', g.hand_history_id,
           'table_id', g.table_id,
           'hand_number', g.hand_number,
           'occurred_at', g.occurred_at,
           'board_count', g.board_count,
           'trigger_reason', g.trigger_reason,
           'award_units', g.award_units)
  FROM public.fn_bomb_pot_ledger_gaps('1 day'::interval) g;

  SELECT
    COUNT(*)::INT                                          AS total,
    COUNT(*) FILTER (WHERE severity = 'ok')::INT           AS ok,
    COUNT(*) FILTER (WHERE severity = 'warn')::INT         AS warn,
    COUNT(*) FILTER (WHERE severity = 'critical')::INT     AS crit,
    COALESCE(MAX(ABS(stored_balance - ledger_balance)), 0) AS worst
  INTO v_total, v_ok, v_warn, v_crit, v_worst
  FROM public.ledger_reconcile_log
  WHERE run_date = CURRENT_DATE;

  total_checked  := v_total;
  ok_count       := v_ok;
  warn_count     := v_warn;
  critical_count := v_crit;
  worst_drift    := v_worst;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escalate_reconcile_criticals(p_lookback interval DEFAULT '36:00:00'::interval)
 RETURNS TABLE(considered integer, filed integer, superseded integer, unmeasurable integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r        record;
  m        record;
  v_seen   integer := 0;
  v_filed  integer := 0;
  v_super  integer := 0;
  v_unmeas integer := 0;
  v_id     uuid;
  v_class  text;
  v_drift  numeric;
  v_exp    numeric;
  v_act    numeric;
  v_state  text;
BEGIN
  FOR r IN
    -- Newest row per entity. An entity critical for a week must not raise
    -- seven incidents; fn_ca_raise_drift_incident counts the recurrence.
    /* THE NEWEST ROW DECIDES, NOT THE NEWEST CRITICAL ROW (2026-09-08).
       The severity filter used to sit in this WHERE, so DISTINCT ON picked
       the newest CRITICAL row per entity rather than the newest row - and
       an entity whose latest reading is ok kept re-escalating its last
       critical for the whole lookback. Deep Stack Society read ok at
       13:01:35 and was escalated again at 13:52 from a 2026-09-07 row.
       Every fix in this repo was being undone on the board for 36 hours. */
    SELECT * FROM (
      SELECT DISTINCT ON (l.entity_type, l.entity_id)
             l.entity_type, l.entity_id, l.drift, l.ledger_balance,
             l.stored_balance, l.run_date, l.metadata, l.severity, l.created_at
        FROM public.ledger_reconcile_log l
       WHERE l.created_at >= now() - p_lookback
       ORDER BY l.entity_type, l.entity_id, l.created_at DESC
    ) newest WHERE newest.severity = 'critical'
  LOOP
    v_seen := v_seen + 1;

    /* AND THE NEWEST ROW IS STILL ONLY A MEMORY (2026-09-21).
       reconcile_ledger_nightly runs every six hours; this runs every hour.
       So for up to six hours after a fix lands, the newest row is a PRE-FIX
       critical and there is no later row to overrule it - the 2026-09-08
       guard above cannot help, because it needs a newer reading to exist.
       On 2026-09-21 that re-raised Deep Stack Society's +2624.78 treasury
       drift as ee2a3395 at 01:52, 47 minutes after migration
       20260921005621 had fixed it and c4261d89 had been resolved.
       So: MEASURE IT AGAIN before filing anything. */
    SELECT * INTO m FROM public.fn_ca_remeasure_entity(r.entity_type, r.entity_id);

    IF m.measurable AND m.severity IS DISTINCT FROM 'critical' THEN
      -- The stored row is stale and the condition is gone. Do not file.
      v_super := v_super + 1;
      RAISE NOTICE
        'escalator: % % superseded - stored row of % said critical, re-measure says % (ledger %, stored %)',
        r.entity_type, r.entity_id, r.created_at, m.severity, m.ledger_balance, m.stored_balance;
      CONTINUE;
    END IF;

    IF m.measurable THEN
      -- Still critical. File on the FRESH numbers, not the remembered ones.
      v_state := 'critical';
      v_exp   := m.ledger_balance;
      v_act   := m.stored_balance;
      v_drift := ABS(m.stored_balance - m.ledger_balance);
    ELSE
      -- COULD NOT TELL. File, because a stored critical that nobody can
      -- re-measure is not evidence of health - but say on the incident that
      -- it rests on history, so a reader is not misled into thinking it was
      -- confirmed.
      v_unmeas := v_unmeas + 1;
      v_state  := 'unavailable';
      v_exp    := r.ledger_balance;
      v_act    := r.stored_balance;
      v_drift  := COALESCE(r.drift, 0);
    END IF;

    -- Map onto the classifications the estate already routes on rather than
    -- inventing one; an unknown value silently becomes 'unknown' upstream.
    v_class := CASE r.entity_type
      WHEN 'club_treasury'       THEN 'treasury_error'
      WHEN 'frozen_wallets_pool' THEN 'unauthorized_adjustment'
      ELSE 'ledger_imbalance'
    END;

    v_id := public.fn_ca_raise_drift_incident(
      -- the same source the trigger files under, so one detector owns it
      'ledger_reconcile_log:' || COALESCE(r.metadata->>'source', r.entity_type),
      v_class,
      'critical',
      -- the same key fn_ca_reconcile_log_to_incident builds, so this folds
      -- onto the incident that already exists rather than twinning it
      'lrl:' || r.entity_type || ':' || COALESCE(r.entity_id::text, '-') || ':' ||
        COALESCE(r.metadata->>'exit_id', r.metadata->>'hand_history_id',
                 r.metadata->>'hand_id', r.metadata->>'escrow_id', ''),
      v_drift,
      v_exp,
      v_act,
      -- MUST be one of ledger/projection/cache/reporting/settlement/unknown.
      -- 'database' is not, and passing it is what made 901 calls vanish.
      'ledger',
      r.entity_type,
      r.entity_id,
      CASE WHEN r.entity_type = 'club_treasury' THEN r.entity_id END,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      CASE WHEN r.entity_type = 'rake_law'
        THEN 'The rake-law monitor reported a critical finding about recorded rake and the rake specification. This finding alone does not establish a stored-balance/journal disagreement.'
        ELSE 'reconcile_ledger_nightly reported a critical drift for this '
          || r.entity_type || ': the stored balance and the journal disagree.'
      END,
      false,
      COALESCE(r.metadata, '{}'::jsonb)
        || jsonb_build_object('run_date', r.run_date,
                              'escalated_by', 'fn_ca_escalate_reconcile_criticals',
                              'stored_row_at', r.created_at,
                              'remeasured', v_state,
                              'remeasured_at', now())
    );

    -- NULL means the incident was not filed. Today that is almost always
    -- fn_ca_is_midway_scope declining an entity outside the piloted union,
    -- which is deliberate; anything else now leaves a row in
    -- ca_incident_file_failures instead of disappearing.
    IF v_id IS NOT NULL THEN
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  considered   := v_seen;
  filed        := v_filed;
  superseded   := v_super;
  unmeasurable := v_unmeas;
  RETURN NEXT;
END;
$function$;

-- 4. THE OLD NAMES GO --------------------------------------------------------

DROP FUNCTION IF EXISTS public.fn_ca_reconcile_treasury_positions();
DROP FUNCTION IF EXISTS public.fn_ca_reconcile_remeasure(text, uuid);

REVOKE ALL ON FUNCTION public.fn_ca_treasury_positions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_treasury_positions() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_treasury_positions() TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_remeasure_entity(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_remeasure_entity(text, uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_remeasure_entity(text, uuid) TO service_role;

-- 5. ASSERT THE END STATE ----------------------------------------------------
DO $assert2$
DECLARE
  m         record;
  v_unknown record;
  v_left    integer;
  v_club    uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
BEGIN
  SELECT COUNT(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_reconcile_treasury_positions', 'fn_ca_reconcile_remeasure');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'the old names are still present (% found)', v_left;
  END IF;

  SELECT * INTO m FROM public.fn_ca_remeasure_entity('club_treasury', v_club);
  IF NOT m.measurable THEN
    RAISE EXCEPTION 'club_treasury must be re-measurable; got measurable=false';
  END IF;
  IF m.severity <> 'ok' OR (m.stored_balance - m.ledger_balance) <> 0 THEN
    RAISE EXCEPTION
      'Deep Stack Society was expected to read ok with drift 0.00; got severity=% ledger=% stored=% drift=%',
      m.severity, m.ledger_balance, m.stored_balance,
      (m.stored_balance - m.ledger_balance);
  END IF;

  SELECT * INTO v_unknown FROM public.fn_ca_remeasure_entity('rake_law', NULL);
  IF v_unknown.measurable OR v_unknown.severity IS NOT NULL THEN
    RAISE EXCEPTION
      'fn_ca_remeasure_entity answered for an entity type it cannot measure (measurable=%, severity=%)',
      v_unknown.measurable, v_unknown.severity;
  END IF;

  RAISE NOTICE 'renamed, old names gone, Deep Stack Society re-measures ok: ledger=% stored=%',
    m.ledger_balance, m.stored_balance;
END;
$assert2$;

COMMIT;
