\set ON_ERROR_STOP 1
BEGIN;  -- run only after ruling_c1f15c30.sql has committed; independent transaction
-- OPTIONAL: record (not pay) the make-good owed under true bust order, v3 ladder basis. status 'proposed' moves nothing.
INSERT INTO public.ca_manual_adjustments
  (actor, actor_label, reason, amount, target_kind, target_id, tournament_id, status, asset)
SELECT '00000000-0000-0000-0000-00000000c1a9'::uuid, 'tournament ruling c1f15c30 (agent)',
       format('Breakfast Turbo c1f15c30 make-good: %s finished %s in true bust order (bust hand %s) but the paid record '
              || 'gave that place to another entrant; under the six-place v3 ladder the place pays %s. Paid money is not '
              || 'clawed back; this is house-funded make-good awaiting approval. Entrant is a horse (profiles.is_horse).',
              x.uid, x.true_place, x.hand, x.owed),
       x.owed, 'player_wallet', x.uid, 'c1f15c30-33c4-4a64-85ac-44037519ca5b'::uuid, 'proposed', 'chips'
  FROM (VALUES ('1c0dee1e-8ab9-4d42-897e-e1dd6da9f4be'::uuid, 2, 8215053, 42.16),
               ('c6dc3bfa-d9dd-4174-9704-d4a0a285f876'::uuid, 3, 8214451, 30.35),
               ('00000000-0000-0000-0000-000000000025'::uuid, 4, 8214314, 21.85),
               ('2d6c5e7a-7352-4d1d-aecf-c5237d626e3d'::uuid, 5, 8213802, 15.73),
               ('165df98e-f59d-46aa-bc74-a974c0ded83f'::uuid, 6, 8213440, 11.36)) AS x(uid, true_place, hand, owed)
 WHERE NOT EXISTS (SELECT 1 FROM public.ca_manual_adjustments a
                    WHERE a.tournament_id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b' AND a.target_id = x.uid);
SELECT count(*), sum(amount) FROM public.ca_manual_adjustments WHERE tournament_id='c1f15c30-33c4-4a64-85ac-44037519ca5b' AND status='proposed';
COMMIT;
