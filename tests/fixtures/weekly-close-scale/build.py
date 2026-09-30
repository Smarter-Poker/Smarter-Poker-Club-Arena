#!/usr/bin/env python3
"""Builds the weekly-close-scale function bodies from the captured production
preimages (preimage/*.sql, pg_get_functiondef text read 2026-09-28) by exact,
counted text substitutions. Every needle must occur exactly once, so a changed
preimage fails the build instead of producing a silently different body.
Writes new/<function>.sql. The migration embeds these files verbatim."""
from pathlib import Path
import hashlib, sys
here = Path(__file__).resolve().parent
pre = here / 'preimage'
out = here / 'new'
out.mkdir(exist_ok=True)

def sub(text, needle, repl, name):
    n = text.count(needle)
    if n != 1:
        sys.exit(f'{name}: needle occurs {n} times: {needle[:90]!r}')
    return text.replace(needle, repl)

def load(name):
    return (pre / f'{name}.sql').read_text()

def save(name, text):
    (out / f'{name}.sql').write_text(text)

def renamed(name, new_name):
    t = load(name)
    t = sub(t, f'CREATE OR REPLACE FUNCTION public.{name}(', f'CREATE OR REPLACE FUNCTION public.{new_name}(', name)
    return t

# ---------------------------------------------------------------- round 2
N = 'fn_settle_accounting_commission_stage'
t = load(N)
REF2 = 'public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end)'
t = sub(t, "member_skip text;routing_context text;\nBEGIN", "member_skip text;routing_context text;v4_ok boolean:=true;\nBEGIN", N)
t = sub(t, """ CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_type text,source_id uuid,club_id uuid,contract jsonb,earned_at timestamptz,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 INSERT INTO pg_temp._routed_sources SELECT source_type,source_id,club_id,contract,earned_at FROM public.accounting_payable_earning_sources
  WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 SELECT count(*),md5(COALESCE(string_agg(md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text),'' ORDER BY source_type,source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
""", f""" PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 -- WEEKLY CLOSE SCALE (20260928): one read of the week's sources keeps only
 -- what this stage uses (tiers, the contract's club and each row's own md5),
 -- instead of copying every full contract into a temp table. The fingerprint
 -- is the same md5 over the same per-row md5s in the same order. Anything
 -- this path cannot read exactly as the original did is answered by the
 -- original, byte-for-byte, as {REF2.split('(')[0]}.
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _routed_sources_v4(source_type text,source_id uuid,club_id uuid,earned_at timestamptz,tiers jsonb,tiers_type text,contract_club text,row_md5 text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
  TRUNCATE pg_temp._routed_sources_v4;
  INSERT INTO pg_temp._routed_sources_v4 SELECT source_type,source_id,club_id,earned_at,contract->'tiers',jsonb_typeof(contract->'tiers'),contract->>'club_id',
   md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text)
   FROM public.accounting_payable_earning_sources
   WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN {REF2}; END IF;
 SELECT count(*),md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources_v4;
""", N)
t = sub(t, """ IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN""", """ -- Any source matching (type,id,club,earned_at=created_at) of a commission row
 -- of these clubs created this week is itself one of these clubs' sources
 -- earned this week, so one hashed read of that slice answers every row. The
 -- tests are counted, not EXISTS: an EXISTS is planned for its first row and
 -- a clean book has none, so it would be a nested loop over the whole week.
 IF (WITH club_week AS MATERIALIZED (
   SELECT rs.source_type,rs.source_id,rs.club_id,rs.earned_at FROM public.accounting_payable_earning_sources rs
    WHERE rs.club_id=ANY(scope.club_ids) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
  SELECT count(*) FROM public.agent_commissions ac
   LEFT JOIN club_week rs ON rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at
  WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR rs.source_id IS NULL))>0
 THEN""", N)
