CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_flow_evidence(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
 ), matched AS (
  SELECT q.*,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   rf.refunds,rf.club refund_club,rf.player refund_user
  FROM originals q
  LEFT JOIN public.cash_participant_funding_receipts f ON f.source_ledger_id=q.ledger_id AND q.tournament_id IS NULL
  LEFT JOIN public.tournament_participant_funding_receipts e ON e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id
  LEFT JOIN public.fn_union_pnl_tournament_returns(NULL,NULL,p_start,p_end) c ON c.ledger_id=q.ledger_id AND q.tournament_id=c.tournament_id
  LEFT JOIN LATERAL (
   SELECT count(DISTINCT (r.funding_club_id,r.user_id)) owners,min(r.funding_club_id::text)::uuid funding_club_id,min(r.user_id::text)::uuid user_id
   FROM public.cash_participant_funding_receipts r
   WHERE r.table_id=(q.l->>'table_id')::uuid AND r.operation_kind='buyin'
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid
    AND r.funding_club_id=(q.l->>'club_id')::uuid
    AND (EXISTS(SELECT 1 FROM public.union_pnl_inventory_events i WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'occupancy_id'=r.occupancy_id::text
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=r.table_id::text)
     OR EXISTS(SELECT 1 FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
       WHERE a.transaction_id=q.transaction_id AND original.occupancy_id=r.occupancy_id AND a.refunded=(q.l->>'amount')::numeric))
  ) ret ON true
  -- A seat cashed out after it arrived by a table move holds chips whose
  -- original buy-in is on the source occupancy, not this one. The occupancy
  -- the cash-out vacated (its seat row in the same original transaction,
  -- carrying exactly the cashed-out stack) is traced through its move receipts
  -- by fn_cash_original_funding_lineage, the proof the boundaries and hands
  -- already use; the owner is its one original buy-in's club and player.
  LEFT JOIN LATERAL (
   SELECT CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.club END moved_club,
    CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.player END moved_user
   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats' AND i.before_row->>'table_id'=q.l->>'table_id'
      AND i.before_row->>'user_id'=q.l->>'to_entity_id' AND i.before_row->'left_at'='null'::jsonb
      AND i.after_row->>'left_at' IS NOT NULL) s
   CROSS JOIN LATERAL (SELECT public.fn_cash_original_funding_lineage((s.seat->>'user_id')::uuid,(s.seat->>'table_id')::uuid,(s.seat->>'id')::uuid,
     (s.seat->>'occupancy_id')::uuid,(s.seat->>'joined_at')::timestamptz,q.recognized_at,false) v) lin
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE r.operation_kind='buyin') buyins,count(DISTINCT r.funding_club_id) clubs,
     count(DISTINCT r.user_id) users,min(r.funding_club_id::text)::uuid club,min(r.user_id::text)::uuid player
    FROM jsonb_array_elements(lin.v->'funding_receipts') ref JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) own
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet' AND ret.owners IS DISTINCT FROM 1
    AND s.n=1 AND public.fn_pnl_evidence_cents(s.seat->'stack') IS NOT DISTINCT FROM (q.l->>'amount')::numeric
  ) mv ON true
  -- A pending add-on returned unapplied is a refund of this player's own
  -- escrowed chips. Its wallet credit can carry no refund category: it runs
  -- inside the hand's post-commit obligations, after atomic_distribute_rake
  -- has declared that transaction's ledger context, so the audit labels it
  -- player_funding under the rake settlement. The application receipt
  -- written in the same transaction proves it: exactly one refund of this
  -- amount from a funding receipt of this player, club and table.
  LEFT JOIN LATERAL (
   SELECT count(*) refunds,min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
   FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
   WHERE a.transaction_id=q.transaction_id AND a.refunded>0 AND a.refunded=(q.l->>'amount')::numeric
    AND a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
    AND o.table_id=(q.l->>'table_id')::uuid AND o.account_type='player_wallet' AND o.account_entity_id=(q.l->>'to_entity_id')::uuid
    AND o.funding_club_id=(q.l->>'club_id')::uuid AND o.user_id=(q.l->>'to_entity_id')::uuid
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
    AND q.l->>'category'='player_funding'
  ) rf ON true
 ), projected AS (
  SELECT *,CASE WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(cash_club,CASE WHEN moved_club IS NULL THEN return_club ELSE moved_club END,entry_club,credit_club) owner_club,
   COALESCE(cash_user,CASE WHEN moved_club IS NULL THEN return_user ELSE moved_user END,entry_user,credit_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND owner_club::text=l->>'club_id' AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_funding' THEN cash_amount=(l->>'amount')::numeric AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN (owners=1 OR moved_club IS NOT NULL) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN credit_amount=(l->>'amount')::numeric AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected;
$function$;

-- A registration admitted by a satellite has no chip entry of its own: its
-- entry is the satellite's award (a seat delivered to this registration, or
-- an entry-only ticket redeemed by it, at the moment it registered), and the
-- award's owner is the one club whose posted, hash-chained ledger debits
-- funded this player's own entry into that satellite. Anything else: NULL.
-- p_tournament_id, when given, must be the registration's own tournament.
CREATE FUNCTION public.fn_union_pnl_satellite_seat_owner(p_registration_id uuid, p_tournament_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH reg AS (
  SELECT e.after_row r FROM public.union_pnl_inventory_events e
  WHERE e.source_name='tournament_players' AND e.row_id=p_registration_id ORDER BY e.event_id LIMIT 1
 ), who AS (
  SELECT (r->>'user_id')::uuid user_id,(r->>'source_satellite_id')::uuid satellite_id,(r->>'registered_at')::timestamptz registered_at,
   (r->>'tournament_id')::uuid target_id
  FROM reg WHERE (p_tournament_id IS NULL OR r->>'tournament_id'=p_tournament_id::text)
   AND r->>'source_satellite_id' IS NOT NULL AND r->>'user_id' IS NOT NULL AND r->>'tournament_id' IS NOT NULL
 ), award AS (
  SELECT a.tournament_id,a.user_id FROM who w
  JOIN public.tournament_satellite_awards a ON a.tournament_id=w.satellite_id AND a.user_id=w.user_id
  JOIN public.tournament_satellite_settlements s ON s.tournament_id=a.tournament_id AND s.target_id=w.target_id
  WHERE (a.delivery_kind='seat' AND a.registration_id=p_registration_id)
   OR (a.delivery_kind='ticket' AND a.registration_id IS NULL AND EXISTS(SELECT 1 FROM public.tournament_tickets t WHERE t.id=a.ticket_id
     AND t.holder_id=w.user_id AND t.source_satellite_id=w.satellite_id AND t.source_tournament_id=w.target_id
     AND t.status='redeemed' AND t.redemption_mode='tournament_entry_only' AND t.redeemed_at=w.registered_at))
 ), entry AS (
  SELECT count(*) n,count(DISTINCT r.funding_club_id) clubs,min(r.funding_club_id::text)::uuid club,
   count(*) FILTER(WHERE r.operation='entry') entries,
   count(*) FILTER(WHERE r.asset IS DISTINCT FROM 'chips' OR r.amount IS NULL OR r.amount<=0 OR r.funding_club_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.chip_ledger l WHERE l.id=r.ledger_id AND l.status='posted' AND l.from_type='player_wallet' AND l.from_entity_id=r.user_id
     AND l.to_type='prize_liability' AND l.to_entity_id=r.tournament_id AND l.tournament_id=r.tournament_id AND l.amount=r.amount
     AND l.club_id=r.funding_club_id AND l.category IN ('tournament_buyin','rebuy','addon') AND l.row_hash IS NOT NULL)) bad
  FROM award a JOIN public.tournament_participant_funding_receipts r ON r.tournament_id=a.tournament_id AND r.user_id=a.user_id
 )
 SELECT CASE WHEN (SELECT count(*) FROM award)=1 AND e.n>0 AND e.entries>=1 AND e.clubs=1 AND e.bad=0 THEN e.club END FROM entry e
$function$;

-- An award naming no entry receipt, paid to a registration admitted by a
-- satellite: accepted only when the satellite chain proves its owner is the
-- credited club and the award is the posted prize-pool credit to this player.
CREATE FUNCTION public.fn_union_pnl_award_satellite_owner(c public.tournament_accounting_credit_receipts)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE(cardinality(c.entry_receipt_ids),0)=0 AND c.asset='chips' AND c.amount>0 AND c.registration_snapshot->>'id' IS NOT NULL
  AND (SELECT e.after_row->>'user_id' FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players'
    AND e.row_id=(c.registration_snapshot->>'id')::uuid ORDER BY e.event_id LIMIT 1)=c.user_id::text
  AND public.fn_union_pnl_satellite_seat_owner((c.registration_snapshot->>'id')::uuid,c.tournament_id)=c.credited_club_id
  AND EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=c.ledger_id AND l.status='posted' AND l.category IN ('tournament_prize','bounty')
   AND l.tournament_id=c.tournament_id AND l.from_type='prize_liability' AND l.from_entity_id=c.tournament_id
   AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id AND l.amount=c.amount AND l.club_id=c.credited_club_id AND l.row_hash IS NOT NULL)
