-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_cashier_conservation_report(uuid)'::regprocedure))='617a6a58c41f8a1f204e3438d6ea2a4c')
-- New clubs have no legacy player snapshot. Their zero-born wallets are
-- reconciled against every booked leg from club creation, without inventing
-- or persisting a historical baseline. Legacy unknowns remain incomplete.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_cashier_conservation_report(uuid)'::regprocedure))<>'8b13c8eee26460f44bbf977136635c5d' THEN RAISE EXCEPTION 'new_club_conservation_preimage_changed';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_report jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE='42501';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'Club Required' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND status='deleted')
    OR NOT public.fn_cashier_member_is_active(p_club_id,auth.uid())
    OR coalesce(public.fn_club_bank_role(p_club_id,auth.uid()),'')
      NOT IN ('owner','co_owner','admin') THEN
    RAISE EXCEPTION 'Active Club Finance Access Required' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND asset='chips') THEN
    RAISE EXCEPTION 'Accounting Report Covers Chip Clubs Only' USING ERRCODE='22023';
  END IF;

  -- chip_ledger records booked movement, including correction/reversal legs.
  -- Its validated NOT NULL status contract admits only posted/correction/reversal.
  -- Read every leg; filtering only posted would omit real money and force heap
  -- reads instead of the existing covering player-wallet index.
  --
  -- The bank is read by its own entity: every leg into or out of this club's
  -- treasury, whatever club_id it is filed under. A bank leg's club_id names
  -- the wallet club of the other side (a commission this bank pays into the
  -- payee's wallet in another club is filed under that club), so it never
  -- selects bank movement. These are the legs fn_ca_treasury_positions and
  -- the nightly reconcile read, from idx_chip_ledger_treasury_in/_out.
  WITH club_origin AS MATERIALIZED (
    -- A club born after the original journal baseline has no pre-existing
    -- member wallets. Reconcile those wallets from zero against every leg
    -- since its creation; an unjournaled initial balance remains a mismatch.
    SELECT c.created_at AS taken_at FROM public.clubs c
    WHERE c.id=p_club_id AND c.created_at>=(SELECT min(b.taken_at) FROM public.ca_chip_baseline b)
      AND NOT EXISTS(SELECT 1 FROM public.ca_chip_baseline b WHERE b.club_id=p_club_id)
  ), report_cutoffs AS MATERIALIZED (
    SELECT DISTINCT taken_at FROM public.ca_chip_baseline WHERE club_id=p_club_id
    UNION ALL SELECT taken_at FROM club_origin
  ), bank AS MATERIALIZED (
    SELECT c.chip_treasury AS actual,b.opening_balance,b.taken_at,
      b.opening_balance
        + coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.to_type='club_treasury'
            AND l.to_entity_id=p_club_id AND l.created_at>=b.taken_at
           ),0)
        - coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.from_type='club_treasury'
            AND l.from_entity_id=p_club_id AND l.created_at>=b.taken_at
           ),0) AS expected
    FROM public.clubs c LEFT JOIN public.ca_treasury_baseline b ON b.club_id=c.id
    WHERE c.id=p_club_id
  ), baselines AS MATERIALIZED (
    SELECT user_id,opening_balance,taken_at FROM public.ca_chip_baseline WHERE club_id=p_club_id
    UNION ALL
    -- A member who joined after the club baseline was taken entered with no
    -- chips: every chip they have held since is a booked ledger leg. They are
    -- checked from zero at the club's existing cutoff, so no new scan is added.
    -- A balance written without a leg still surfaces as a mismatch.
    SELECT m.user_id,0::numeric,f.taken_at
    FROM public.club_members m
    CROSS JOIN (SELECT min(taken_at) AS taken_at FROM report_cutoffs) f
    WHERE m.club_id=p_club_id AND f.taken_at IS NOT NULL AND m.joined_at>=f.taken_at
      AND NOT EXISTS (SELECT 1 FROM public.ca_chip_baseline x
        WHERE x.club_id=p_club_id AND x.user_id=m.user_id)
  ), cutoffs AS MATERIALIZED (
    -- Late-member baselines reuse min(original taken_at), so they cannot add
    -- a cutoff. Read the same set from its analyzed table: the UNION-derived
    -- materialization otherwise estimates 200 cutoffs and batches a huge hash.
    SELECT taken_at FROM report_cutoffs
  ), spans AS MATERIALIZED (
    -- Each cutoff reads its own UTC day raw from the cutoff, then the run of
    -- consecutive SEALED days after it, then everything from the first day
    -- that is not sealed, raw. A seal counts only while it carries its day's
    -- current manifest hash: a restated or newly attested day is read raw
    -- again until it is sealed again. The three parts are disjoint and cover
    -- [cutoff, now) exactly, so the result is the full-journal result. A NULL
    -- cutoff yields NULL bounds and reads nothing, exactly as before.
    SELECT c.taken_at, f.first_day,
      coalesce((
        SELECT min(g.d)::date
        FROM generate_series(f.first_day::timestamp,
          (statement_timestamp() AT TIME ZONE 'UTC')::date::timestamp + interval '1 day',
          interval '1 day') g(d)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.ca_chip_wallet_day_seals s
          LEFT JOIN public.ca_ledger_day_manifests m ON m.day=s.day
          WHERE s.day=g.d::date AND s.manifest_sha256 IS NOT DISTINCT FROM m.sha256)
      ), f.first_day) AS open_from
    FROM cutoffs c
    CROSS JOIN LATERAL (SELECT (c.taken_at AT TIME ZONE 'UTC')::date + 1 AS first_day) f
  ), ranges AS MATERIALIZED (
    SELECT taken_at, taken_at AS lo, (first_day::timestamp AT TIME ZONE 'UTC') AS hi FROM spans
    UNION ALL
    SELECT taken_at, (open_from::timestamp AT TIME ZONE 'UTC'), 'infinity'::timestamptz FROM spans
  ), legs AS MATERIALIZED (
    -- The raw parts are bounded index ranges over the club's covering
    -- player-wallet legs. Both wallet sides are grouped from one scan per
    -- range with grouping sets; a leg whose side is not a player wallet
    -- collapses into one NULL key. Sealed days add their stored per-member
    -- nets. Each position still uses its own baseline cutoff in the join below.
    SELECT r.taken_at, g.uid, g.amt
    FROM ranges r
    CROSS JOIN LATERAL (
      SELECT coalesce(x.credit_user,x.debit_user) AS uid,
        CASE WHEN GROUPING(x.credit_user)=0 THEN sum(x.a) ELSE -sum(x.a) END AS amt
      FROM (
        SELECT CASE WHEN l.to_type='player_wallet' THEN l.to_entity_id END AS credit_user,
          CASE WHEN l.from_type='player_wallet' THEN l.from_entity_id END AS debit_user,
          l.amount AS a
        FROM public.chip_ledger l
        WHERE l.club_id=p_club_id AND l.created_at>=r.lo AND l.created_at<r.hi
          AND (l.to_type='player_wallet' OR l.from_type='player_wallet')
      ) x
      GROUP BY GROUPING SETS ((x.credit_user),(x.debit_user))
    ) g
    UNION ALL
    -- One row per member per cutoff, however many days are sealed.
    SELECT s.taken_at, t.user_id, sum(t.net)
    FROM spans s
    JOIN public.ca_chip_wallet_day_totals t
      ON t.club_id=p_club_id AND t.day>=s.first_day AND t.day<s.open_from
    GROUP BY s.taken_at, t.user_id
  ), moves AS MATERIALIZED (
    SELECT b.user_id, sum(g.amt) AS net
    FROM baselines b
    JOIN legs g ON g.taken_at=b.taken_at AND g.uid=b.user_id
    GROUP BY b.user_id
  ), positions AS MATERIALIZED (
    SELECT coalesce(m.user_id,b.user_id) AS user_id,m.chip_balance AS actual,
      b.opening_balance,b.taken_at,b.opening_balance+coalesce(mv.net,0) AS expected
    FROM (SELECT user_id,chip_balance FROM public.club_members WHERE club_id=p_club_id) m
    FULL JOIN baselines b USING(user_id)
    LEFT JOIN moves mv ON mv.user_id=b.user_id
  ), classified AS (
    SELECT *,actual IS NOT NULL AND opening_balance IS NOT NULL
      AND taken_at IS NOT NULL AND taken_at<=statement_timestamp() AS covered
    FROM positions
  ), totals AS (
    SELECT count(*) AS positions,count(*) FILTER(WHERE covered) AS checked,
      count(*) FILTER(WHERE NOT covered) AS missing,
      count(*) FILTER(WHERE covered AND actual<>expected) AS mismatches,
      coalesce(sum(abs(actual-expected)) FILTER(WHERE covered),0) AS absolute_drift,
      coalesce(sum(actual-expected) FILTER(WHERE covered),0) AS net_drift,
      sum(actual) FILTER(WHERE covered) AS actual,sum(expected) FILTER(WHERE covered) AS expected
    FROM classified
  )
  SELECT jsonb_build_object(
    'schema_version',1,'club_id',p_club_id,'as_of',statement_timestamp(),
    'scope','bank_and_player_baselines',
    'bank',jsonb_build_object(
      'status',CASE WHEN b.actual IS NULL OR b.opening_balance IS NULL OR b.taken_at IS NULL
        OR b.taken_at>statement_timestamp() THEN 'incomplete'
        WHEN b.actual<>b.expected THEN 'attention' ELSE 'verified' END,
      'actual',b.actual::text,'expected',b.expected::text,
      'drift',CASE WHEN b.taken_at<=statement_timestamp() THEN (b.actual-b.expected)::text END,
      'baseline_at',b.taken_at),
    'players',jsonb_build_object(
      'status',CASE WHEN t.mismatches>0 THEN 'attention'
        WHEN t.missing>0 OR t.checked=0 THEN 'incomplete' ELSE 'verified' END,
      'positions',t.positions,'checked',t.checked,'missing',t.missing,'mismatches',t.mismatches,
      'actual',t.actual::text,'expected',t.expected::text,
      'net_drift',t.net_drift::text,'absolute_drift',t.absolute_drift::text)
      || CASE WHEN EXISTS(SELECT 1 FROM club_origin) THEN jsonb_build_object(
        'basis','journal_from_club_creation','origin_at',(SELECT taken_at FROM club_origin)) ELSE '{}'::jsonb END,
    'inventory',jsonb_build_object(
      'agent_wallets',(SELECT CASE WHEN count(*) FILTER(WHERE agent_wallet_balance IS NULL)>0
        THEN NULL ELSE coalesce(sum(agent_wallet_balance),0)::text END FROM public.agents WHERE club_id=p_club_id),
      'promo_wallets',(SELECT CASE WHEN count(*) FILTER(WHERE promo_wallet_balance IS NULL)>0
        THEN NULL ELSE coalesce(sum(promo_wallet_balance),0)::text END FROM public.agents WHERE club_id=p_club_id),
      'held_chips',(SELECT CASE WHEN count(*) FILTER(WHERE held_chips IS NULL)>0
        THEN NULL ELSE coalesce(sum(held_chips),0)::text END FROM public.club_members WHERE club_id=p_club_id),
      'cash_stacks',(SELECT CASE WHEN count(*) FILTER(WHERE s.stack IS NULL)>0
        THEN NULL ELSE coalesce(sum(s.stack),0)::text END FROM public.table_seats s
        JOIN public.tables t ON t.id=s.table_id WHERE t.club_id=p_club_id
          AND t.tournament_id IS NULL AND s.left_at IS NULL)
    )
  ) INTO v_report FROM bank b CROSS JOIN totals t;
  IF v_report IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE='22023';
  END IF;
  RETURN v_report;
END;
$function$;
COMMIT;