t = sub(t, """ FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_type,source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_type,v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
""", f""" -- One set insert of every tier. A contract the original loop would refuse,
 -- or a tier value it would fail to read, is answered by the original.
 IF EXISTS(SELECT 1 FROM pg_temp._routed_sources_v4 s WHERE s.tiers_type IS DISTINCT FROM 'array' OR s.contract_club IS DISTINCT FROM s.club_id::text) THEN
  RETURN {REF2};
 END IF;
 BEGIN
  INSERT INTO pg_temp._routed_tiers SELECT s.source_type,s.source_id,s.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM pg_temp._routed_sources_v4 s CROSS JOIN LATERAL jsonb_array_elements(s.tiers) WITH ORDINALITY x(j,ord);
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN {REF2}; END IF;
 ANALYZE pg_temp._routed_tiers;
""", N)
t = sub(t, """ IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_type=ac.source_type AND s.source_id=ac.source_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=s.source_type AND t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
 THEN""", """ -- Every commission row of every source, read once by its (source_id,
 -- source_type) index in source order, whatever its club or time; the three
 -- original tests are then answered from that set.
 CREATE TEMP TABLE IF NOT EXISTS _routed_ac_v4(source_type text,source_id uuid,club_id uuid,user_id uuid,amount numeric,commission_rate numeric,settled_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_ac_v4;
 INSERT INTO pg_temp._routed_ac_v4 SELECT a.* FROM (SELECT s.source_type,s.source_id FROM pg_temp._routed_sources_v4 s ORDER BY s.source_id,s.source_type) s
  CROSS JOIN LATERAL (SELECT ac.source_type,ac.source_id,ac.club_id,ac.user_id,ac.amount,ac.commission_rate,ac.settled_at FROM public.agent_commissions ac
   WHERE ac.source_id=s.source_id AND ac.source_type=s.source_type OFFSET 0) a;
 ANALYZE pg_temp._routed_ac_v4;
 IF (SELECT count(*) FROM pg_temp._routed_tiers t WHERE t.own_amount>0 AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_ac_v4 ac
    WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
     AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL))>0
  OR (SELECT count(*) FROM pg_temp._routed_tiers t LEFT JOIN (SELECT ac.source_type,ac.source_id,ac.user_id,count(*) AS n FROM pg_temp._routed_ac_v4 ac GROUP BY 1,2,3) c
    ON c.source_type=t.source_type AND c.source_id=t.source_id AND c.user_id=t.user_id
   WHERE COALESCE(c.n,0)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)>0
  OR (SELECT count(*) FROM pg_temp._routed_ac_v4 ac
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=ac.source_type AND t.source_id=ac.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))>0
 THEN""", N)
t = sub(t, """ INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth))>0;
""", """ -- The same per-tier running sum (depth is unique within a source).
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum(t.upto),min(t.role)
 FROM (SELECT t.*,sum(t.own_amount) OVER(PARTITION BY t.source_type,t.source_id ORDER BY t.depth ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS upto
  FROM pg_temp._routed_tiers t) t
 LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum(t.upto)>0;
""", N)
t = sub(t, "WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR UPDATE;",
        "WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources_v4) ORDER BY c.id FOR UPDATE;", N)
if '_routed_sources ' in t or '_routed_sources)' in t or '_routed_sources;' in t:
    sys.exit('round 2 still reads _routed_sources')
save(N, t)
save(N + '_v3', renamed(N, N + '_v3'))

# ---------------------------------------------------------------- round 3
N = 'fn_settle_accounting_rakeback_stage'
t = load(N)
t = sub(t, " club_skip text;member_skip text;maintenance text;routing_context text;\nBEGIN",
        " club_skip text;member_skip text;maintenance text;routing_context text;v4_ok boolean:=false;\nBEGIN", N)
