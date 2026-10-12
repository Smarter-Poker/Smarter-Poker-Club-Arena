#!/usr/bin/env python3
"""Builds new/fn_union_pnl_evidence_report.sql (from the definition
20260929001003 installs) and new/fn_union_pnl_boundary.sql (from the one
20260928222109 installs) by exact unique replacements, and assembles the
migration. Usage: build.py [postimage.json] [--nocheck]"""
from pathlib import Path
import json, sys
here = Path(__file__).resolve().parent
root = here.parents[2]
ENTRY_R = 'public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)'
UUID_RE = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"

REPORT_PAIRS = [
 (" v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb; v_open_resolved uuid[];\nBEGIN\n",
  " v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb; v_open_resolved uuid[];\n v_inv boolean; v_cash boolean; v_credit boolean;\nBEGIN\n"),
 (" -- Both readers wait for the original book's in-flight transactions; this\n",
  """ -- UNION P&L NARROW READS (20260929044303): the week's registration events,
 -- hands and tournament credits are read through their narrow projections
 -- (union_pnl_inventory_touches, union_pnl_cash_outcome_touches,
 -- union_pnl_credit_touches), each written by its source row's own insert,
 -- once the throttled backfill has proved it complete; until then through
 -- the original wide rows, statement for statement as before.
 v_inv:=public.fn_union_pnl_projection_ready('inventory_touches');
 v_cash:=public.fn_union_pnl_projection_ready('cash_outcome_touches');
 v_credit:=public.fn_union_pnl_projection_ready('credit_touches');
 -- Both readers wait for the original book's in-flight transactions; this
"""),
 (""" -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: count those through the partial index
 -- union_pnl_cash_outcomes_unaccepted, whose predicate is the last clause here.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
""",
  """ -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: those hands (the predicate of
 -- union_pnl_cash_outcomes_unaccepted), found through the projection's shape
 -- flag and re-checked against their rows, never the whole week's evidence.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.fn_union_pnl_week_shaped_hands(p_union_id,p_start,p_end,v_cash) o;
"""),
 (""" -- the same rows are reached through union_pnl_inventory_events_players_observed.
 WITH touched AS MATERIALIZED (
  SELECT i.row_id,COALESCE(i.after_row,i.before_row)->>'tournament_id' tournament_id
  FROM public.union_pnl_inventory_events i
  JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
  WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
   AND i.observed_at>=p_start AND i.observed_at<p_end
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
    AND t.row_id=CASE WHEN d.tournament_id ~ """ + UUID_RE + """ THEN d.tournament_id::uuid END
    AND t.row_id::text=d.tournament_id
    AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club(r) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS NULL) has_other
""",
  """ -- the same rows are reached through union_pnl_inventory_events_players_observed.
 -- Both reads (fn_union_pnl_touched_registrations, fn_union_pnl_tournament_in_union)
 -- come from union_pnl_inventory_touches once it is complete: the same keys,
 -- the frame's observed_at copied at capture, without the wide rows.
 WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND """ + ENTRY_R + """ IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR """ + ENTRY_R + """ IS NULL) has_other
"""),
 (""" SELECT count(*) INTO v_bad FROM public.tournament_accounting_credit_receipts c
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 WHERE c.tournament_snapshot->>'union_id'=p_union_id::text AND b.observed_at>=p_start AND b.observed_at<p_end
  AND (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id))
  AND NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved)
  AND NOT public.fn_union_pnl_award_satellite_owner(c);
""",
  """ -- The week's credits of this Union (its tournament snapshot's Union, its
 -- frame in the week) come from union_pnl_credit_touches once complete. The
 -- two whole-row resolutions (a whole-row value detoasts every snapshot of
 -- the credit) are asked only of a credit the entry test did not settle: the
 -- same conjunction, in an order the planner may not change.
 SELECT count(*) INTO v_bad FROM public.fn_union_pnl_week_union_credits(p_union_id,p_start,p_end,v_credit) w
 JOIN public.tournament_accounting_credit_receipts c ON c.id=w.credit_id
 WHERE CASE WHEN (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR """ + ENTRY_R + """ IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id))
  THEN NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved)
   AND NOT public.fn_union_pnl_award_satellite_owner(c) ELSE false END;
"""),
 ("""  FROM (SELECT o.evidence FROM public.union_pnl_cash_outcomes o
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   -- with this Union's linked hands, through their link resolutions
   UNION ALL SELECT k.evidence FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k) o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,(o.evidence->>'accepted_rake')::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p) x
""",
  """  FROM (SELECT h.hand_accepted_rake accepted_rake,h.hand_participants participants
   FROM public.fn_union_pnl_week_hand_lines(p_union_id,p_start,p_end,v_cash) h
   -- with this Union's linked hands, through their link resolutions
   UNION ALL SELECT k.evidence->>'accepted_rake',k.evidence->'participants' FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k) o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,o.accepted_rake::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.participants,'[]')) p) x
"""),
]