$function$;

CREATE TABLE public.union_pnl_cash_outcome_link_resolutions (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  outcome_payload_hash text NOT NULL,
  outcome_evidence_md5 text NOT NULL CHECK (outcome_evidence_md5 ~ '^[0-9a-f]{32}$'),
  roster_source text NOT NULL CHECK (roster_source IN ('manifest','seat_inventory')),
  manifest_id uuid,
  game_scope jsonb NOT NULL CHECK (jsonb_typeof(game_scope)='object'
    AND game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale']),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND evidence->>'provenance_link'='resolved'),
  proof jsonb NOT NULL,
  proof_md5 text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 20),
  resolved_by text NOT NULL DEFAULT session_user,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number),
  UNIQUE (hand_id),
  CHECK (proof_md5 = md5(proof::text)),
  CHECK ((roster_source='manifest') = (manifest_id IS NOT NULL)),
  CHECK (proof->>'status'='proven' AND proof->>'resolution_kind'='cash_outcome_provenance_link'
    AND proof->>'table_id'=table_id::text AND (proof->>'hand_number')::bigint=hand_number AND proof->>'hand_id'=hand_id::text
    AND proof->>'outcome_payload_hash'=outcome_payload_hash AND proof->>'outcome_evidence_md5'=outcome_evidence_md5
    AND proof->>'roster_source'=roster_source AND proof->>'manifest_id' IS NOT DISTINCT FROM manifest_id::text
    AND proof->'game_scope'=game_scope AND proof->'evidence'=evidence AND evidence->'game_scope'=game_scope)
);
ALTER TABLE public.union_pnl_cash_outcome_link_resolutions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_cash_outcome_link_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
REVOKE ALL ON TABLE public.union_pnl_cash_outcome_link_resolutions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.union_pnl_cash_outcome_link_resolutions TO service_role;

