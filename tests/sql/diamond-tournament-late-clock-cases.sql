SELECT sched.ok((SELECT late_reg_levels=12 AND late_reg_mins=120 FROM public.tournaments
 WHERE id=sched.id('late_legacy')),'legacy unfinalized twelve-level event now carries its authored 120-minute clock');
SELECT sched.ok(NOT EXISTS(SELECT 1 FROM sched.late_preserved p JOIN public.tournaments t USING(id)
 WHERE (p.late_reg_levels,p.late_reg_mins) IS DISTINCT FROM (t.late_reg_levels,t.late_reg_mins)),
 'cancelled, completed and finalized windows retain their recorded fields');
DO $cases$ BEGIN
 BEGIN UPDATE public.tournaments SET buy_in_amount=buy_in_amount+1 WHERE id=sched.id('late_legacy');
  RAISE EXCEPTION 'FAIL: clock correction admitted a changed entry price';
 EXCEPTION WHEN raise_exception OR object_not_in_prerequisite_state THEN
  IF SQLERRM<>format('tournament %s economic contract is immutable after its first funded entry',sched.id('late_legacy'))
     AND SQLERRM<>'This tournament cannot be modified after a player has registered' THEN RAISE; END IF;
  PERFORM sched.ok(true,'accepted entry price remains protected after canonical clock correction');END;
 BEGIN UPDATE public.tournaments SET late_reg_mins=121 WHERE id=sched.id('late_legacy');
  RAISE EXCEPTION 'FAIL: clock correction admitted an arbitrary window';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'This tournament cannot be modified after a player has registered' THEN RAISE; END IF;
  PERFORM sched.ok(true,'registered windows refuse arbitrary changes after correction');END;
END $cases$;
SELECT sched.as_service();
UPDATE public.tournaments SET late_reg_mins=8 WHERE id=sched.id('late_legacy');
SELECT sched.as_user(sched.p(8));
SET ROLE authenticated;
DO $role_boundary$ BEGIN
 BEGIN
  UPDATE public.tournaments SET late_reg_mins=120 WHERE id=sched.id('late_legacy');
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 WHEN raise_exception THEN
  IF SQLERRM<>'This tournament cannot be modified after a player has registered' THEN RAISE; END IF;
 END;
END $role_boundary$;
RESET ROLE;
SELECT sched.ok((SELECT late_reg_mins=8 FROM public.tournaments WHERE id=sched.id('late_legacy')),
 'an authenticated player cannot use the postgres-only canonical clock exception');
-- The identical correction succeeds for the actual management connection,
-- with no player or engine JWT, exactly as the migration installer runs.
SELECT set_config('request.jwt.claims','{}',false),set_config('request.jwt.claim.sub','',false),
 set_config('request.jwt.claim.role','',false),set_config('request.headers','{}',false);
UPDATE public.tournaments SET late_reg_mins=120 WHERE id=sched.id('late_legacy');
SELECT sched.as_service();
SELECT sched.lock(sched.id('late_legacy'));
UPDATE public.tournaments SET started_at=now()-interval '9 minutes',current_level=0
 WHERE id=sched.id('late_legacy');
SELECT sched.ok(public.fn_tournament_late_registration_open(sched.id('late_legacy')),
 'actual admission stays open after the erroneous eight minutes while both authored bounds remain');
UPDATE public.tournaments SET started_at=now()-interval '120 minutes' WHERE id=sched.id('late_legacy');
SELECT sched.ok(NOT public.fn_tournament_late_registration_open(sched.id('late_legacy')),
 'actual admission closes at its clock deadline even with levels remaining');
UPDATE public.tournaments SET started_at=now(),current_level=12 WHERE id=sched.id('late_legacy');
SELECT sched.ok(NOT public.fn_tournament_late_registration_open(sched.id('late_legacy')),
 'actual admission closes at its level deadline even with clock time remaining');
SELECT sched.ok(public.fn_ca_mtt_late_registration_minutes('[{"durationMinutes":10},{"duration":600}]',12)=120,
 'indexed cutoff extends the last playable duration beyond the ladder');
SELECT sched.ok(public.fn_ca_mtt_late_registration_minutes('[{"durationMinutes":1.1}]',3)=4,
 'fractional authored minutes round upward only after summing');
SELECT sched.ok(public.fn_ca_mtt_late_registration_minutes('[{"durationMinutes":2,"duration":900},{"duration_minutes":3}]',2)=5,
 'minute aliases take precedence over seconds');
SELECT sched.ok(public.fn_ca_mtt_late_registration_minutes('[{"duration":60},{"isBreak":true,"duration":600},{"duration":120}]',3)=3,
 'break markers consume their indexed slot without adding playing minutes');
SELECT sched.ok(public.fn_ca_mtt_late_registration_minutes('[]',0)=0,'an explicit zero window stays zero');
DO $cases$ BEGIN
 BEGIN PERFORM public.fn_ca_mtt_late_registration_minutes('[]',1);RAISE EXCEPTION 'missing ladder admitted';
 EXCEPTION WHEN invalid_parameter_value THEN PERFORM sched.ok(true,'missing playable clock refused');END;
 BEGIN PERFORM public.fn_ca_mtt_late_registration_minutes('[{"duration":0}]',2);RAISE EXCEPTION 'zero clock admitted';
 EXCEPTION WHEN invalid_parameter_value THEN PERFORM sched.ok(true,'zero clock refused');END;
 BEGIN PERFORM public.fn_ca_mtt_late_registration_minutes('[{"durationMinutes":2147483647}]',2);RAISE EXCEPTION 'overflow admitted';
 EXCEPTION WHEN invalid_parameter_value THEN PERFORM sched.ok(true,'integer overflow refused before insertion');END;
END $cases$;
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'late_fixed',public.fn_poker_diamond_spawn_scheduled_tournament(
 sched.id('sched'),date_trunc('hour',now())+interval '9 days',
 sched.cfg('{"name":"Fixed twelve-level clock","lateRegistrationLevels":12}'));
INSERT INTO sched.res SELECT 'late_zero',public.fn_poker_diamond_spawn_scheduled_tournament(
 sched.id('sched'),date_trunc('hour',now())+interval '10 days',
 sched.cfg('{"name":"No late entry","lateRegistrationLevels":0}'));
INSERT INTO sched.res SELECT 'late_sng',public.fn_poker_diamond_spawn_scheduled_tournament(
 sched.id('sched'),date_trunc('hour',now())+interval '11 days',
 sched.cfg('{"name":"Short-format clock","type":"sng","maxPlayers":2,"payoutStructure":[{"place":1,"percentage":100}]}'));
RESET ROLE;
SELECT sched.ok((SELECT late_reg_levels=12 AND late_reg_mins=120 FROM public.tournaments
 WHERE id=(sched.r('late_fixed')->>'tournament_id')::uuid),'the real scheduled creator derives the future twelve-level clock');
SELECT sched.ok((SELECT late_reg_levels=0 AND late_reg_mins=0 FROM public.tournaments
 WHERE id=(sched.r('late_zero')->>'tournament_id')::uuid),'the real scheduled creator preserves explicit no late registration');
SELECT sched.ok((SELECT late_reg_levels=0 AND late_reg_mins=0 FROM public.tournaments
 WHERE id=(sched.r('late_sng')->>'tournament_id')::uuid),'SNG creation cannot open an eight-minute late-entry fallback');
SELECT sched.ok(sched.whole(),'late-clock migration and creation preserve the full Diamond supply and custody identity');