BOUNDARY_PAIRS = [
 (" nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric;\nBEGIN\n",
  " nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric; v_proj boolean;\nBEGIN\n"),
 (" FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x\n",
  """ -- First inventory operations come from union_pnl_inventory_touches once its
 -- backfill is complete (20260929044303), else from the wide events.
 v_proj:=public.fn_union_pnl_projection_ready('inventory_touches');
 FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x
"""),
 ("  SELECT operation INTO first_op FROM public.union_pnl_inventory_events WHERE source_name='tournaments' AND row_id=(t->>'id')::uuid ORDER BY event_id LIMIT 1;\n",
  "  first_op:=public.fn_union_pnl_first_inventory_operation('tournaments',(t->>'id')::uuid,v_proj);\n"),
 ("""     AND (SELECT e.operation FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players'
       AND e.row_id=(y.x#>>'{row,id}')::uuid ORDER BY e.event_id LIMIT 1) IS DISTINCT FROM 'INSERT'
""",
  """     AND public.fn_union_pnl_first_inventory_operation('tournament_players',(y.x#>>'{row,id}')::uuid,v_proj) IS DISTINCT FROM 'INSERT'
"""),
 ("""   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT public.fn_union_pnl_tournament_entry_club(r)) owners,
     min(public.fn_union_pnl_tournament_entry_club(r)::text)::uuid owned,sum(r.amount) value
""",
  """   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT """ + ENTRY_R + """) owners,
     min(""" + ENTRY_R + """::text)::uuid owned,sum(r.amount) value
"""),
]

def apply(src, pairs, what):
    for old, new in pairs:
        n = src.count(old)
        if n != 1: sys.exit(f'{what}: needle found {n} times: {old[:90]!r}')
        src = src.replace(old, new)
    return src

report = apply((here.parent / 'union-pnl-flow-scope-seat' / 'new' / 'fn_union_pnl_evidence_report.sql').read_text(), REPORT_PAIRS, 'report')
boundary = apply((here.parent / 'union-pnl-opening-resolution' / 'new' / 'fn_union_pnl_boundary.sql').read_text(), BOUNDARY_PAIRS, 'boundary')
for bad in ('union_pnl_inventory_events', 'fn_union_pnl_tournament_entry_club(r)'):
    pass
(here / 'new').mkdir(exist_ok=True)
(here / 'new' / 'fn_union_pnl_evidence_report.sql').write_text(report)
(here / 'new' / 'fn_union_pnl_boundary.sql').write_text(boundary)

