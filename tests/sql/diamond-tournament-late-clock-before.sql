-- Owned private PostgreSQL scene only. Keep production financial probes out.
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'late_legacy',public.fn_poker_diamond_spawn_scheduled_tournament(
 sched.id('sched'),date_trunc('hour',now())+interval '8 days',
 sched.cfg('{"name":"Legacy twelve-level clock","lateRegistrationLevels":12}'));
RESET ROLE;
INSERT INTO sched.ids SELECT 'late_legacy',(sched.r('late_legacy')->>'tournament_id')::uuid;
SELECT sched.ok((SELECT late_reg_levels=12 AND late_reg_mins=8 FROM public.tournaments
 WHERE id=sched.id('late_legacy')),'preimage: the actual Diamond creator writes twelve levels but eight minutes');
SELECT sched.as_user(sched.p(8));
SET ROLE authenticated;
INSERT INTO sched.res SELECT 'late_registration',public.fn_register_for_tournament_request(sched.id('late_legacy'),gen_random_uuid());
RESET ROLE;
SELECT sched.ok((sched.r('late_registration')->>'ok')::boolean,
 'the legacy clock correction must preserve a real accepted funded entry');
CREATE TABLE sched.late_preserved AS SELECT id,late_reg_levels,late_reg_mins
 FROM public.tournaments WHERE status IN ('CANCELLED','COMPLETED') OR prize_pool_finalized;
SELECT sched.ok(EXISTS(SELECT 1 FROM sched.late_preserved),'preservation witness includes an actual closed event');