-- The valid link resolution of this outcome: bound to its hand, its signed
-- payload hash and its exact (immutable) evidence, and to its own proof.
CREATE FUNCTION public.fn_union_pnl_cash_outcome_link(o public.union_pnl_cash_outcomes)
 RETURNS SETOF public.union_pnl_cash_outcome_link_resolutions
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT r.* FROM public.union_pnl_cash_outcome_link_resolutions r
 WHERE r.table_id=o.table_id AND r.hand_number=o.hand_number AND r.hand_id=o.hand_id
  AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text) AND r.proof_md5=md5(r.proof::text)
$function$;

-- The week's linked hands of one Union, through their re-proved scope.
CREATE FUNCTION public.fn_union_pnl_linked_cash_outcomes(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(table_id uuid, hand_number bigint, game_scope jsonb, evidence jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT r.table_id,r.hand_number,r.game_scope,r.evidence
 FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)
  AND r.proof_md5=md5(r.proof::text)
$function$;

-- Re-proves every accepted cash hand of the period whose provenance link was
-- never recorded (the engine lost the manifest id: evidence
-- accepted_cash_provenance_link_missing, no game scope). The roster is the
-- manifest captured for that hand (matched seat by seat to the signed stacks)
-- or, when none was captured, each seat's own inventory row at the deal; the
-- scope is the table's own inventory row at the hand; each player's owner is
-- their original funding lineage; conservation is checked as for every hand.
-- Refuses (first failing reason) anything it cannot prove.
CREATE FUNCTION public.fn_union_pnl_prove_cash_outcome_links(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(table_id uuid, hand_number bigint, proof jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
-- CORE BEGIN (the production dry run executes exactly this text)
WITH args AS MATERIALIZED (SELECT p_start AS s, p_end AS e),
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
$function$;

CREATE FUNCTION public.fn_union_pnl_resolve_cash_outcome_links(p_start timestamp with time zone, p_end timestamp with time zone, p_reason text, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c record; v_cand integer:=0; v_proven integer:=0; v_resolved integer:=0; v_already integer:=0; v_refused integer:=0;
 v_ready integer:=0; v_refusals jsonb:='{}'; v_unions jsonb:='{}'; v_key text; v_n integer;
BEGIN
 IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<=p_start OR p_end-p_start>interval '8 days' THEN
  RAISE EXCEPTION 'invalid_resolution_period' USING ERRCODE='22023'; END IF;
 IF p_apply IS NOT FALSE AND (p_reason IS NULL OR length(btrim(p_reason))<20) THEN
  RAISE EXCEPTION 'resolution_reason_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union_pnl_cash_outcome_link_resolution',0));
 FOR c IN SELECT * FROM public.fn_union_pnl_prove_cash_outcome_links(p_start,p_end) LOOP
  v_cand:=v_cand+1;
  IF c.proof->>'status'='proven' THEN
   IF c.proof#>>'{evidence,status}'='ready' THEN v_ready:=v_ready+1; END IF;
   v_key:=COALESCE(c.proof#>>'{game_scope,game_union_id}','no_union');
   v_unions:=v_unions||jsonb_build_object(v_key,jsonb_build_object('hands',COALESCE((v_unions#>>ARRAY[v_key,'hands'])::integer,0)+1,
    'accepted_rake',COALESCE((v_unions#>>ARRAY[v_key,'accepted_rake'])::numeric,0)+(c.proof#>>'{evidence,accepted_rake}')::numeric,
    'observed_delta_total',COALESCE((v_unions#>>ARRAY[v_key,'observed_delta_total'])::numeric,0)+(c.proof#>>'{evidence,observed_delta_total}')::numeric));
   IF EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_link_resolutions r WHERE r.table_id=c.table_id AND r.hand_number=c.hand_number) THEN
    v_already:=v_already+1;
   ELSIF p_apply THEN
    INSERT INTO public.union_pnl_cash_outcome_link_resolutions(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,
     roster_source,manifest_id,game_scope,evidence,proof,proof_md5,reason)
    VALUES(c.table_id,c.hand_number,(c.proof->>'hand_id')::uuid,c.proof->>'outcome_payload_hash',c.proof->>'outcome_evidence_md5',
     c.proof->>'roster_source',(c.proof->>'manifest_id')::uuid,c.proof->'game_scope',c.proof->'evidence',c.proof,md5(c.proof::text),btrim(p_reason));
    v_resolved:=v_resolved+1;
   ELSE v_proven:=v_proven+1; END IF;
  ELSE
   v_refused:=v_refused+1; v_n:=COALESCE((v_refusals->>(c.proof->>'reason'))::integer,0)+1;
   v_refusals:=v_refusals||jsonb_build_object(c.proof->>'reason',v_n);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('period_start',p_start,'period_end',p_end,'applied',p_apply IS NOT FALSE,'candidates',v_cand,
  'proven_not_written',v_proven,'resolved_now',v_resolved,'already_resolved',v_already,'refused',v_refused,'refusals',v_refusals,
  'evidence_ready',v_ready,'by_union',v_unions);
END $function$;
