CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_sets(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
 SET enable_indexscan TO 'off'
AS $function$
DECLARE
 res record;
BEGIN
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
  RETURN NULL;
 END IF;
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
  ), raw AS (
   SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.rake_record_id,NULL::uuid AS tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.contract,'cash'::text AS game_type,NULL::boolean AS terms_match
    FROM public.accounting_effective_cash_rake_sources s WHERE s.union_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3
   UNION ALL
   SELECT 'tournament_fee_accrual'::text,s.id,s.rake_record_id,s.tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,k.recognized_at,s.rake_credit,s.contract,COALESCE(s.game_type,'cash'),
    (public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)=(s.contract->>'terms_at')::timestamptz)
    FROM public.accounting_effective_tournament_fee_sources s
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
       OR (SELECT count(*) FROM public.accounting_effective_cash_rake_sources s2 WHERE s2.rake_record_id=c.rake_record_id)<>x.n) AS q3,
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
   (SELECT COALESCE(sum(amount),0) FROM tw) AS bank_total,
   (SELECT COALESCE(sum(rake_credit),0) FROM src) AS source_total,
   (SELECT COALESCE(sum(rake_credit) FILTER(WHERE house_flag),0) FROM src) AS house_total,
   (SELECT md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),'')) FROM src) AS fingerprint,
   (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') FROM basis b) AS detail
  FROM counts k
  $q$ INTO res USING p_union_id,p_start,p_end;
 EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
 END;
 IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0
  OR res.bank_total IS NULL OR res.source_total IS DISTINCT FROM res.bank_total THEN
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',res.bank_total,'earned_rake',res.source_total,'house_rake',res.house_total,'source_fingerprint',res.fingerprint,'basis_detail',res.detail);
END
$function$