start = t.index(" FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE")
end_ = t.index(" END LOOP;\n", start) + len(" END LOOP;\n")
old_loop = t[start:end_]
period_filter = old_loop[len(" FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE"):old_loop.index("  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE\n")]
cert_chain = old_loop[old_loop.index("  IF NOT FOUND OR ")+len("  IF NOT FOUND OR "):old_loop.index("  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required'")]
bad_start = old_loop.index("     WHERE COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL")
bad_chain = old_loop[bad_start+len("     WHERE "):old_loop.index("  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate'")]
assert bad_chain.rstrip().endswith(')')
bad_chain = bad_chain.rstrip()[:-1]  # drop the EXISTS( ... ) closing paren
bad_chain = sub(bad_chain, "NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid", "NULLIF(rs.agent_text,'')::uuid", N + ' bad chain')
fast = f""" -- WEEKLY CLOSE SCALE (20260928): the per-period proof, read as sets. The
 -- periods are locked in the original order; the latest certificate of each,
 -- every allocation of every certificate and this scope's sources of the week
 -- are each read once, and every original test is evaluated on them. Only a
 -- book that passes every test takes this path. Any refusal, and anything
 -- this path cannot read, runs the original per-period loop below, unchanged,
 -- which raises exactly what it always raised.
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rr3_periods_v4(ord bigint,LIKE public.rakeback_periods) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_periods_v4;
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (SELECT rp.* FROM public.rakeback_periods rp WHERE{period_filter}  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE) x;
  CREATE TEMP TABLE IF NOT EXISTS _rr3_certs_v4(period_id uuid PRIMARY KEY,id bigint,accounting_version integer,source_fingerprint text,club_id uuid,player_id uuid,
   coordinator_union_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_amount numeric,display_rate numeric,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_certs_v4;
  INSERT INTO pg_temp._rr3_certs_v4 SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.accounting_version,x.source_fingerprint,x.club_id,x.player_id,
   x.coordinator_union_id,x.period_start,x.period_end,x.rake_generated,x.rakeback_amount,x.display_rate,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rr3_periods_v4) ORDER BY x.period_id,x.id DESC;
  IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 r LEFT JOIN pg_temp._rr3_certs_v4 c ON c.period_id=r.id
    WHERE COALESCE(c.id IS NULL OR {cert_chain.strip()},false))=0 THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    rs.contract->'membership'->'terms'->>'agent_id'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
   ANALYZE pg_temp._rr3_week_v4;
   CREATE TEMP TABLE IF NOT EXISTS _rr3_alloc_v4(period_id uuid PRIMARY KEY,allocation_count bigint,matched_count bigint,generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_alloc_v4;
   -- A source of this allocation that is not in this scope's week slice is
   -- outside the scope or the week, which the original test refuses too.
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT c.period_id,count(*),
    count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),
    sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
    COALESCE(bool_or({bad_chain.strip()}),false)
    FROM pg_temp._rr3_certs_v4 c JOIN pg_temp._rr3_periods_v4 r ON r.id=c.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=c.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    LEFT JOIN pg_temp._rr3_week_v4 rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
    GROUP BY c.period_id;
   IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 r JOIN pg_temp._rr3_certs_v4 c ON c.period_id=r.id
     LEFT JOIN pg_temp._rr3_alloc_v4 g ON g.period_id=r.id
     LEFT JOIN (SELECT w.club_id,w.player_id,count(*) AS n FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id) w ON w.club_id=r.club_id AND w.player_id=r.user_id
     WHERE COALESCE((COALESCE(g.allocation_count,0)=0 OR COALESCE(g.allocation_count,0)<>COALESCE(g.matched_count,0) OR COALESCE(g.allocation_count,0)<>COALESCE(w.n,0)
       OR g.generated IS DISTINCT FROM c.rake_generated
       OR round(g.unrounded,2) IS DISTINCT FROM c.rakeback_amount
       OR c.display_rate IS DISTINCT FROM (CASE WHEN g.generated>0 THEN round(g.unrounded/g.generated,4) ELSE 0 END))
      OR COALESCE(g.any_bad,false),false))=0 THEN
    INSERT INTO pg_temp._routed_player_items SELECT r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status
     FROM pg_temp._rr3_periods_v4 r JOIN pg_temp._rr3_certs_v4 c ON c.period_id=r.id;
    v4_ok:=true;
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN
 TRUNCATE pg_temp._routed_player_items;
{old_loop} END IF;
"""
# The loop variables r, c and g are PL/pgSQL records; the set queries use
# their own aliases (pr, pc, ag) so no reference is ambiguous.
import re as _re
body, tail = fast.split(" IF NOT v4_ok THEN\n TRUNCATE pg_temp._routed_player_items;\n")
for tbl, a, b in [('_rr3_periods_v4', ' r ', ' pr '), ('_rr3_certs_v4', ' c ', ' pc '), ('_rr3_alloc_v4', ' g ', ' ag ')]:
    body = body.replace('pg_temp.' + tbl + a, 'pg_temp.' + tbl + b)