objects = (here / 'objects.sql').read_text()
NOCHECK = '--nocheck' in sys.argv
args = [a for a in sys.argv[1:] if a != '--nocheck']
post = json.loads(Path(args[0]).read_text()) if args and not NOCHECK else {}
REPORT = 'fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'
BOUNDARY = 'fn_union_pnl_boundary(uuid,timestamp with time zone)'
NEW = ['fn_union_pnl_compact_participants(jsonb)',
       'fn_union_pnl_cash_outcome_touch_row(uuid,bigint,timestamp with time zone,jsonb,jsonb)',
       'fn_union_pnl_inventory_touch()', 'fn_union_pnl_cash_outcome_touch()', 'fn_union_pnl_credit_touch()',
       'fn_union_pnl_projection_build_guard()', 'fn_union_pnl_projection_ready(text)',
       'fn_union_pnl_projection_build_step(text,integer)', 'fn_union_pnl_projection_build_pending()',
       'fn_union_pnl_projection_status()', 'fn_union_pnl_projection_verify(real)',
       'fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean)',
       'fn_union_pnl_tournament_in_union(text,uuid,boolean)', 'fn_union_pnl_first_inventory_operation(text,uuid,boolean)',
       'fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean)',
       'fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)',
       'fn_union_pnl_week_union_credits(uuid,timestamp with time zone,timestamp with time zone,boolean)',
       'fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)']
PROC = 'sp_union_pnl_projection_build(integer,integer,integer,integer)'
TABLES = ['union_pnl_inventory_touches', 'union_pnl_cash_outcome_touches', 'union_pnl_credit_touches', 'union_pnl_projection_build']
PRE = {REPORT: ('16dcb8e9165ddd478802f24fbd22cab3', '20260929001003'),
       BOUNDARY: ('0e1fb7d6826b5a95ce5e637174017ede', '20260928222109 (#5552)'),
       'fn_union_pnl_tournament_entry_club(tournament_participant_funding_receipts)': ('b49d259721d3eb9c1d8ba7061fd28b7e', 'the live definition'),
       'fn_union_pnl_inventory_observe()': ('11c7c788d943a11375a15819e78873ba', 'the live writer (frame before event)'),
       'fn_union_pnl_receipt_frame()': ('dd4dbe3a58dc48bd67aab9ac818280d2', 'the live receipt framer'),
       'fn_union_pnl_original_frame()': ('9a6559774cc1ed4ed49b315a3428abdb', 'the live framer'),
       'fn_union_pnl_inventory_immutable()': ('307d83a1ee3d912bade24c48144aa801', 'the live immutability guard')}
pre_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{s}'::regprocedure)) IS DISTINCT FROM '{h}' THEN\n    RAISE EXCEPTION 'preimage mismatch: {s.split('(')[0]} is not {who}' USING ERRCODE='55000'; END IF;"
 for s, (h, who) in PRE.items())
exists = '\n     OR '.join([f"to_regclass('public.{t}') IS NOT NULL" for t in TABLES] +
                        [f"to_regprocedure('public.{s}') IS NOT NULL" for s in NEW + [PROC]])
post_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{s}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'postimage mismatch: {s}' USING ERRCODE='55000'; END IF;"
 for s, h in sorted(post.items())) or ("  NULL;" if NOCHECK else "  RAISE EXCEPTION 'postimage digests not generated yet';")
