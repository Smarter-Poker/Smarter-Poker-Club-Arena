-- BEFORE the migration: the captured live bodies reproduce the defect.
-- Eight players, 5.00 heads, pool 40.00 (mystery half 20.00). A-D busted and
-- were paid before activation (20.00). E busted before activation but the claim
-- is not recorded yet. The seed runs with F, G, H left (two chests).
DO $$
DECLARE
  t uuid; r jsonb; o record;
  A uuid:='a0000000-0000-4000-8000-00000000000a'; B uuid:='a0000000-0000-4000-8000-00000000000b';
  C uuid:='a0000000-0000-4000-8000-00000000000c'; D uuid:='a0000000-0000-4000-8000-00000000000d';
  E uuid:='a0000000-0000-4000-8000-00000000000e'; F uuid:='a0000000-0000-4000-8000-00000000000f';
  G uuid:='a0000000-0000-4000-8000-000000000001'; H uuid:='a0000000-0000-4000-8000-000000000002';
BEGIN
  t := public.fixture_event('before', ARRAY[A,B,C,D,E,F,G,H]::text[], 5.00);
  PERFORM public.fixture_paid_head(t,A,H,8); PERFORM public.fixture_paid_head(t,B,H,7);
  PERFORM public.fixture_paid_head(t,C,H,6); PERFORM public.fixture_paid_head(t,D,H,5);
  PERFORM public.fixture_bust(t,E,F,2000001,clock_timestamp()-interval '10 minutes');
  -- the old seed sweeps E's unrecorded 5.00 head into the chests
  r := public.fn_mystery_bounty_seed(t,3,public.fixture_chests(ARRAY[1200,800]::bigint[]));
  PERFORM public.fixture_assert((r->>'ok')::boolean AND (r->>'pool_cents')::bigint=2000,
    'before: seed seals 2000c although 500c of it is an unrecorded pre-activation head: '||r::text);
  r := public.fixture_claim(t,E,F,4);
  SELECT * INTO o FROM public.tournament_bounty_obligations WHERE tournament_id=t AND eliminated_user_id=E;
  PERFORM public.fixture_assert(o.mode='mystery_chest' AND o.activation_generation=1,
    'before: a bust played BEFORE activation is recorded as mystery_chest (the defect): '||r::text);
  -- and a correctly-moded pre-activation obligation could not be collected either
  UPDATE public.tournament_bounty_obligations SET mode='mystery_pre',activation_generation=0 WHERE id=o.id;
  r := public.fn_collect_bounty_obligation(o.id);
  PERFORM public.fixture_assert(r->>'reason'='mystery_phase_active',
    'before: fn_collect_bounty refuses a mystery_pre head while the stage is active: '||r::text);
END $$;