body = _re.sub(r'\br\.', 'pr.', body)
body = _re.sub(r'\bc\.', 'pc.', body)
body = _re.sub(r'\bg\.', 'ag.', body)
fast = body + " IF NOT v4_ok THEN\n TRUNCATE pg_temp._routed_player_items;\n" + tail
t = t[:start] + fast + t[end_:]
save(N, t)

# ---------------------------------------------------------------- summary
N = 'fn_club_weekly_accounting_summary'
t = load(N)
t = sub(t, " ready boolean;close_count int;\nBEGIN", " ready boolean;close_count int;bank_bad bigint;bank_burned numeric;bank_ids jsonb;\nBEGIN", N)
start = t.index(" FOR bank IN\n")
end_ = t.index(" END LOOP;\n", start) + len(" END LOOP;\n")
old = t[start:end_]
ledger_exists = old[old.index("NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=bank.ledger_id"):old.index("\n  THEN source_issues:=source_issues+1;")]
ledger_exists = ledger_exists.replace('bank.', 'j.')
new = f""" -- WEEKLY CLOSE SCALE (20260928): the same disposition proof as one read.
 -- The original looped over every private deposit and asked the earning
 -- sources twice per deposit; the second question's CASE made PL/pgSQL settle
 -- on a generic plan that scanned the club's whole source history each time
 -- (233 ms a deposit measured on production, 197,135 deposits for Deep Stack
 -- Society's week). Deposits are now found by index, each deposit's sources by
 -- its own key, and every original test is applied per deposit. The ledger
 -- ids are listed in deposit order (type, banked time, key).
 WITH deposits AS MATERIALIZED (
  SELECT 'cash_rake_accrual'::text AS source_type,b.rake_record_id AS source_group,b.club_ledger_id AS ledger_id,b.amount,b.banked_at,
   b.club_id,b.union_id,b.union_transaction_id,NULL::uuid AS tournament_id
  FROM public.accounting_cash_bank_receipts b WHERE b.union_id IS NULL AND b.rake_record_id IN(
   SELECT x.rake_record_id FROM public.accounting_cash_bank_receipts x
    WHERE x.union_id IS NULL AND x.club_id=period.club_id AND x.banked_at>=period.start_at AND x.banked_at<period.end_at
   UNION SELECT s.rake_record_id FROM public.accounting_cash_rake_sources s WHERE s.club_id=period.club_id AND s.union_id IS NULL
    AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id AND s.earned_at>=period.start_at AND s.earned_at<period.end_at)
  UNION ALL
  SELECT 'tournament_fee_accrual',f.tournament_id,f.bank_journal_id,f.net_rake,f.recognized_at,f.bank_club_id,f.union_id,f.union_wallet_transaction_id,f.tournament_id
  FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id IS NULL AND f.net_rake>0 AND f.tournament_id IN(
   SELECT y.tournament_id FROM public.accounting_tournament_fee_recognitions y
    WHERE y.bank_club_id=period.club_id AND y.recognized_at>=period.start_at AND y.recognized_at<period.end_at
   UNION SELECT s.tournament_id FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.club_id=period.club_id AND s.union_id IS NULL AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
    AND s.earned_at>=period.start_at AND s.earned_at<period.end_at)
 ), judged AS (
  SELECT b.*,cg.n+tg.n AS n,COALESCE(cg.total,0)+COALESCE(tg.total,0) AS total,cg.bad+tg.bad AS bad,
   COALESCE(cg.mine,false) OR COALESCE(tg.mine,false) AS mine
  FROM (SELECT * FROM deposits ORDER BY source_type,banked_at,source_group) b
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
   FROM public.accounting_cash_rake_sources s WHERE b.source_type='cash_rake_accrual' AND s.rake_record_id=b.source_group OFFSET 0) cg
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
   FROM public.accounting_payable_earning_sources s WHERE b.source_type='tournament_fee_accrual' AND s.source_type='tournament_fee_accrual'
    AND s.tournament_id=b.source_group OFFSET 0) tg
 ), verdict AS (
  SELECT j.source_type,j.source_group,j.banked_at,j.ledger_id,j.amount,(j.n>0 AND NOT j.mine) AS skipped,
   (j.n=0 OR j.bad>0 OR j.total IS DISTINCT FROM j.amount OR j.club_id IS DISTINCT FROM period.club_id
    OR j.union_transaction_id IS NOT NULL OR {ledger_exists}) AS issue
  FROM judged j
 )
 SELECT count(*) FILTER(WHERE NOT skipped AND issue),COALESCE(sum(amount) FILTER(WHERE NOT skipped AND NOT issue),0),
  COALESCE(jsonb_agg(ledger_id ORDER BY source_type,banked_at,source_group) FILTER(WHERE NOT skipped AND NOT issue),'[]'::jsonb)
 INTO bank_bad,bank_burned,bank_ids FROM verdict;
 source_issues:=source_issues+bank_bad;
 private_burned:=private_burned+bank_burned;
 private_ledger_ids:=private_ledger_ids||bank_ids;
"""
t = t[:start] + new + t[end_:]
save(N, t)

