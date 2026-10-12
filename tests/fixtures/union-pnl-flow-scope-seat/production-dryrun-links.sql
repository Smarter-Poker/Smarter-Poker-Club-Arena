-- Read-only (a single SELECT): the link proof core, byte for byte except the argument line.
SET statement_timeout='44s';
SELECT q.table_id,q.hand_number,q.proof->>'status' status,q.proof->>'reason' reason,q.proof->>'roster_source' roster,
 q.proof#>>'{game_scope,game_union_id}' union_id,q.proof#>>'{evidence,status}' evidence,q.proof#>>'{evidence,accepted_rake}' rake,
 q.proof#>>'{evidence,observed_delta_total}' delta
FROM (
-- CORE BEGIN (the production dry run executes exactly this text)
WITH args AS MATERIALIZED (SELECT '2026-09-21 07:00+00'::timestamptz AS s, '2026-09-28 07:00+00'::timestamptz AS e),
cand AS MATERIALIZED (
 SELECT o.table_id,o.hand_number,o.hand_id,o.payload_hash,o.evidence,o.recognized_at,
  p.table_id p_table,p.accepted_at,p.status pstatus,p.manifest_id pmani,p.issues pissues,p.hand_id phand,p.payload_hash phash,p.version pversion,
  p.accepted_request req,p.participants pparts,p.atomic_receipt atomic,p.stack_claim claim,p.stack_settlement settle,
  p.rake prake,p.bbj pbbj,p.signed_external_net pnet,p.all_players_included pall
 FROM args a JOIN public.union_pnl_cash_outcomes o ON o.recognized_at>=a.s AND o.recognized_at<a.e
  AND NOT o.game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale']
 LEFT JOIN public.cash_hand_provenance_receipts p ON p.table_id=o.table_id AND p.hand_number=o.hand_number
 WHERE o.evidence->>'reason'='accepted_cash_provenance_link_missing' AND o.evidence->>'status'='blocked'
), base AS MATERIALIZED (
 SELECT c.*,c.atomic->'stack_result'->'request' vreq,(c.atomic->>'committed_at')::timestamptz committed_at,
  m.id mid,m.captured_at mcap,m.participants mparts,m.issues missues,m.game_scope mscope,m.funding_provenance_complete mcomplete,
  la.live,tr.r trow,cl.asset club_asset,
  CASE WHEN m.id IS NULL THEN to_timestamp((c.req#>>'{hand_row,actions,0,timestamp}')::numeric/1000) END deal_at
 FROM cand c
 LEFT JOIN public.cash_hand_participant_manifests m ON m.table_id=c.table_id AND m.hand_number=c.hand_number
 LEFT JOIN LATERAL (SELECT to_jsonb(h) live FROM public.hand_atomic_commits h WHERE h.table_id=c.table_id AND h.hand_number=c.hand_number) la ON true
 LEFT JOIN LATERAL (SELECT e.after_row r FROM public.union_pnl_inventory_events e WHERE e.source_name='tables' AND e.row_id=c.table_id
   AND e.observed_at<=(c.atomic->>'committed_at')::timestamptz ORDER BY e.event_id DESC LIMIT 1) tr ON true
 LEFT JOIN public.clubs cl ON cl.id=(tr.r->>'club_id')::uuid
), scoped AS (
 SELECT b.*,jsonb_build_object('host_club_id',b.trow->'club_id',
   'game_union_id',CASE WHEN b.trow->'is_private'='true'::jsonb THEN 'null'::jsonb ELSE b.trow->'union_id' END,
   'is_private',b.trow->'is_private','tournament_id',b.trow->'tournament_id','asset',to_jsonb(b.club_asset),'unit_scale',2) scope
 FROM base b
), people AS MATERIALIZED (
 -- the dealt roster: each signed stack, its original seat generation (the
 -- manifest captured for this hand, or the seat's own inventory row at the
 -- deal), and its original funding lineage at that moment
 SELECT s.table_id,s.hand_number,x.o,x.v st,(x.v->>'user_id')::uuid user_id,mp.v mp,sr.r seat,
  COALESCE((mp.v->>'occupancy_id')::uuid,(sr.r->>'occupancy_id')::uuid) occupancy_id,
  COALESCE((mp.v#>>'{funding_lineage,observed_at}')::timestamptz,s.deal_at) lineage_at,
  public.fn_pnl_evidence_cents(x.v->'stack_before') v_before,public.fn_pnl_evidence_cents(x.v->'stack') v_after
 FROM scoped s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.vreq->'stacks')='array' THEN s.vreq->'stacks' ELSE '[]' END) WITH ORDINALITY x(v,o)
 LEFT JOIN LATERAL (SELECT y.v FROM jsonb_array_elements(COALESCE(s.mparts,'[]')) y(v) WHERE y.v->>'user_id'=x.v->>'user_id'
   AND y.v->>'seat_id'=x.v->>'seat_id' AND (y.v->>'seat_joined_at')::timestamptz=(x.v->>'seat_joined_at')::timestamptz
   AND public.fn_pnl_evidence_cents(y.v->'stack_before')=public.fn_pnl_evidence_cents(x.v->'stack_before')) mp ON true
 LEFT JOIN LATERAL (SELECT e.after_row r FROM public.union_pnl_inventory_events e WHERE s.mid IS NULL AND e.source_name='table_seats'
   AND e.row_id=(x.v->>'seat_id')::uuid AND e.observed_at<=s.deal_at ORDER BY e.event_id DESC LIMIT 1) sr ON true
), owned AS (
 SELECT p.*,lin.v lineage,
  (SELECT count(*) FROM jsonb_array_elements(lin.v->'funding_receipts')) n_refs,
  (SELECT count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)) FROM jsonb_array_elements(lin.v->'funding_receipts') ref
    JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) n_accounts,
  (SELECT count(*) FILTER(WHERE r.operation_kind='buyin') FROM jsonb_array_elements(lin.v->'funding_receipts') ref
    JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) n_initial,
  (SELECT count(*) FROM jsonb_array_elements(lin.v->'funding_receipts') ref
    LEFT JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid WHERE r.id IS NULL OR r.user_id IS DISTINCT FROM p.user_id) n_foreign,
  (SELECT min(r.funding_club_id::text)::uuid FROM jsonb_array_elements(lin.v->'funding_receipts') ref
    JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) club,
  (SELECT COALESCE(jsonb_agg(ref->'id'),'[]') FROM jsonb_array_elements(lin.v->'funding_receipts') ref) receipt_ids
 FROM people p
 CROSS JOIN LATERAL (SELECT CASE WHEN p.occupancy_id IS NULL OR p.lineage_at IS NULL THEN NULL
   ELSE public.fn_cash_original_funding_lineage(p.user_id,p.table_id,(p.st->>'seat_id')::uuid,p.occupancy_id,
    (p.st->>'seat_joined_at')::timestamptz,p.lineage_at,false) END v) lin
), per_hand AS (
 SELECT w.table_id,w.hand_number,count(*) n,count(DISTINCT w.user_id) n_users,
  count(*) FILTER(WHERE (w.mp IS NULL AND w.seat IS NULL) OR w.occupancy_id IS NULL OR w.v_before IS NULL OR w.v_after IS NULL OR w.v_before<0 OR w.v_after<0) n_unmatched,
  count(*) FILTER(WHERE w.seat IS NOT NULL AND (w.seat->>'user_id' IS DISTINCT FROM w.st->>'user_id'
    OR (w.seat->>'joined_at')::timestamptz IS DISTINCT FROM (w.st->>'seat_joined_at')::timestamptz OR w.seat->'left_at' IS DISTINCT FROM 'null'::jsonb
    OR w.seat->>'table_id' IS DISTINCT FROM w.table_id::text OR public.fn_pnl_evidence_cents(w.seat->'stack') IS DISTINCT FROM w.v_before)) n_seat_bad,
  count(*) FILTER(WHERE w.mp IS NOT NULL AND (w.lineage IS DISTINCT FROM w.mp->'funding_lineage' OR w.lineage->'funding_receipts' IS DISTINCT FROM w.mp->'funding_receipts')) n_manifest_lineage_bad,
  sum(w.v_after-w.v_before) delta,
  jsonb_agg(jsonb_build_object('user_id',w.user_id,'is_horse',COALESCE(w.mp->'is_horse',(SELECT to_jsonb(pr.is_horse) FROM public.profiles pr WHERE pr.id=w.user_id)),
   'observed_stack_delta',w.v_after-w.v_before,
   'earning_club_id',CASE WHEN w.lineage->'issues'='[]'::jsonb AND w.n_refs>0 AND w.n_accounts=1 AND w.n_initial=1 AND w.n_foreign=0 THEN w.club END,
   'ownership_certified',COALESCE(w.lineage->'issues'='[]'::jsonb AND w.n_refs>0 AND w.n_accounts=1 AND w.n_initial=1 AND w.n_foreign=0,false),
   'ownership_scope','original_chip_funding_club','funding_receipt_ids',w.receipt_ids,'occupancy_id',w.occupancy_id) ORDER BY w.o) people,
  count(*) FILTER(WHERE NOT COALESCE(w.lineage->'issues'='[]'::jsonb AND w.n_refs>0 AND w.n_accounts=1 AND w.n_initial=1 AND w.n_foreign=0,false)) n_unowned,
  jsonb_agg(w.user_id) FILTER(WHERE NOT COALESCE(w.lineage->'issues'='[]'::jsonb AND w.n_refs>0 AND w.n_accounts=1 AND w.n_initial=1 AND w.n_foreign=0,false)) unowned
 FROM owned w GROUP BY w.table_id,w.hand_number
), judged AS (
 SELECT s.*,h.n,h.n_users,h.n_unmatched,h.n_seat_bad,h.n_manifest_lineage_bad,h.delta,h.people,h.n_unowned,h.unowned,
  COALESCE(public.fn_pnl_evidence_cents(NULLIF(s.vreq->'rake','null'::jsonb)),CASE WHEN s.vreq->'rake' IS NULL OR s.vreq->'rake'='null'::jsonb THEN 0 END) v_rake,
  COALESCE(public.fn_pnl_evidence_cents(NULLIF(s.vreq->'bbj','null'::jsonb)),CASE WHEN s.vreq->'bbj' IS NULL OR s.vreq->'bbj'='null'::jsonb THEN 0 END) v_bbj,
  COALESCE(public.fn_pnl_evidence_cents(NULLIF(s.vreq->'inflow','null'::jsonb)),CASE WHEN s.vreq->'inflow' IS NULL OR s.vreq->'inflow'='null'::jsonb THEN 0 END) v_inflow,
  CASE
   WHEN s.p_table IS NULL THEN 'original_cash_provenance_missing'
   WHEN s.pmani IS NOT NULL OR s.pstatus IS DISTINCT FROM 'uncertified' OR s.pissues IS DISTINCT FROM '["original_dealt_manifest_missing"]'::jsonb
    OR s.pversion IS DISTINCT FROM 1 OR s.pall IS DISTINCT FROM false THEN 'provenance_is_not_the_unlinked_receipt'
   WHEN s.phand IS DISTINCT FROM s.hand_id OR s.phash IS DISTINCT FROM s.payload_hash
    OR jsonb_typeof(s.atomic) IS DISTINCT FROM 'object' OR s.atomic->>'table_id' IS DISTINCT FROM s.table_id::text
    OR s.atomic->>'hand_number' IS DISTINCT FROM s.hand_number::text OR s.atomic->>'hand_id' IS DISTINCT FROM s.hand_id::text
    OR s.atomic->>'payload_hash' IS DISTINCT FROM s.payload_hash THEN 'hand_identity_mismatch'
   WHEN s.live IS NOT NULL AND NOT public.fn_cash_atomic_original_matches(s.atomic,s.live,s.req) THEN 'live_atomic_receipt_conflicts_with_original'
   WHEN s.committed_at IS NULL OR NOT isfinite(s.committed_at) OR s.atomic->'stack_result'->'success' IS DISTINCT FROM 'true'::jsonb
    OR s.atomic->'stack_result'->>'mode' IS DISTINCT FROM 'delta' OR jsonb_typeof(s.vreq->'stacks') IS DISTINCT FROM 'array'
    OR s.atomic->'stack_result'->'tournament_id' IS DISTINCT FROM 'null'::jsonb THEN 'accepted_cash_delta_request_missing'
   WHEN s.accepted_at IS NULL OR s.accepted_at<s.committed_at OR jsonb_typeof(s.req) IS DISTINCT FROM 'object'
    OR s.req->>'table_id' IS DISTINCT FROM s.table_id::text OR s.req->>'hand_number' IS DISTINCT FROM s.hand_number::text
    OR encode(extensions.digest(convert_to(s.req::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM s.payload_hash
    OR s.req->'stacks' IS DISTINCT FROM s.vreq->'stacks' OR s.pparts IS DISTINCT FROM s.req->'stacks' THEN 'signed_request_mismatch'
   WHEN s.claim->>'table_id' IS DISTINCT FROM s.table_id::text OR s.claim->>'hand_id' IS DISTINCT FROM s.atomic->'stack_result'->>'hand_id'
    OR s.claim->>'status' IS DISTINCT FROM 'succeeded' OR (s.claim->>'completed_at') IS NULL OR s.claim->'result' IS DISTINCT FROM s.atomic->'stack_result'
    OR s.settle->>'table_id' IS DISTINCT FROM s.table_id::text OR s.settle->>'hand_id' IS DISTINCT FROM s.atomic->'stack_result'->>'hand_id'
    OR s.settle->>'settlement_type' IS DISTINCT FROM 'hand_stacks' OR s.settle->>'state' IS DISTINCT FROM 'final' THEN 'accepted_stack_receipt_link_missing'
   WHEN s.trow IS NULL OR s.club_asset IS NULL THEN 'original_table_scope_missing'
   WHEN s.mid IS NOT NULL AND (s.mcap IS NULL OR s.mcap>s.accepted_at OR s.mscope IS DISTINCT FROM s.scope
    OR jsonb_typeof(s.mparts) IS DISTINCT FROM 'array' OR jsonb_array_length(s.mparts)<>jsonb_array_length(s.vreq->'stacks')) THEN 'manifest_disagrees_with_hand'
   WHEN s.mid IS NULL AND (s.deal_at IS NULL OR s.deal_at>s.committed_at) THEN 'deal_time_unproven'
   WHEN h.n IS NULL OR h.n<2 OR h.n>10 OR h.n_users<>h.n OR h.n_unmatched>0 THEN 'original_roster_unproven'
   WHEN h.n_seat_bad>0 THEN 'seat_inventory_disagrees_with_dealt_stack'
   WHEN h.n_manifest_lineage_bad>0 THEN 'manifest_funding_lineage_disagrees'
  END refusal
 FROM scoped s LEFT JOIN per_hand h ON h.table_id=s.table_id AND h.hand_number=s.hand_number
)
SELECT j.table_id,j.hand_number,
 jsonb_build_object('resolution_kind','cash_outcome_provenance_link','table_id',j.table_id,'hand_number',j.hand_number,'hand_id',j.hand_id,
  'outcome_payload_hash',j.payload_hash,'outcome_evidence_md5',md5(j.evidence::text),'roster_source',CASE WHEN j.mid IS NOT NULL THEN 'manifest' ELSE 'seat_inventory' END,
  'manifest_id',j.mid,'deal_at',j.deal_at,'game_scope',j.scope)
 ||CASE WHEN j.refusal IS NOT NULL THEN jsonb_build_object('status','refused','reason',j.refusal)
  ELSE jsonb_build_object('status','proven','evidence',
   (SELECT jsonb_build_object('status',CASE WHEN q.i='[]'::jsonb THEN 'ready' ELSE 'blocked' END,'basis_certified',q.i='[]'::jsonb,
     'scope','single_accepted_cash_hand','payment_authorized',false,'hand_id',j.hand_id,'table_id',j.table_id,'hand_number',j.hand_number,
     'observed_commit_at',j.committed_at,'observed_delta_total',j.delta,'participants',j.people,'issues',q.i,'game_scope',j.scope,
     'current_seats_used',false,'current_membership_used',false,'all_players_included',true,
     'accepted_rake',j.v_rake,'accepted_bbj',j.v_bbj,'accepted_external_net',j.v_inflow,'provenance_link','resolved')
    FROM (SELECT
      CASE WHEN j.mid IS NOT NULL AND (j.missues IS DISTINCT FROM '[]'::jsonb OR j.mcomplete IS DISTINCT FROM true)
       THEN '["original_cash_funding_incomplete"]'::jsonb||COALESCE(j.missues,'[]') ELSE '[]'::jsonb END
      ||CASE WHEN j.scope->>'asset' IS DISTINCT FROM 'chips' OR j.scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
        OR jsonb_typeof(j.scope->'is_private') IS DISTINCT FROM 'boolean'
        OR (j.scope->'is_private'='false'::jsonb AND (j.scope->>'game_union_id') IS NULL)
       THEN '["historical_game_asset_and_union_receipt_invalid"]'::jsonb ELSE '[]'::jsonb END
      ||COALESCE((SELECT jsonb_agg(jsonb_build_object('reason','participant_earning_ownership_receipt_invalid','user_id',u)) FROM jsonb_array_elements(j.unowned) u),'[]')
      ||CASE WHEN j.v_rake IS NULL OR j.v_bbj IS NULL OR j.v_inflow IS NULL OR j.v_rake<0 OR j.v_bbj<0
        OR j.v_rake IS DISTINCT FROM j.prake OR j.v_bbj IS DISTINCT FROM j.pbbj OR j.v_inflow IS DISTINCT FROM j.pnet
        OR public.fn_pnl_evidence_cents(COALESCE(NULLIF(j.req->'rake','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM j.v_rake
        OR public.fn_pnl_evidence_cents(COALESCE(NULLIF(j.req->'bbj','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM j.v_bbj
        OR public.fn_pnl_evidence_cents(COALESCE(NULLIF(j.req->'inflow','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM j.v_inflow
       THEN '["hand_conservation_inputs_missing"]'::jsonb
       WHEN j.delta+j.v_rake+j.v_bbj<>j.v_inflow THEN '["hand_delta_conservation_mismatch"]'::jsonb ELSE '[]'::jsonb END
      ||CASE WHEN j.v_inflow IS DISTINCT FROM 0 THEN '["external_bank_receipt_not_certified"]'::jsonb ELSE '[]'::jsonb END i) q))
 END AS proof
FROM judged j
ORDER BY j.table_id,j.hand_number
-- CORE END
) q;
