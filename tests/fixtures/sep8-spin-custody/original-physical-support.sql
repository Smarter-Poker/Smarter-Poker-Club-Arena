-- Isolated account shells only. The recorded seats retain their original club
-- identities even where those differ from the original paid registration club.
-- No funding, commission history, wallet balance or physical evidence changes.
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury)
 SELECT original_club,999830+row_number() OVER(ORDER BY original_club),
 'Local Original Physical Club '||original_club,'10000000-0000-0000-0000-000000000001'::uuid,0
 FROM(SELECT DISTINCT (s->>'club_id')::uuid original_club FROM sep8_spin_fixture.cases c,
 jsonb_array_elements(smarter_private.spin_original_retained_case(c.tournament_id)->'seats') s
 WHERE s->>'club_id' IS NOT NULL) original
 WHERE NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=original_club);
SET LOCAL session_replication_role=origin;
COMMIT;
