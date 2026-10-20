-- 20261020010133_the_open_week_rake_basis_lands_or_says_so
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-20 01:01:33 UTC.
--
-- THE OPEN-WEEK RAKE BASIS LANDS, OR SAYS SO, ONCE (2026-10-20)
--
-- WHAT WAS WRONG (read-only on production, 2026-10-20 00:45-01:00 UTC)
--
-- union_rake_basis_snapshot for Midway Union (fade0000-...-0001), 2026-10-19
-- week, was last written at 22:35 UTC, through 15:43:12. Job 123
-- (union-integrity-sweep, fn_union_integrity_sweep_all) succeeded at 23:35
-- and 00:35 in about 155 s each and wrote no snapshot and no financial_alerts
-- row. The 2026-10-12 week had stopped the same way: its snapshot stayed at
-- 2026-10-15 17:19 until the week closed, with 56 two-hour windows saved
-- (the last ending 2026-10-16 21:00) under six different input stamps.
--
-- 1. SILENT. fn_union_rake_basis_windowed stops starting windows 120 s into
--    the statement and answers 'in_progress'. fn_union_rake_basis_refresh
--    turns that into success = true, skipped = true, reason
--    'windows_in_progress', and the sweep counted every skipped answer as
--    skipped: no snapshot, no alert. A refresh answering success = false
--    (accrual_cursor_unknown, accrual_not_yet_in_window) matched neither
--    branch and was dropped the same way. Only an error or the statement
--    timeout raised anything, and a repeated error added a new row every hour
--    (four open 'failed' rows for Midway on 2026-10-19).
--
-- 2. NEVER CATCHING UP. Each saved window's stamp carried
--    fn_accounting_clubs_scope_digest(): every club on the platform. A
--    release certification creates a club ('Crest Cert Template d2916e44',
--    union_id NULL, created 2026-10-20 00:34:16), so every saved window of
--    every union was stale at 00:35 and the week was proved again from Monday
--    07:00: 07-09 40.8 s, 09-11 10.2 s, 11-13 6.5 s, 13-15 6.0 s, 15-17
--    61.7 s, then the budget was spent. A window reads the clubs table in one
--    place only (a house source's club must be a union club of this union),
--    so a club anywhere else changes nothing the window proves.
--
-- 3. QUADRATIC WINDOWS. fn_accounting_union_earned_plan_window joins its
--    materialized CTEs by equality. For the newest windows ANALYZE has not
--    seen the rows, the planner estimates one row per CTE and picks nested
--    loops that rescan a CTE once per row of another. EXPLAIN ANALYZE of the
--    window's own statement, production, 15:00-17:00, warm: 104.9 s, of which
--    q5 (37,172 sources x 9,409 receipts) 78.9 s and q3 (9,409 receipts x
--    9,409 accrual groups) 25.1 s. Hash joins (enable_nestloop = off): 8.9 s;
--    with tour_keys reading only the window's recognitions instead of all
--    444,926: 3.0 s (07:00 4.2 s, 19:00 6.5 s). The 12k-hand backlog from the
--    15:43 owner move made that window the largest of the day; the stale
--    estimate is what makes size cost its square.
--
-- WHAT CHANGES (three functions; signatures, owners, grants, SECURITY
-- DEFINER and search_path unchanged)
--
-- A. fn_accounting_union_earned_plan_window gains SET enable_nestloop = off
--    and states, in tour_keys, the window its equality already implies
--    (r.recognized_at = rs.recognized_at with rs in [p_start, p_end)). Same
--    rows, same proofs, same value, ids and md5s: only the plan changes. The
--    weekly close (fn_accounting_union_earned_plan_advance) proves its windows
--    with this function, so it gets the same plans and the same results.
-- B. fn_union_rake_basis_windowed stamps a window with the digest of the
--    union's own row and every club whose union_id is the union (the text PR
--    #7090 proposed for the same cause on 2026-10-16), which covers every club
--    the window reads. A window saved under the platform digest is still
--    reused, and restamped, while that digest is unchanged (the same clubs
--    table implies the same union clubs), so installing this recomputes
--    nothing. Every call proves at least one window before the budget can stop
--    it, so an hour whose money controls spent the budget still makes progress.
-- C. fn_union_integrity_sweep_all treats a refresh as LANDED when it wrote the
--    snapshot or found its inputs unchanged. Every other outcome holds exactly
--    one open warning per union and kind ('not_landed', 'out_of_time',
--    'failed'); a repeat updates that row's last_seen_at and repeats instead
--    of adding one, and a union the sweep could not reach after a timeout gets
--    its out_of_time warning too. A landed refresh resolves all three kinds
--    for its union (including the older 'failed' rows that carry no kind).
--
-- NOT CHANGED: no repair, backfill, sweep or new job (CLAUDE.md 10.12). The
-- strict plan, its six proofs, the conservation test and the weekly close are
-- untouched in what they accept or refuse. fn_union_rake_basis_refresh is not
-- changed.
--
-- QUALIFIED NATIVELY on PostgreSQL 17: scripts/qualification/union-rake-basis-lands.py
-- loads the accounting fixture and production's bodies (md5s below), runs
-- this file whole, and shows before -> after: the sweep silent -> one alert
-- (in_progress with the budget spent, and success = false); a timeout that
-- left the next union untold -> every union told once; a club outside
-- the union recomputing every window -> none; a 5,000-hand window read under
-- stale statistics by nested loop -> by hash, with identical output for every
-- window and identical tour_keys rows.
--
-- PINNED md5(pg_get_functiondef(oid)), live on 2026-10-20 -> after:
--   fn_accounting_union_earned_plan_window  102e5be492a144a705a2882d91675069 -> e51d7009c49519a43ffc23c223c2d7ef
--   fn_union_rake_basis_windowed            2c2bbb252ef5d119bc6e9813bcc9354b -> 4d70fdc60dd94d338d4437443716844f
--                                        or a68ecf97f457970970e97518d378e70c -> 4d70fdc60dd94d338d4437443716844f
--   fn_union_integrity_sweep_all            12861fc647dd2b033ecc875f7b5fa3f7 -> bda41da129572e2b09fadb10090d9dad
--
-- EITHER INSTALL ORDER WITH PR #7090 (20261016104931, held, not installed).
-- That migration changes only fn_union_rake_basis_windowed's digest, from the
-- same preimage 2c2bbb25 to a68ecf97. This one accepts either text and installs
-- the same postimage, whose digest is that migration's digest, so windows
-- saved under it are reused as they are. If this one installs first,
-- 20261016104931's own guard refuses (its preimage is gone) and it is
-- superseded: close #7090 rather than re-pinning it.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure)) = 'e51d7009c49519a43ffc23c223c2d7ef'
-- @live-proof: md5(pg_get_functiondef('public.fn_union_rake_basis_windowed(uuid,timestamptz,timestamptz)'::regprocedure)) = '4d70fdc60dd94d338d4437443716844f'
-- @live-proof: md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) = 'bda41da129572e2b09fadb10090d9dad'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'OPEN_WEEK_RAKE_BASIS_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $install$
DECLARE
  c_window constant text := $win$CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
 SET enable_indexscan TO 'off'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
 res record;
