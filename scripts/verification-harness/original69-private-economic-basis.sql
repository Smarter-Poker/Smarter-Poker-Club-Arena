-- PRIVATE configured MCP postgres read-only basis, NOT an Actions artifact.
-- Do not execute before the original owner establishes actual containing seal,
-- healthy own thaw and original69 quiescence. This is not the financial probe.
-- Replace NULL with exactly one allowlisted original69 UUID; no broad cohort read.
-- Authority: immutable original entitlement components / original Diamond charges,
-- as consumed unchanged by the canonical started-event abort. No new payer/formula.
WITH parameters AS (
 SELECT NULL::uuid AS tournament_id,
 'd44c4440-2911-430c-8ee7-376611ef3f38'::uuid AS operation_id
), original_basis AS (
 SELECT p.tournament_id,smarter_private.original69_probe_economics(p.tournament_id,NULL) AS economics
 FROM parameters p WHERE p.tournament_id IS NOT NULL
 AND smarter_private.original69_probe_member(p.tournament_id)
 AND EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets a
  WHERE a.operation_id=p.operation_id AND a.tournament_id=p.tournament_id AND a.state='quiesced')
)
SELECT jsonb_build_object(
 'tournament_id',b.tournament_id,
 'canonical_md5',md5(pg_get_functiondef('public.fn_ca_settle_tournament_abort(uuid,uuid,text)'::regprocedure)),
 'money_hash',(SELECT a.quiescence->>'money_hash' FROM smarter_private.tournament_abort_targets a
  WHERE a.tournament_id=b.tournament_id AND a.operation_id='d44c4440-2911-430c-8ee7-376611ef3f38'),
 'economic_sha256',encode(sha256(convert_to(b.economics::text,'UTF8')),'hex'),
 'original_per_player_economics',b.economics,
 'player_names',(SELECT jsonb_agg(jsonb_build_object('user_id',p.id,'full_name',to_jsonb(p)->'full_name','poker_alias',to_jsonb(p)->'poker_alias') ORDER BY p.id)
  FROM public.profiles p WHERE p.id IN(SELECT (j->>'user_id')::uuid FROM jsonb_array_elements(b.economics) j)),
 'original_chip_entitlements',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.user_id,e.id)
  FROM public.tournament_refund_entitlements e WHERE e.tournament_id=b.tournament_id),
 'original_chip_debits',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.chip_ledger l
  WHERE l.id IN(SELECT e.source_ledger_id FROM public.tournament_refund_entitlements e WHERE e.tournament_id=b.tournament_id)),
 'original_diamond_charges',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.user_id,c.id)
  FROM public.poker_diamond_tournament_ledger c WHERE c.tournament_id=b.tournament_id AND c.kind IN('entry','rebuy','reentry','addon')),
 'fee_sources',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.rake_records r
  WHERE r.tournament_id=b.tournament_id AND r.is_tournament),
 'prior_awards',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.tournament_obligations o
  WHERE o.tournament_id=b.tournament_id AND o.kind<>'refund')
) AS private_original69_basis
FROM original_basis b;
