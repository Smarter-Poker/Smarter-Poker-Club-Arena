-- A CASH-OUT, A LOST LINK AND A SATELLITE SEAT ARE PROVED FROM THEIR LEDGER (2026-09-29).
--
-- After #5552 (20260928211132 + 20260928222109), #5554 (20260928230637) and
-- the opening resolution writers, Midway Union's book 2026-09-21 07:00 ..
-- 09-28 07:00 UTC is still refused (read-only on production 2026-09-28/29):
--  * original_money_flow_basis_incomplete (4,048 flows): every cash-out is
--    ledgered 'table_cashout' (fn_ca_declare_ledger('table_cashout',...) in
--    player_leave_table, the admin kick and atomic_seat_cashout_locked; no
--    'cashout' row exists), which fn_union_pnl_original_flow_evidence never
--    accepted; and 723 of them vacate a seat that arrived by a table move,
--    whose buy-in receipt is on the source occupancy, so the direct owner
--    match found none. Both are proved here: the same ledger shape
--    (table_stack -> player_wallet, posted, the wallet's club), and for a
--    moved seat the occupancy the cash-out vacated (its seat row in the same
--    original transaction, carrying exactly the cashed-out stack) traced by
--    fn_cash_original_funding_lineage through its move receipts to one buy-in.
--    One more (59.70, 2026-09-27 21:53): a pending add-on returned unapplied
--    by the hand's post-commit obligations. atomic_distribute_rake had already
--    set that transaction's ledger context, so the wallet credit was audited
--    as 'player_funding' under the rake settlement. It is accepted only when
--    the application receipt of the same transaction records exactly that
--    refund from a funding receipt of the same player, club and table.
--  * accepted_cash_original_scope_missing (7 hands, 4 on Midway, rake 8.11):
--    the engine lost the manifest id (captureCashHandProvenance threw after
--    the database committed the manifest; fixed in the same change: the
--    identical, idempotent request is asked again), so the signed stacks carry
--    no funding_manifest_id and the outcome was recognized with no scope.
--    union_pnl_cash_outcome_link_resolutions re-prove each such hand: roster
--    from its manifest matched seat by seat to the signed stacks (or, where no
--    manifest was captured, each seat's own inventory row at the deal), scope
--    from the table's inventory row at the hand, owners from funding lineage,
--    conservation as for every hand; hash-bound to the immutable outcome.
--  * 13 satellite qualifiers (41 events) and a 342.37 award: the entry is the
--    satellite's award (a seat delivered to the registration, or an
--    entry-only ticket redeemed at the moment it registered), owned by the one
--    club whose posted ledger debit funded that player's satellite entry.
-- The report counts linked hands in the Union their re-proved scope names and
-- accepts the rest only through these proofs; everything else is unchanged.
--
-- Native qualification: scripts/dev/test-union-pnl-flow-scope-seat.sh
-- (green + RED=1 control); server: cashHandProvenance.test.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'cfc23476884e4537f47433e65122e5dd' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_evidence_report is not 20260928230637 (#5554)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '5c4d8cb079d19fe08536afd7067b7617' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_original_flow_evidence is not the live definition' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '0e1fb7d6826b5a95ce5e637174017ede' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_boundary is not 20260928222109 (#5552)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_award_owner_resolved(tournament_accounting_credit_receipts,uuid,timestamp with time zone,uuid[])'::regprocedure)) IS DISTINCT FROM '639b5a724967f7779f8134275c93dfa1' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_award_owner_resolved is not 20260928230637 (#5554)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)) IS DISTINCT FROM 'a7d96d1627656a46fabe9dba751314c8' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_cash_original_funding_lineage is not the live definition' USING ERRCODE='55000'; END IF;
  IF to_regclass('public.union_pnl_cash_outcome_link_resolutions') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_prove_cash_outcome_links(timestamp with time zone,timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'preimage mismatch: link or satellite objects already exist' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_opening_registration_resolutions') IS NULL THEN
    RAISE EXCEPTION 'preimage mismatch: 20260928222109 (#5552) is required' USING ERRCODE='55000';
  END IF;
END $pre$;

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

CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb:='[]'; v_clubs jsonb; v_eco jsonb; v_terms jsonb;
 v_fence timestamptz; v_bad bigint; v_hands bigint; v_resolved bigint:=0; v_rows bigint; v_cash_reconciled boolean; v_terms_value jsonb; v_cash_rake numeric; v_accepted_rake numeric;
 v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb; v_open_resolved uuid[];
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<>public.fn_union_week_start(p_start) OR p_end<>public.fn_union_week_start(p_start+interval '8 days')
  OR p_end>clock_timestamp() THEN RAISE EXCEPTION 'invalid_closed_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT captured_at INTO v_fence FROM public.union_pnl_weekly_capture WHERE singleton;
 IF v_fence IS NULL OR p_start<=v_fence THEN
  RETURN jsonb_build_object('report_version',1,'status','blocked','basis_certified',false,'payment_authorized',false,
   'issues',jsonb_build_array('week_precedes_complete_original_capture'),'capture_started_at',v_fence,'all_players_included',false);
 END IF;
 -- UNION P&L EVIDENCE MEMO (20260928): one weekly close reaches this report
 -- through preparation (close quality), the cascade (qualified clubs, ECO,
 -- player P&L) and the invoices. Inside a union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin)
 -- the first complete report of this (union, week) is kept for the rest of
 -- the attempt; attempt_begin and attempt_end clear it and a rolled-back
 -- subtransaction forgets it with its settings. Everywhere else the report is
 -- proved on every call, exactly as before.
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  v_memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  v_memo:=NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb;
  IF v_memo ? v_memo_key THEN RETURN v_memo->v_memo_key; END IF;
 END IF;
 -- Both readers wait for the original book's in-flight transactions; this
 -- function is VOLATILE so every subsequent query sees their committed facts.
 v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
 v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
 IF v_open->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','opening_basis_incomplete','evidence',v_open)); END IF;
 IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;
 -- The registrations the opening boundary carried through a valid opening
 -- resolution (union_pnl_opening_registration_resolutions): each one's
 -- original entry is proved from the posted chip ledger, not a funding receipt.
 v_open_resolved:=ARRAY(SELECT (x->>'source_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  WHERE x->>'kind'='deferred_tournament_result' AND x->>'basis'='opening_registration_resolution');
 -- A blocked outcome counts as accepted only through an immutable resolution
 -- receipt re-proved from primary receipts and bound to this exact outcome
 -- (hand, payload hash, evidence). The outcome row itself is never changed.
 -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: count those through the partial index
 -- union_pnl_cash_outcomes_unaccepted, whose predicate is the last clause here.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
 -- A hand whose provenance link the engine never recorded (its outcome has no
 -- game scope) counts only through its immutable link resolution
 -- (union_pnl_cash_outcome_link_resolutions), in the Union its re-proved scope
 -- names, and is accepted only when its re-proved evidence is certified.
 SELECT v_bad+count(*) FILTER(WHERE NOT (k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)),
  v_resolved+count(*) FILTER(WHERE k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)
 INTO v_bad,v_resolved FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;
 -- A missing original game scope cannot silently disappear from every Union.
 SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale']
  AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes));
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_original_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.union_pnl_original_flows WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_participant_funding_receipts WHERE recorded_at>=v_fence AND recorded_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_funding_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_funding_application_receipts WHERE applied_at>=v_fence AND applied_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_application_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_hand_provenance_receipts WHERE accepted_at>=v_fence AND accepted_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_hand_transaction_identity_missing'); END IF;
 -- The flow proof is read once; the P&L below reuses these exact rows.
 SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_basis_incomplete','count',v_bad)); END IF;
 -- Every touched tournament registration must have its original chip entry,
 -- including zero-rake players. Historical/current membership is never used.
 -- The week's registration events, each touched tournament's Union proved
 -- once through its own events (t.row_id::text equality kept; the uuid
 -- equality only lets the index find the same rows and is never attempted on
 -- a non-canonical id). The frame test is unchanged; i.observed_at repeats it
 -- because fn_union_pnl_inventory_observe, the only writer of framed events,
 -- stamps each event with its frame's observed_at (both tables immutable), so
 -- the same rows are reached through union_pnl_inventory_events_players_observed.
 WITH touched AS MATERIALIZED (
  SELECT i.row_id,COALESCE(i.after_row,i.before_row)->>'tournament_id' tournament_id
  FROM public.union_pnl_inventory_events i
  JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
  WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
   AND i.observed_at>=p_start AND i.observed_at<p_end
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
    AND t.row_id=CASE WHEN d.tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN d.tournament_id::uuid END
    AND t.row_id::text=d.tournament_id
    AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club(r) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)
  OR COALESCE(e.has_other,false);
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_original_population_or_instrument_incomplete','count',v_bad)); END IF;
 -- An award must return to the original funding club; a changed credited
 -- wallet does not prove a new earning ownership agreement.
 SELECT count(*) INTO v_bad FROM public.tournament_accounting_credit_receipts c
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 WHERE c.tournament_snapshot->>'union_id'=p_union_id::text AND b.observed_at>=p_start AND b.observed_at<p_end
  AND (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id))
  AND NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved)
  AND NOT public.fn_union_pnl_award_satellite_owner(c);
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_award_original_earning_owner_incomplete','count',v_bad)); END IF;
 v_eco:=public.fn_union_eco_terms_evidence(p_union_id,p_start,p_end);
 IF v_eco->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','eco_commercial_basis_incomplete','evidence',v_eco)); END IF;
 SELECT count(DISTINCT x->'terms') INTO v_bad FROM jsonb_array_elements(COALESCE(v_eco->'segments','[]')) x;
 IF v_bad<>1 THEN v_issues:=v_issues||jsonb_build_array('eco_intraweek_changed_terms_require_original_allocation'); END IF;
 v_terms_value:=v_eco#>'{segments,0,terms}';
 -- Validate every original bank/source leg even when the week has no rows.
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
 WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)
  AS f(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)),
 -- One read of the week's hands: each (club, player) delta total, and (kind 0)
 -- the hand count and accepted rake that used to cost two more reads.
 outcome_pass AS MATERIALIZED (
  SELECT x.kind,x.club_id,x.user_id,sum(x.delta) delta,count(*) hands,sum(x.rake) rake
  FROM (SELECT o.evidence FROM public.union_pnl_cash_outcomes o
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   -- with this Union's linked hands, through their link resolutions
   UNION ALL SELECT k.evidence FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k) o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,(o.evidence->>'accepted_rake')::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p) x
  GROUP BY x.kind,x.club_id,x.user_id
 ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1), opening AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x GROUP BY 1),
 closing AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x GROUP BY 1),
 -- The canonical payout basis excludes retained Union-house rake. Gross
 -- original rake still belongs in the all-player P&L and bank reconciliation.
 rake AS MATERIALIZED (
  SELECT s.club_id,sum(s.rake_credit) generated,COALESCE(k.earned,0) earned,
   sum(s.rake_credit) FILTER(WHERE s.source_type='cash_rake_accrual') cash_rake,
   sum(s.rake_credit) FILTER(WHERE s.source_type='tournament_fee_accrual') tournament_rake
  FROM public.accounting_payable_earning_sources s
  LEFT JOIN (SELECT club_id,sum(payout) earned FROM public.fn_union_club_rake_basis(p_union_id,p_start,p_end) GROUP BY club_id) k ON k.club_id=s.club_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end GROUP BY s.club_id,k.earned
 ),
 roster AS (
  SELECT DISTINCT (COALESCE(after_row,before_row)->>'club_id')::uuid club_id FROM public.union_pnl_inventory_events
   WHERE source_name='union_clubs' AND COALESCE(after_row,before_row)->>'union_id'=p_union_id::text AND observed_at<p_end
    AND (observed_at>=p_start OR row_id::text IN(SELECT x#>>'{row,id}' FROM jsonb_array_elements(COALESCE(v_open#>'{inventory,population,union_clubs}','[]')) x))
  UNION SELECT club_id FROM rake UNION SELECT club_id FROM flows UNION SELECT club_id FROM hand_players UNION SELECT club_id FROM opening UNION SELECT club_id FROM closing
 ), movement AS (SELECT club_id,sum(buyins) buyins,sum(cashouts) cashouts,
  sum(cashouts-buyins) FILTER(WHERE kind IN('cash_funding','cash_return')) cash_flow,
  sum(buyins) FILTER(WHERE kind='cash_funding') cash_buyins,sum(cashouts) FILTER(WHERE kind='cash_return') cash_cashouts FROM flows GROUP BY club_id),
 hands AS (SELECT club_id,sum(delta) delta FROM hand_players GROUP BY club_id),
 people AS (SELECT club_id,count(DISTINCT user_id)::int players FROM(SELECT club_id,user_id FROM flows UNION SELECT club_id,user_id FROM hand_players
  UNION SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')||COALESCE(v_close->'holdings','[]')) x) q GROUP BY club_id),
 club_rows AS (
  SELECT r.club_id,COALESCE(m.buyins,0) buyins,COALESCE(m.cashouts,0) cashouts,COALESCE(m.cash_buyins,0) cash_buyins,COALESCE(m.cash_cashouts,0) cash_cashouts,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0) realized_net,COALESCE(o.amount,0) seated_start,COALESCE(c.amount,0) seated_end,
   COALESCE(o.cash,0) seated_start_cash,COALESCE(c.cash,0) seated_end_cash,
   COALESCE(c.amount,0)-COALESCE(o.amount,0) stack_delta,COALESCE(h.delta,0) cash_player_pnl,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)-COALESCE(h.delta,0) tournament_player_pnl,
   COALESCE(m.cash_flow,0)+COALESCE(c.cash,0)-COALESCE(o.cash,0)=COALESCE(h.delta,0) cash_reconciled,
   COALESCE(p.players,0) players,COALESCE(k.generated,0) rake_paid,COALESCE(k.earned,0) rake_earned,COALESCE(k.cash_rake,0) cash_rake,COALESCE(k.tournament_rake,0) tournament_rake,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)+COALESCE(k.generated,0) net
  FROM roster r LEFT JOIN movement m USING(club_id) LEFT JOIN opening o USING(club_id) LEFT JOIN closing c USING(club_id)
  LEFT JOIN hands h USING(club_id) LEFT JOIN people p USING(club_id) LEFT JOIN rake k USING(club_id)
  WHERE r.club_id IS NOT NULL
 ), player_results AS (
  SELECT club_id,user_id,sum(delta) delta FROM (
   SELECT club_id,user_id,cashouts-buyins delta FROM flows
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,-(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  ) amounts GROUP BY club_id,user_id
 ), wins AS(SELECT club_id,sum(greatest(delta,0)) winnings,sum(greatest(-delta,0)) losses FROM player_results GROUP BY club_id), complete AS (
  SELECT q.*,COALESCE(w.winnings,0) winnings,COALESCE(w.losses,0) losses,
   CASE v_terms_value->>'eco_base_mode'
    WHEN 'club_cash_profit' THEN rake_earned-cash_player_pnl
    WHEN 'net_invoice_position' THEN realized_net+stack_delta+rake_paid+rake_earned
    WHEN 'winnings_plus_rake' THEN realized_net+stack_delta+rake_paid
    WHEN 'winnings_only' THEN realized_net+stack_delta END eco_base
  FROM club_rows q LEFT JOIN wins w USING(club_id)
 ) SELECT COALESCE(jsonb_agg(to_jsonb(q)||jsonb_build_object('eco_amount',CASE WHEN v_terms_value->'eco_enabled'='true'::jsonb
  THEN round(-(v_terms_value->>'eco_rate')::numeric*eco_base,2) ELSE 0 END) ORDER BY club_id),'[]'),
  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0),
  COALESCE((SELECT h.hands FROM outcome_pass h WHERE h.kind=0),0),(SELECT COALESCE(sum(h.rake),0) FROM outcome_pass h WHERE h.kind=0)
  INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake,v_hands,v_accepted_rake FROM complete q;
 IF v_accepted_rake IS DISTINCT FROM v_cash_rake THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_rake_does_not_match_original_earning_and_bank_basis'); END IF;
 IF NOT v_cash_reconciled THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'); END IF;
 v_report:=jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'issues',v_issues,'clubs',v_clubs,'opening_basis',v_open,'closing_basis',v_close,'eco_commercial_terms_evidence',v_eco,
  'accepted_cash_hands',v_hands,'accepted_cash_hands_resolved',v_resolved,'club_count',v_rows,'current_seats_used',false,'current_membership_used',false,
  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');
 IF v_memo_key IS NOT NULL THEN
  PERFORM set_config('app.union_pnl_evidence_memo',(COALESCE(NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb,'{}')
   ||jsonb_build_object(v_memo_key,v_report))::text,true);
 END IF;
 RETURN v_report;
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_satellite_seat_owner(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_prove_cash_outcome_links(timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean) TO service_role;

DO $post$
DECLARE f text;
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts)'::regprocedure)) IS DISTINCT FROM 'df92fab5faa87f191ee85f52ce2c82e6' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM '627c6a7dd232bb8030d5400adf8346f2' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '16dcb8e9165ddd478802f24fbd22cab3' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '0c3a826553e9ef65a03030c3ef78eaaf' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'e242c70ffaa62bfe872f30cf7d0e1a5f' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_prove_cash_outcome_links(timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '6c07b34875e97191e35e0d17706bc672' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_prove_cash_outcome_links(timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean)'::regprocedure)) IS DISTINCT FROM '385f7f4482ba5879e65f4466a22ae18e' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '9f0aff5616730556aa600d1027920433' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_satellite_seat_owner(uuid,uuid)' USING ERRCODE='55000'; END IF;
  FOREACH f IN ARRAY ARRAY['public.fn_union_pnl_satellite_seat_owner(uuid,uuid)', 'public.fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts)', 'public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)', 'public.fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone)', 'public.fn_union_pnl_prove_cash_outcome_links(timestamp with time zone,timestamp with time zone)', 'public.fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean)', 'public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)', 'public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is browser-executable',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_table_privilege('anon','public.union_pnl_cash_outcome_link_resolutions','SELECT')
     OR has_table_privilege('authenticated','public.union_pnl_cash_outcome_link_resolutions','SELECT')
     OR has_table_privilege('service_role','public.union_pnl_cash_outcome_link_resolutions','INSERT') THEN
    RAISE EXCEPTION 'postimage: link resolutions are writable or browser-readable' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.union_pnl_cash_outcome_link_resolutions'::regclass AND tgname='original_pnl_immutable') THEN
    RAISE EXCEPTION 'postimage: link resolutions are not immutable' USING ERRCODE='55000';
  END IF;
  -- No balance column is written here (the money-RPC registry guard's own test).
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)'::regprocedure, 'public.fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts)'::regprocedure, 'public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)'::regprocedure, 'public.fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_union_pnl_prove_cash_outcome_links(timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean)'::regprocedure, 'public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN
    RAISE EXCEPTION 'postimage: a function here writes balances' USING ERRCODE='55000';
  END IF;
END $post$;

COMMIT;
