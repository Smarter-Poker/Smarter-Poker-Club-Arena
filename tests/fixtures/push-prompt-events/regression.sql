-- Push prompt telemetry: players write their own rows and nothing else.
\set member '''00000000-0000-0000-0000-000000000002'''
BEGIN;
SELECT assert_true(as_user('authenticated',:member,$q$INSERT INTO push_prompt_events(surface,event,platform) VALUES('cashier','shown','ios_browser')$q$)='ok','a player records a prompt event');
SELECT assert_true((SELECT count(*)=1 FROM push_prompt_events WHERE user_id='00000000-0000-0000-0000-000000000002' AND surface='cashier' AND event='shown'),'the row is stamped with the caller''s own id');
SELECT assert_true(as_user('authenticated',:member,$q$INSERT INTO push_prompt_events(user_id,surface,event,platform) VALUES('00000000-0000-0000-0000-000000000003','cashier','shown','desktop_web')$q$)='42501','a player cannot write a row for someone else');
SELECT assert_true(as_user('authenticated',:member,$q$INSERT INTO push_prompt_events(surface,event,platform,created_at) VALUES('cashier','shown','desktop_web','2020-01-01')$q$)='42501','a player cannot backdate a row');
SELECT assert_true(as_user('authenticated',:member,$q$SELECT 1 FROM push_prompt_events$q$)='42501','a player cannot read the table');
SELECT assert_true(as_user('authenticated',:member,$q$UPDATE push_prompt_events SET event='accepted'$q$)='42501','a player cannot rewrite an event');
SELECT assert_true(as_user('authenticated',:member,$q$DELETE FROM push_prompt_events$q$)='42501','a player cannot delete events');
SELECT assert_true(as_user('anon',NULL,$q$INSERT INTO push_prompt_events(surface,event,platform) VALUES('cashier','shown','desktop_web')$q$)='42501','anon cannot write');
SELECT assert_true(as_user('authenticated',:member,$q$INSERT INTO push_prompt_events(surface,event,platform) VALUES('cashier','clicked','desktop_web')$q$)='23514','an unknown event is refused');
SELECT assert_true(as_user('authenticated',:member,$q$INSERT INTO push_prompt_events(surface,event,platform,detail) VALUES('cashier','failed','desktop_web','Some Raw Error Message')$q$)='23514','free text never lands in detail');
SELECT assert_true(as_user('authenticated',:member,$q$INSERT INTO push_prompt_events(surface,event,platform) SELECT 'cashier','shown','desktop_web' FROM generate_series(1,250)$q$)='ok','a looping client is not an error');
SELECT assert_true((SELECT count(*)=200 FROM push_prompt_events WHERE user_id='00000000-0000-0000-0000-000000000002'),'a player holds at most 200 rows per 24 hours');
SELECT assert_true(as_user('authenticated',:member,$q$SELECT public.fn_push_prompt_funnel(7)$q$)='42501','a player cannot read the funnel');
SELECT assert_true(as_user('authenticated','00000000-0000-0000-0000-000000000001',$q$SELECT public.fn_push_prompt_funnel(7)$q$)='ok','an admin reads the funnel');
SELECT assert_true(as_user('anon',NULL,$q$SELECT public.fn_push_prompt_funnel(7)$q$)='42501','anon cannot read the funnel');
SELECT assert_true((public.fn_push_prompt_funnel(7)->'totals'->>'shown')::int=200 AND (public.fn_push_prompt_funnel(7)->'people'->>'shown')::int=1,'the funnel counts events and people');
SELECT assert_true((public.fn_push_prompt_funnel(9999)->>'windowDays')::int=90,'the window is bounded');
COMMIT;
