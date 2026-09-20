-- ISOLATED SYNTHETIC TERM RESTORATION ONLY. These agreements have no production
-- historical authority. Original financial records and standings remain exact.
BEGIN;
SELECT sep8_spin_fixture.assert(inet_server_addr() IS NULL
 AND (SELECT count(*)=5 FROM public.tournament_terminal_settlements JOIN sep8_spin_fixture.cases USING(tournament_id)),
 'Synthetic original agreement restoration only follows five real local terminals');
SET LOCAL session_replication_role=replica;
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 SELECT 'club_members',m.club_id::text||':'||m.user_id,m.club_id,m.user_id,'baseline','2026-09-01T00:00:00Z'::timestamptz,to_jsonb(m)
 FROM public.club_members m WHERE EXISTS(SELECT 1 FROM public.tournament_players p JOIN sep8_spin_fixture.cases c USING(tournament_id) WHERE p.club_id=m.club_id AND p.user_id=m.user_id);
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,event_type,observed_at,after_terms)
 SELECT 'union_clubs',md5('sep8-local-union:'||p.club_id::text)::uuid::text,p.club_id,'baseline','2026-09-01T00:00:00Z'::timestamptz,
 jsonb_build_object('id',md5('sep8-local-union:'||p.club_id::text)::uuid,'club_id',p.club_id,'union_id',c.union_id,
 'joined_at','2026-09-01T00:00:00Z','club_commission_rate',0.8,'rate_spin',0.8)
 FROM sep8_spin_fixture.cases c JOIN public.tournament_players p USING(tournament_id) WHERE c.union_id IS NOT NULL GROUP BY p.club_id,c.union_id;
SET LOCAL session_replication_role=origin;
COMMIT;