revokes = '\n'.join(f"REVOKE ALL ON FUNCTION public.{s} FROM PUBLIC, anon, authenticated, service_role;" for s in NEW + [REPORT, BOUNDARY])
revokes += f"\nREVOKE ALL ON PROCEDURE public.{PROC} FROM PUBLIC, anon, authenticated, service_role;"
header = (here / 'migration-header.sql').read_text()
out = f"""{header}
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
{pre_checks}
  IF {exists} THEN
    RAISE EXCEPTION 'preimage mismatch: projection objects already exist' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_cash_outcome_link_resolutions') IS NULL OR to_regclass('public.union_pnl_opening_registration_resolutions') IS NULL THEN
    RAISE EXCEPTION 'preimage mismatch: 20260928222109 and 20260929001003 are required' USING ERRCODE='55000';
  END IF;
  -- the projections rely on immutable sources and frames
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgfoid='public.fn_union_pnl_inventory_immutable()'::regprocedure
       AND tgrelid IN ('public.union_pnl_inventory_events'::regclass,'public.union_pnl_cash_outcomes'::regclass,'public.union_pnl_transaction_frames'::regclass))<>3
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='public.tournament_accounting_credit_receipts'::regclass
       AND tgname='original_evidence_immutable')
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='public.tournament_accounting_credit_receipts'::regclass
       AND tgname='original_union_pnl_frame' AND tgfoid='public.fn_union_pnl_receipt_frame()'::regprocedure) THEN
    RAISE EXCEPTION 'preimage mismatch: a projected source is not immutable or not framed' USING ERRCODE='55000';
  END IF;
END $pre$;

{objects.rstrip()}

{boundary.rstrip()};

{report.rstrip()};

{revokes}

-- ── 4. The writers go live last: each takes its source's SHARE ROW EXCLUSIVE
-- lock (waiting out, under lock_timeout, every transaction that already wrote
-- the source), and the source's size is read under that lock. Every row
-- committed before the writer lies below end_block; every later row is
-- projected by the writer in its own statement.
CREATE TRIGGER union_pnl_inventory_touch AFTER INSERT ON public.union_pnl_inventory_events
  FOR EACH ROW WHEN (NEW.source_name IN ('tournament_players','tournaments')) EXECUTE FUNCTION public.fn_union_pnl_inventory_touch();
CREATE TRIGGER union_pnl_cash_outcome_touch AFTER INSERT ON public.union_pnl_cash_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_cash_outcome_touch();
CREATE TRIGGER union_pnl_credit_touch AFTER INSERT ON public.tournament_accounting_credit_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_credit_touch();
INSERT INTO public.union_pnl_projection_build(projection,end_block,completed_at)
SELECT p,b,CASE WHEN b=0 THEN clock_timestamp() END FROM (VALUES
  ('inventory_touches',pg_relation_size('public.union_pnl_inventory_events')/current_setting('block_size')::bigint),
  ('cash_outcome_touches',pg_relation_size('public.union_pnl_cash_outcomes')/current_setting('block_size')::bigint),
  ('credit_touches',pg_relation_size('public.tournament_accounting_credit_receipts')/current_setting('block_size')::bigint)) v(p,b);

DO $post$
DECLARE f text;
BEGIN
{post_checks}
  FOREACH f IN ARRAY ARRAY[{', '.join("'public."+s+"'" for s in NEW + [REPORT, BOUNDARY])}] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is executable outside the owner',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_function_privilege('service_role','public.{PROC}','EXECUTE') OR has_function_privilege('authenticated','public.{PROC}','EXECUTE') THEN
    RAISE EXCEPTION 'postimage: the backfill procedure is executable outside the owner' USING ERRCODE='55000';
  END IF;
  FOREACH f IN ARRAY ARRAY[{', '.join("'public."+t+"'" for t in TABLES)}] LOOP
    IF has_table_privilege('anon',f,'SELECT') OR has_table_privilege('authenticated',f,'SELECT')
       OR has_table_privilege('service_role',f,'INSERT') OR has_table_privilege('service_role',f,'UPDATE') THEN
      RAISE EXCEPTION 'postimage: % is writable or browser-readable',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname='original_pnl_immutable'
       AND tgrelid IN ('public.union_pnl_inventory_touches'::regclass,'public.union_pnl_cash_outcome_touches'::regclass,'public.union_pnl_credit_touches'::regclass))<>3
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN ('union_pnl_inventory_touch','union_pnl_cash_outcome_touch','union_pnl_credit_touch'))<>3
     OR (SELECT count(*) FROM public.union_pnl_projection_build)<>3 THEN
    RAISE EXCEPTION 'postimage: a projection, its writer or its backfill state is missing' USING ERRCODE='55000';
  END IF;
  -- No balance column is written here (the money-RPC registry guard's own test).
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN ({', '.join("'public."+s+"'::regprocedure" for s in NEW + [REPORT, BOUNDARY, PROC])})
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN
    RAISE EXCEPTION 'postimage: a function here writes balances' USING ERRCODE='55000';
  END IF;
END $post$;

COMMIT;
"""
mig = sorted(root.glob('supabase/migrations/*_a_union_close_reads_narrow_projections_not_wide_rows.sql'))[0]
mig.write_text(out)
print('wrote', mig.name, len(out))
