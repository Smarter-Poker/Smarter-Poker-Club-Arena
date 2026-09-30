-- LOCAL SYNTHETIC AGREEMENTS ONLY. Run after the maintained Early Bird phase has
-- produced its honest fee-custody terminal. Each observation is dated one minute
-- BEFORE that event's recorded completion and long AFTER its original charges,
-- which is exactly the production shape: agreements recorded at completion,
-- none at the charge instant. Nothing here is historical production evidence.
BEGIN;
SELECT held_fee_fixture.assert((SELECT accounting_state='fee_custody_unresolved' AND rake_amount=2.70 FROM public.tournament_terminal_settlements WHERE tournament_id=held_fee_fixture.event())
 AND (SELECT fee_balance=2.70 FROM public.tournament_escrow WHERE tournament_id=held_fee_fixture.event())
 AND NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.club_id IN(SELECT club_id FROM held_fee_fixture.contributors)),
 'Opening scene is the honest held Early Bird fee with no recorded agreement');
SET LOCAL session_replication_role=replica;
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,event_type,observed_at,after_terms)
 SELECT 'union_clubs',md5('held-fee-union-club:'||c.club_id)::uuid::text,c.club_id,'baseline',held_fee_fixture.terms_at(),
  jsonb_build_object('id',md5('held-fee-union-club:'||c.club_id)::uuid,'union_id',held_fee_fixture.union_id(),'club_id',c.club_id,
   'club_commission_rate',0.5,'rate_cash',0.5,'rate_mtt',0.6,'rate_sng',0.5,'rate_spin',0.5,'rate_satellite',0.5)
 FROM (SELECT DISTINCT club_id FROM held_fee_fixture.contributors) c;
-- One recorded agent in the first contributor club; its first member reports to it.
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 SELECT 'agents',held_fee_fixture.agent_id()::text,a.club_id,a.user_id,'baseline',held_fee_fixture.terms_at(),
  jsonb_build_object('id',held_fee_fixture.agent_id(),'role','agent','status','active','club_id',a.club_id,'user_id',a.user_id,
   'is_prepaid',false,'commission_rate',0.3,'parent_agent_id',NULL,'player_rakeback_rate',0.1)
 FROM held_fee_fixture.agent a;
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 SELECT 'club_members',m.club_id::text||':'||m.user_id::text,m.club_id,m.user_id,'baseline',held_fee_fixture.terms_at(),
  to_jsonb(m)||CASE WHEN m.user_id=(SELECT agent_member FROM held_fee_fixture.agent) THEN jsonb_build_object('agent_id',(SELECT user_id FROM held_fee_fixture.agent)) ELSE '{}'::jsonb END
 FROM public.club_members m WHERE EXISTS(SELECT 1 FROM held_fee_fixture.contributors c WHERE c.club_id=m.club_id AND c.user_id=m.user_id);
SET LOCAL session_replication_role=origin;
COMMIT;
SELECT held_fee_fixture.assert((SELECT count(*) FROM public.accounting_agreement_history WHERE entity_type='club_members'
  AND club_id IN(SELECT club_id FROM held_fee_fixture.contributors))=(SELECT count(DISTINCT (club_id,user_id)) FROM held_fee_fixture.contributors)
 AND NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN held_fee_fixture.contributors c ON c.club_id=h.club_id WHERE h.observed_at<=c.charged_at)
 AND (SELECT bool_and(h.observed_at<=t.completed_at) FROM public.accounting_agreement_history h,public.tournament_terminal_settlements t
   WHERE t.tournament_id=held_fee_fixture.event() AND h.club_id IN(SELECT club_id FROM held_fee_fixture.contributors)),
 'Synthetic agreements exist at completion for every contributor and none at any charge instant');