BEGIN
 -- ONE WINDOW OF THE EARNED PLAN (chunked close, 20261003): the set path
 -- below, derived from fn_accounting_union_earned_plan_sets, over one window
 -- p_start..p_end of a closed week. A passing window returns its raw sums, its
 -- club/game basis sums and every source's row md5 with its id, which
 -- fn_accounting_union_earned_plan_combine adds up into the week's plan.
 -- Anything else returns no row. The set path's own header follows.
 -- THE EARNED PLAN, READ AS SETS (20261003). The same six source proofs,
 -- the same conservation test and the same totals, fingerprint and basis as
 -- fn_accounting_union_earned_plan_v3, computed in one statement that reads
 -- each source row of the window once (v3 reads the week's sources four
 -- times and probes three tables per bank receipt). This function only ever
 -- CERTIFIES: it returns NULL whenever a proof finds anything, a value it
 -- reads cannot be cast, or anything else raises, and the caller then runs
 -- v3, which refuses exactly as it always refused. Where it is stricter than
 -- v3 (a rake record outside the cash-positive set, a NULL check result) it
 -- only sends the book to v3.
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN;
 END IF;
 -- THE WINDOW IS JOINED BY HASH, NEVER BY NESTED LOOP (20261020). The joins
 -- below are equality joins of materialized CTEs, and the newest windows are
 -- read before ANALYZE has seen their rows, so the planner estimates one row
 -- per CTE and rescans one CTE once per row of another: 9,409 bank receipts
 -- x 9,409 accrual groups and 37,172 sources x 9,409 receipts for Midway's
 -- 2026-10-19 15:00 window, 105 s warm for one two-hour window (measured
 -- read-only on production, 2026-10-20). enable_nestloop = off holds every
 -- join to hash or merge: the same rows, 3.0 s. The recognition join of
 -- tour_keys also states the window its equality already implies
 -- (rs.recognized_at = r.recognized_at, rs in [p_start, p_end)), so it reads
 -- the window's recognitions instead of all of them. Same result, row for row.
 BEGIN
  EXECUTE $q$
  WITH tw AS MATERIALIZED (
   SELECT t.id,t.created_at,t.amount FROM public.union_wallet_transactions t
    WHERE t.union_id=$1 AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
     AND t.created_at>=$2 AND t.created_at<$3
  ), cw AS MATERIALIZED (
   SELECT c.rake_record_id,c.union_transaction_id,c.banked_at,c.amount,c.club_ledger_id
    FROM public.accounting_cash_bank_receipts c WHERE c.union_id=$1 AND c.banked_at>=$2 AND c.banked_at<$3
  ), fw AS MATERIALIZED (
   SELECT f.tournament_id,f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.status,f.bank_journal_id
    FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=$1 AND f.recognized_at>=$2 AND f.recognized_at<$3
  ), tour_keys AS MATERIALIZED (
   -- The tournament branch of accounting_payable_earning_sources, keyed: its
   -- recognized sources of the window whose recognition is this union's.
   SELECT rs.source_id,rs.tournament_id,rs.recognized_at,rs.rake_credit
    FROM public.accounting_tournament_recognized_sources rs
    JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=rs.tournament_id
    WHERE rs.recognized_at>=$2 AND rs.recognized_at<$3 AND rs.disposition='earned'
     AND r.status='recognized' AND rs.recognized_at=r.recognized_at AND r.union_id=$1
     AND r.recognized_at>=$2 AND r.recognized_at<$3
  ), raw AS (
   SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.rake_record_id,NULL::uuid AS tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.contract,'cash'::text AS game_type,NULL::boolean AS terms_match
    FROM public.accounting_cash_rake_sources s WHERE s.union_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3
   UNION ALL
   SELECT 'tournament_fee_accrual'::text,s.id,s.rake_record_id,s.tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,k.recognized_at,s.rake_credit,s.contract,COALESCE(s.game_type,'cash'),
    (public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)=(s.contract->>'terms_at')::timestamptz)
    FROM public.accounting_tournament_fee_sources s
    JOIN tour_keys k ON k.source_id=s.id AND k.tournament_id=s.tournament_id AND k.rake_credit=s.rake_credit
    WHERE s.id=ANY(ARRAY(SELECT source_id FROM tour_keys)) AND s.union_id=$1
  ), detoasted AS (
   -- contract is stored compressed; || '{}' hands back the same object once
   -- decompressed, so the many reads below do not decompress it again.
   SELECT r.*,r.contract||'{}'::jsonb AS cj FROM raw r OFFSET 0
  ), sources AS (
   SELECT s.*,s.cj->'union_agreement' AS agreement,(s.cj->>'terms_at')::timestamptz AS terms_at,
    COALESCE((s.cj->>'is_union_house')::boolean,false) AS is_house
    FROM detoasted s OFFSET 0
  ), checked AS (
   SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,s.agreement->'terms' AS terms,
    COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
     WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
     WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
     s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
    FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
    OFFSET 0
  ), src AS MATERIALIZED (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.club_id,s.earned_at,s.rake_credit,s.game_type,s.rate,s.is_house,
    (s.cj->>'is_union_house')::boolean AS house_flag,
    md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.cj)::text) AS row_md5,
    (s.cj->>'club_id' IS DISTINCT FROM s.club_id::text OR s.cj->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.cj->>'union_id' IS DISTINCT FROM $1::text OR s.coordinator_union_id IS DISTINCT FROM $1
     OR (s.cj->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
     OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
     OR (s.source_type='tournament_fee_accrual' AND s.terms_match IS NOT TRUE)
     OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
       WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=$1 OR c.union_id=$1))))
     OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.terms
       OR s.terms->>'club_id' IS DISTINCT FROM s.club_id::text OR s.terms->>'union_id' IS DISTINCT FROM $1::text
       OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
       OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
        AND h.club_id=s.club_id AND h.entity_key=s.terms->>'id')
       OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
         WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
       OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')))) AS agreement_bad
    FROM checked s
  ), rw AS MATERIALIZED (
   SELECT r.id,r.rake_amount,r.created_at FROM public.rake_records r
    WHERE r.created_at>=$2 AND r.created_at<$3 AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
  ), bw AS MATERIALIZED (
   SELECT b.rake_record_id,b.status,b.earned_at FROM public.accounting_cash_accrual_batches b
    WHERE b.earned_at>=$2 AND b.earned_at<$3
  ), xw AS MATERIALIZED (
   SELECT s.rake_record_id,count(*) AS n,sum(s.rake_credit) AS total,min(s.earned_at) AS min_e,max(s.earned_at) AS max_e
    FROM src s WHERE s.source_type='cash_rake_accrual' GROUP BY s.rake_record_id
  ), counts AS (
   SELECT
    (SELECT count(*) FROM tw t LEFT JOIN cw c ON c.union_transaction_id=t.id LEFT JOIN fw f ON f.union_wallet_transaction_id=t.id
      WHERE (c.rake_record_id IS NULL)=(f.tournament_id IS NULL)
       OR (c.rake_record_id IS NOT NULL AND (c.amount IS DISTINCT FROM t.amount OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions f2 WHERE f2.union_wallet_transaction_id=t.id)))
       OR (f.tournament_id IS NOT NULL AND (f.net_rake IS DISTINCT FROM t.amount OR f.recognized_at IS DISTINCT FROM t.created_at
         OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts c2 WHERE c2.union_transaction_id=t.id)))
       OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity')) AS q1,
    (SELECT count(*) FROM (SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount FROM cw c
        UNION ALL SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake FROM fw f WHERE f.net_rake>0) s
      LEFT JOIN tw t ON t.id=s.bank_id AND t.created_at=s.earned_at AND t.amount IS NOT DISTINCT FROM s.amount
      WHERE t.id IS NULL) AS q2,
    (SELECT count(*) FROM cw c LEFT JOIN rw r ON r.id=c.rake_record_id LEFT JOIN bw b ON b.rake_record_id=c.rake_record_id
       LEFT JOIN xw x ON x.rake_record_id=c.rake_record_id
      WHERE r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
       OR b.rake_record_id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR b.earned_at IS DISTINCT FROM r.created_at
       OR x.n IS NULL OR x.total IS DISTINCT FROM c.amount OR x.min_e IS DISTINCT FROM c.banked_at OR x.max_e IS DISTINCT FROM c.banked_at
       OR (SELECT count(*) FROM public.accounting_cash_rake_sources s2 WHERE s2.rake_record_id=c.rake_record_id)<>x.n) AS q3,
    (SELECT count(*) FROM fw f LEFT JOIN (SELECT s.tournament_id,s.earned_at,count(*) AS n,sum(s.rake_credit) AS total FROM src s
        WHERE s.source_type='tournament_fee_accrual' GROUP BY s.tournament_id,s.earned_at) x
       ON x.tournament_id=f.tournament_id AND x.earned_at=f.recognized_at
      WHERE f.net_rake>0 AND (f.status IS DISTINCT FROM 'recognized' OR x.n IS NULL OR x.total IS DISTINCT FROM f.net_rake)) AS q4,
    (SELECT count(*) FROM src s
       LEFT JOIN cw c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
       LEFT JOIN fw f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
      WHERE (s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.banked_at IS DISTINCT FROM s.earned_at))
       OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.recognized_at IS DISTINCT FROM s.earned_at
         OR f.status IS DISTINCT FROM 'recognized'))
       OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS q5,
    (SELECT count(*) FROM src s WHERE s.agreement_bad IS NOT FALSE) AS q6
  ), basis AS (
   SELECT club_id,game_type,sum(rake_credit) AS rake_in,
    CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
    trunc(sum(rake_credit*rate),2) AS payout FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type
  )
  SELECT k.q1,k.q2,k.q3,k.q4,k.q5,k.q6,
   (SELECT sum(amount) FROM tw) AS bank_sum,
   (SELECT sum(rake_credit) FROM src) AS source_sum,
   (SELECT sum(rake_credit) FILTER(WHERE house_flag) FROM src) AS house_sum,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',p.club_id,'game_type',p.game_type,'rake_in',p.rake_in,'weighted',p.weighted) ORDER BY p.club_id,p.game_type),'[]')
     FROM (SELECT club_id,game_type,sum(rake_credit) AS rake_in,sum(rake_credit*rate) AS weighted FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type) p) AS basis_part,
   (SELECT count(*) FROM src WHERE source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS other_types,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_md5,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_md5
  FROM counts k
  $q$ INTO res USING p_union_id,p_start,p_end;
 EXCEPTION WHEN OTHERS THEN
  RETURN;
 END;
 -- The week's conservation test (sources = bank) is the combine's: a window
 -- may hold a bank row whose sources are in it and still differ in its sums.
 IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0 OR res.other_types<>0 THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT jsonb_build_object('bank_sum',res.bank_sum,'source_sum',res.source_sum,'house_sum',res.house_sum,'basis',res.basis_part),
  res.cash_ids,res.cash_md5,res.fee_ids,res.fee_md5;
END
$function$
$win$;
  c_windowed constant text := $wnd$CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_windowed(p_union_id uuid, p_start timestamp with time zone, p_through timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- THE OPEN-WEEK RAKE BASIS, TWO HOURS AT A TIME (20261003). The basis detail
-- of fn_accounting_union_earned_plan(p_union_id,p_start,p_through), combined
-- from proved two-hour windows exactly as fn_accounting_union_earned_plan_combine
-- combines a closed week's. NULL sends the caller to the one-read plan.
DECLARE began timestamptz:=statement_timestamp(); w record; r record; v jsonb; st jsonb; stamps jsonb;
 vals jsonb:='[]'::jsonb; n_win int:=0; n_reused int:=0; n_computed int:=0; t0 timestamptz; closed boolean;
 v_sref text; digest text; bank numeric; src numeric; detail jsonb; platform_digest text; current_stamp boolean;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_through IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_through)
  OR p_through<=p_start
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN NULL;
 END IF;
 -- A period with a final settlement is read from its witness, as before.
 v_sref := p_union_id::text || ':'
   || to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
   || to_char(p_through at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
 IF EXISTS (SELECT 1 FROM public.ca_settlements s
             WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
               AND s.state = 'final' AND s.external_ref = v_sref AND s.totals ? 'basis_detail') THEN
  RETURN NULL;
 END IF;
 -- THE STAMP NAMES THIS UNION'S CLUBS, NOT EVERY CLUB (20261020). A window
 -- reads the clubs table in one place: a house source is proved by a club
 -- that is a union club of this union (c.is_union AND (c.id = union OR
 -- c.union_id = union)). The stamp carried fn_accounting_clubs_scope_digest(),
 -- every club on the platform, so a certification club created by a release
 -- check (00:34:16 on 2026-10-20) or any club joining any other union made
 -- every saved window of every union stale and the week was proved again from
 -- Monday. By Monday evening that no longer fit an hour, so the snapshot
 -- stopped for good (2026-10-12 week: 56 windows saved, six digests, never
 -- finished). The digest is now the union's own row and every club whose
 -- union_id is the union (the same text as PR #7090, which found the same
 -- cause on 2026-10-16), so a club joining or leaving this union still
 -- restamps. A window saved under the platform digest is still proved while
 -- that digest is unchanged (the same clubs table implies the same union
 -- clubs), and is restamped as it is reused.
 digest:=(SELECT md5(COALESCE(string_agg(c.id::text||'|'||COALESCE(c.is_union::text,'null')||'|'||COALESCE(c.union_id::text,'null'),',' ORDER BY c.id),''))
            FROM public.clubs c WHERE c.union_id=p_union_id OR c.id=p_union_id);
 platform_digest:=public.fn_accounting_clubs_scope_digest();
 -- Every window's input stamp, one read per table.
 WITH win AS (SELECT * FROM public.fn_accounting_close_windows(p_start,p_through)),
 bank AS (SELECT date_bin('2 hours',t.created_at,p_start) AS ws,jsonb_build_array(count(*),sum(t.amount)) AS v
   FROM public.union_wallet_transactions t
  WHERE t.union_id=p_union_id AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
    AND t.created_at>=p_start AND t.created_at<p_through GROUP BY 1),
 rcpt AS (SELECT date_bin('2 hours',c.banked_at,p_start) AS ws,count(*) AS n FROM public.accounting_cash_bank_receipts c
  WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_through GROUP BY 1),
 recog AS (SELECT date_bin('2 hours',f.recognized_at,p_start) AS ws,count(*) AS n FROM public.accounting_tournament_fee_recognitions f
  WHERE f.union_id=p_union_id AND f.recognized_at>=p_start AND f.recognized_at<p_through GROUP BY 1),
 rsrc AS (SELECT date_bin('2 hours',rs.recognized_at,p_start) AS ws,count(*) AS n FROM public.accounting_tournament_recognized_sources rs
  WHERE rs.recognized_at>=p_start AND rs.recognized_at<p_through GROUP BY 1),
 bat AS (SELECT date_bin('2 hours',b.earned_at,p_start) AS ws,count(*) AS n FROM public.accounting_cash_accrual_batches b
  WHERE b.earned_at>=p_start AND b.earned_at<p_through GROUP BY 1)
 SELECT jsonb_object_agg(win.window_start::text,jsonb_build_object('end',win.window_end,
   'bank',COALESCE(bank.v,jsonb_build_array(0,NULL)),'receipts',COALESCE(rcpt.n,0),'recognitions',COALESCE(recog.n,0),
   'recognized',COALESCE(rsrc.n,0),'batches',COALESCE(bat.n,0),
   'agreements',(SELECT jsonb_build_array(count(*),max(h.id)) FROM public.accounting_agreement_history h WHERE h.observed_at<win.window_end),
   'clubs',digest))
  INTO stamps
  FROM win LEFT JOIN bank ON bank.ws=win.window_start LEFT JOIN rcpt ON rcpt.ws=win.window_start
   LEFT JOIN recog ON recog.ws=win.window_start LEFT JOIN rsrc ON rsrc.ws=win.window_start LEFT JOIN bat ON bat.ws=win.window_start;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_through) ORDER BY 1 LOOP
  n_win:=n_win+1;
  st:=stamps->(w.window_start::text);
  closed:=w.window_end=w.window_start+interval '2 hours';
  v:=NULL;
  IF closed THEN
   SELECT b.value,b.input_stamp=st INTO v,current_stamp FROM public.union_rake_basis_windows b
    WHERE b.union_id=p_union_id AND b.period_start=p_start AND b.window_start=w.window_start
      AND b.window_end=w.window_end
      AND (b.input_stamp=st OR b.input_stamp=st||jsonb_build_object('clubs',platform_digest));
   IF v IS NOT NULL AND NOT current_stamp THEN
    UPDATE public.union_rake_basis_windows b SET input_stamp=st
     WHERE b.union_id=p_union_id AND b.period_start=p_start AND b.window_start=w.window_start;
   END IF;
  END IF;
  IF v IS NOT NULL THEN
   n_reused:=n_reused+1;
  ELSE
   -- EVERY CALL PROVES AT LEAST ONE WINDOW (20261020). The budget is the
   -- statement's, and the sweep's money controls spend it first; a call
   -- that found it spent proved nothing, so an hour could pass with no
   -- progress at all. A call now proves one window before it can stop.
   IF n_computed>0 AND clock_timestamp()>began+(CASE WHEN closed THEN interval '120 seconds' ELSE interval '180 seconds' END) THEN
    RETURN jsonb_build_object('status','in_progress','windows',(SELECT count(*) FROM public.fn_accounting_close_windows(p_start,p_through)),
     'reused',n_reused,'computed',n_computed,'stopped_at',w.window_start);
   END IF;
   t0:=clock_timestamp();
   SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
   IF NOT FOUND THEN RETURN NULL; END IF;
   v:=r.value;
   n_computed:=n_computed+1;
   IF closed THEN
    INSERT INTO public.union_rake_basis_windows AS b(union_id,period_start,window_start,window_end,input_stamp,value,compute_ms,computed_at)
    VALUES(p_union_id,p_start,w.window_start,w.window_end,st,v,(extract(epoch FROM clock_timestamp()-t0)*1000)::int,clock_timestamp())
    ON CONFLICT(union_id,period_start,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,input_stamp=EXCLUDED.input_stamp,
     value=EXCLUDED.value,compute_ms=EXCLUDED.compute_ms,computed_at=EXCLUDED.computed_at;
   END IF;
  END IF;
  vals:=vals||jsonb_build_array(v);
 END LOOP;
 IF n_win=0 THEN RETURN NULL; END IF;
 -- fn_accounting_union_earned_plan_combine's own sums, test and basis.
 SELECT COALESCE(sum((x->>'bank_sum')::numeric),0),COALESCE(sum((x->>'source_sum')::numeric),0)
   INTO bank,src FROM jsonb_array_elements(vals) x;
 IF src IS DISTINCT FROM bank THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM (
  SELECT (e->>'club_id')::uuid AS club_id,e->>'game_type' AS game_type,sum((e->>'rake_in')::numeric) AS rake_in,
   CASE WHEN sum((e->>'rake_in')::numeric)>0 THEN sum((e->>'weighted')::numeric)/sum((e->>'rake_in')::numeric) ELSE 0 END AS rate,
   trunc(sum((e->>'weighted')::numeric),2) AS payout
   FROM jsonb_array_elements(vals) x CROSS JOIN LATERAL jsonb_array_elements(x->'basis') e
   GROUP BY (e->>'club_id')::uuid,e->>'game_type') b;
 RETURN jsonb_build_object('status','ready','basis_detail',detail,'windows',n_win,'reused',n_reused,'computed',n_computed);
END
$function$
$wnd$;
  c_sweep constant text := $swp$CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep_all(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  u record; v_one jsonb; v_signals int := 0; v_unions int := 0; v_failed int := 0;
  v_suspended int := 0; v_restored int := 0; v_sl jsonb;
  v_rb jsonb; v_rb_refreshed int := 0; v_rb_skipped int := 0; v_rb_failed int := 0;
  v_rb_out_of_time boolean := false;
  v_rb_not_landed int := 0; v_kind text; v_msg text; v_ctx jsonb; v_alert uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR u IN SELECT id FROM unions LOOP
    BEGIN
      v_one := public.fn_union_integrity_sweep(u.id, p_hours);
      v_signals := v_signals + COALESCE((v_one->>'signals')::int, 0);
      v_unions := v_unions + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;

    -- Age and chase what is past due, before enforcement reads it.
    BEGIN
      PERFORM public.fn_union_age_invoices(u.id);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_age_invoices', 'warning',
              'Ageing unpaid statements failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;

    -- Stop-loss enforcement rides the sweep rather than taking a schedule of
    -- its own (World Hub CLAUDE.md 11.3). It must never be able to stop the
    -- integrity sweep from finishing.
    BEGIN
      v_sl := public.fn_union_enforce_stop_loss(u.id);
      v_suspended := v_suspended + COALESCE((v_sl->>'suspended')::int, 0);
      v_restored  := v_restored  + COALESCE((v_sl->>'restored')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_enforce_stop_loss', 'warning',
              'Stop-loss enforcement failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;
  END LOOP;

  -- Expire locks whose time has passed. expire_settlement_locks() has
  -- existed since long before this and was called by nothing at all.
  BEGIN
    PERFORM public.expire_settlement_locks();
    PERFORM public.fn_settlement_lock_hygiene();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_settlement_lock_hygiene', 'warning',
            'Settlement lock hygiene failed',
            jsonb_build_object('error', SQLERRM));
  END;

  -- Close what is due. Never allowed to stop the sweep finishing.
  BEGIN
    PERFORM public.fn_close_due_settlement_periods();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_close_due_settlement_periods', 'warning',
            'Closing due settlement periods failed',
            jsonb_build_object('error', SQLERRM));
  END;

  -- THE OPEN-WEEK SNAPSHOT RUNS LAST (2026-09-26). It is a reporting read of
  -- the certified plan, linear in the week the settler has reached, and
  -- nothing above reads it. It runs after every money control so that its
  -- cost can never roll them back: a statement timeout (query_canceled, which
  -- WHEN OTHERS does not match) is trapped here, rolls back only this
  -- refresh, and ends the refreshing for this hour because the timer is spent.
  -- EVERY REFRESH LANDS OR SAYS SO, ONCE (20261020). An outcome is LANDED
  -- when the snapshot now holds what a refresh would write: a refresh that
  -- wrote it, or one that found its inputs unchanged. Every other outcome
  -- holds exactly one open warning per union and kind: 'not_landed' (the
  -- refresh answered without writing: windows still in progress, the accrual
  -- cursor unknown or not yet in the week, anything else it may answer),
  -- 'out_of_time' (the statement timeout, and every union the sweep could
  -- then not reach), 'failed' (an error). From 2026-10-19 22:35 the refresh
  -- answered 'windows_in_progress' every hour, which was counted as skipped
  -- and raised nothing, so the snapshot stopped at 15:43 and nobody was told;
  -- a refused accrual horizon (success false) went unseen the same way. A
  -- repeat updates the open warning's last_seen_at and repeats instead of
  -- adding a row, and a landed refresh closes all three kinds for its union.
  FOR u IN SELECT id FROM unions ORDER BY id LOOP
    v_kind := NULL; v_rb := NULL;
    IF v_rb_out_of_time THEN
      v_kind := 'out_of_time';
      v_msg := 'Refreshing the open-week rake basis snapshot ran out of the sweep''s time; the money controls committed and the snapshot keeps its previous refresh';
      v_ctx := jsonb_build_object('not_attempted', true, 'error', 'an earlier union used the sweep''s time');
    ELSE
    BEGIN
      v_rb := public.fn_union_rake_basis_refresh(u.id, public.fn_union_week_start(now()),
                                                 public.fn_union_week_start(now()) + interval '7 days');
      IF COALESCE((v_rb->>'success')::boolean, false)
         AND (NOT COALESCE((v_rb->>'skipped')::boolean, false) OR v_rb->>'reason' = 'inputs_unchanged') THEN
        IF COALESCE((v_rb->>'skipped')::boolean, false) THEN
          v_rb_skipped := v_rb_skipped + 1;
        ELSE
          v_rb_refreshed := v_rb_refreshed + 1;
        END IF;
        -- A REFRESH THAT LANDED ENDS ITS WARNINGS (2026-10-17, every kind
        -- since 20261020). The snapshot holds the refresh, so none is current.
        UPDATE financial_alerts a
           SET resolved = true, resolved_at = now(),
               resolution = 'Cleared by fn_union_integrity_sweep_all at ' || now()::text
                 || ': the open-week rake basis snapshot refreshed again (through '
                 || COALESCE(v_rb->>'through', 'unknown') || ').'
         WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
           AND COALESCE(a.context->>'kind', 'failed') IN ('out_of_time', 'not_landed', 'failed')
           AND a.context->>'union_id' = u.id::text;
      ELSE
        v_rb_not_landed := v_rb_not_landed + 1;
        v_kind := 'not_landed';
        v_msg := 'The open-week rake basis snapshot did not refresh this hour and keeps its previous refresh';
        v_ctx := jsonb_build_object('reason', COALESCE(v_rb->>'reason', v_rb->>'error', 'no_result'), 'result', v_rb);
      END IF;
    EXCEPTION
      WHEN query_canceled THEN
        v_rb_out_of_time := true;
        v_kind := 'out_of_time';
        v_msg := 'Refreshing the open-week rake basis snapshot ran out of the sweep''s time; the money controls committed and the snapshot keeps its previous refresh';
        v_ctx := jsonb_build_object('error', SQLERRM, 'not_attempted', false);
      WHEN OTHERS THEN
        v_rb_failed := v_rb_failed + 1;
        v_kind := 'failed';
        v_msg := 'Refreshing the open-week rake basis snapshot failed for a union';
        v_ctx := jsonb_build_object('error', SQLERRM);
    END;
    END IF;
    IF v_kind IS NOT NULL THEN
      SELECT a.id INTO v_alert FROM financial_alerts a
       WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
         AND COALESCE(a.context->>'kind', 'failed') = v_kind
         AND a.context->>'union_id' = u.id::text
       ORDER BY a.created_at DESC, a.id LIMIT 1;
      IF v_alert IS NULL THEN
        INSERT INTO financial_alerts (source, severity, message, context)
        VALUES ('fn_union_rake_basis_refresh', 'warning', v_msg,
                v_ctx || jsonb_build_object('kind', v_kind, 'union_id', u.id, 'last_seen_at', now(), 'repeats', 0));
      ELSE
        UPDATE financial_alerts a
           SET context = a.context || v_ctx || jsonb_build_object('kind', v_kind, 'last_seen_at', now(),
                 'repeats', COALESCE((a.context->>'repeats')::int, 0) + 1)
         WHERE a.id = v_alert;
      END IF;
      v_alert := NULL;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('unions_swept', v_unions, 'unions_failed', v_failed,
                            'signals', v_signals,
                            'clubs_suspended', v_suspended, 'clubs_restored', v_restored,
                            'rake_basis', jsonb_build_object('refreshed', v_rb_refreshed,
                                                             'skipped', v_rb_skipped,
                                                             'failed', v_rb_failed,
                                                             'not_landed', v_rb_not_landed,
                                                             'out_of_time', v_rb_out_of_time),
                            'window_hours', p_hours, 'ran_at', now());
END $function$
$swp$;
  t record;
  v_oid oid; v_def text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'open-week rake basis: must install as postgres, not %', current_user;
  END IF;
  FOR t IN SELECT * FROM (VALUES
      ('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)',
       ARRAY['102e5be492a144a705a2882d91675069'], 'e51d7009c49519a43ffc23c223c2d7ef', c_window,
       ARRAY['search_path=public','enable_indexscan=off','enable_nestloop=off']),
      ('public.fn_union_rake_basis_windowed(uuid,timestamptz,timestamptz)',
       ARRAY['2c2bbb252ef5d119bc6e9813bcc9354b', 'a68ecf97f457970970e97518d378e70c'], '4d70fdc60dd94d338d4437443716844f', c_windowed, ARRAY['search_path=public']),
      ('public.fn_union_integrity_sweep_all(integer)',
       ARRAY['12861fc647dd2b033ecc875f7b5fa3f7'], 'bda41da129572e2b09fadb10090d9dad', c_sweep, ARRAY['search_path=public'])
    ) x(sig, pre, post, body, config) LOOP
    v_oid := to_regprocedure(t.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'open-week rake basis: % does not exist', t.sig;
    END IF;
    IF md5(t.body) <> t.post THEN
      RAISE EXCEPTION 'open-week rake basis: the text for % is not its pinned postimage (md5 %)', t.sig, md5(t.body);
    END IF;
    v_def := pg_get_functiondef(v_oid);
    CONTINUE WHEN md5(v_def) = t.post;
    IF NOT md5(v_def) = ANY (t.pre) THEN
      RAISE EXCEPTION 'open-week rake basis: % is not the pinned preimage (md5 %)', t.sig, md5(v_def);
    END IF;
    SELECT p.proowner, p.prosecdef, p.proacl::text INTO v_owner, v_secdef, v_acl
      FROM pg_proc p WHERE p.oid = v_oid;
    EXECUTE t.body;
    SELECT p.proconfig INTO v_config FROM pg_proc p WHERE p.oid = v_oid;
    IF pg_get_functiondef(v_oid) IS DISTINCT FROM t.body THEN
      RAISE EXCEPTION 'open-week rake basis: exact readback of % failed', t.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                     AND p.proowner = v_owner AND p.prosecdef = v_secdef
                     AND p.proacl::text IS NOT DISTINCT FROM v_acl)
       OR v_config IS DISTINCT FROM t.config THEN
      RAISE EXCEPTION 'open-week rake basis: owner, grants or settings of % moved', t.sig;
    END IF;
  END LOOP;
END
$install$;

COMMIT;