# ---------------------------------------------------------------- assert
N = 'fn_assert_cash_commission_period'
t = load(N)
t = sub(t, "   AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)\n",
        "   AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))\n", N)
save(N, t)

# ---------------------------------------------------------------- earned plan memo
N = 'fn_accounting_union_earned_plan'
save(N + '_v3', renamed(N, N + '_v3'))
save(N, """CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- WEEKLY CLOSE SCALE (20260928): a union's weekly close proves the same earned
-- plan up to nine times in one transaction (preparation twice, round 1 twice,
-- round 3, the ECO gate and the invoice evidence), about a minute each at
-- Midway's scale. Inside a close (app.accounting_close_memo='on', set only by
-- fn_process_weekly_accounting_scope for the attempt it is running) the first
-- proof of a (union, week) is kept for the rest of that transaction; a
-- rolled-back attempt forgets it with its subtransaction. Everywhere else the
-- plan is proved on every call, exactly as before, by
-- fn_accounting_union_earned_plan_v3.
DECLARE memo jsonb; memo_key text; plan jsonb;
BEGIN
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  memo:=NULLIF(current_setting('app.accounting_earned_plan_memo',true),'')::jsonb;
  IF memo ? memo_key THEN RETURN memo->memo_key; END IF;
 END IF;
 plan:=public.fn_accounting_union_earned_plan_v3(p_union_id,p_start,p_end);
 IF memo_key IS NOT NULL THEN
  PERFORM set_config('app.accounting_earned_plan_memo',(COALESCE(memo,'{}'::jsonb)||jsonb_build_object(memo_key,plan))::text,true);
 END IF;
 RETURN plan;
END $function$
""")
print('built', sorted(p.name for p in out.iterdir()))
