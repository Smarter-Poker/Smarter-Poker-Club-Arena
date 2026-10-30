"""Full retained fee reader against private native semantic table adapters.

No production connection. Existing physical MTT-index cases run separately.
Adapters supply only columns read here, not production triggers/settlements.
"""
import json


def qualify(q, reader, migration, cases, plans, semantics):
    q("CREATE TABLE ca_launch_accounting_boundaries(scope_kind text,scope_id uuid,cutoff_at timestamptz,undone_at timestamptz);"
      "CREATE FUNCTION fn_ca_fee_counting_start() RETURNS date LANGUAGE sql STABLE AS $$SELECT '2026-01-01'::date$$;"
      "CREATE TABLE ca_club_rake_daily_user(club_id uuid,user_id uuid,day date,rake_cents numeric);"
      "CREATE TABLE ca_club_member_tournament_fee_daily(club_id uuid,user_id uuid,day date,fees numeric);"
      "CREATE TABLE rake_records(id uuid PRIMARY KEY,created_at timestamptz);"
      "CREATE TABLE rake_attributions(club_id uuid,player_id uuid,rake_record_id uuid,created_at timestamptz,rake_amount numeric);"
      "CREATE TABLE smarter_private.player_rake_share_rules(rule_key text,club_id uuid,from_user uuid,to_user uuid,share_bps integer,effective_from timestamptz,effective_until timestamptz);"
      "CREATE TABLE smarter_private.player_fee_redemptions(user_id uuid,club_id uuid,effective_on date,amount_cents numeric);")
    for source in semantics:
        q(source['definition'])
        roles = 'authenticated,service_role' if 'accepts' in source['signature'] else 'service_role'
        q('REVOKE ALL ON FUNCTION '+source['signature']+' FROM PUBLIC;GRANT EXECUTE ON FUNCTION '+source['signature']+' TO '+roles+';')
    q("INSERT INTO rake_records SELECT md5('rr-'||g)::uuid,(ARRAY[NULL,'2026-10-26 00:00Z','2026-10-27 00:00Z','infinity','-infinity','2026-10-26 05:00Z']::timestamptz[])[g] FROM generate_series(1,6)g;"
      "INSERT INTO rake_attributions SELECT md5('club')::uuid,md5('player-'||(g%101))::uuid,md5('rr-'||(g%7+1))::uuid,'2026-10-26 01:00Z'::timestamptz+(g%3)*interval '1 day',0.015+(g%5)/100.0 FROM generate_series(1,707)g;"
      "INSERT INTO rake_attributions VALUES(md5('club')::uuid,md5('player-0')::uuid,NULL,'2026-10-30 20:00Z',0.01),(md5('other-club')::uuid,md5('player-0')::uuid,NULL,'2026-10-26 01:00Z',9);"
      "INSERT INTO smarter_private.player_rake_share_rules VALUES('out',md5('club')::uuid,md5('player-0')::uuid,md5('player-1')::uuid,3333,'2026-10-26Z',NULL),('incoming',md5('club')::uuid,md5('player-100')::uuid,md5('player-0')::uuid,7777,'2026-10-26Z',NULL);"
      "INSERT INTO ca_club_rake_daily_user SELECT md5('club')::uuid,md5('player-'||g)::uuid,'2026-10-26',101+g FROM generate_series(0,99)g;"
      "INSERT INTO ca_club_member_tournament_fee_daily VALUES(md5('club')::uuid,md5('player-0')::uuid,'2026-10-26',1.23);"
      "INSERT INTO smarter_private.player_fee_redemptions VALUES(md5('player-0')::uuid,md5('club')::uuid,'2026-10-27',17);")
    q('REVOKE ALL ON FUNCTION ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz) TO authenticated,service_role;')
    query = "SELECT user_id,total_fees FROM ca_club_member_period_fee_totals(md5('club')::uuid,ARRAY(SELECT md5('player-'||g)::uuid FROM generate_series(0,99)g),'2026-10-26','2026-10-30 15:00Z')ORDER BY user_id"
    cutoffs = [None, '2026-10-26 00:00Z', '2026-10-27 00:00Z', 'infinity', '-infinity']
    original = []

    def boundary(cutoff):
        q('TRUNCATE ca_launch_accounting_boundaries;')
        if cutoff is not None:
            q("INSERT INTO ca_launch_accounting_boundaries VALUES('club',md5('club')::uuid,'"+cutoff+"',NULL);")

    for cutoff in cutoffs:
        boundary(cutoff)
        result = q(query)
        assert len(result.splitlines()) == 100
        original.append(result)
    changed = next(source['definition'] for source in semantics if 'accepts' in source['signature']).replace('p_earned_at>=b.cutoff', 'p_earned_at>b.cutoff')
    assert changed != next(source['definition'] for source in semantics if 'accepts' in source['signature'])
    q('BEGIN;'+changed+ ';'+migration, 'semantics_changed')
    # Exact guarded migration, not a separately reconstructed candidate.
    q(migration)
    after = q("SELECT pg_get_functiondef('ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz)'::regprocedure)")
    assert 'b AS MATERIALIZED' in after and after.count("fn_ca_launch_accounting_cutoff('club',p_club_id)") == 1
    assert 'fn_ca_launch_accounting_accepts' not in after
    for cutoff, expected in zip(cutoffs, original):
        boundary(cutoff)
        assert q(query) == expected
    expanded = after.split('AS $function$\n', 1)[1].split('\n$function$', 1)[0]
    expanded = expanded.replace('p_club_id', "md5('club')::uuid").replace('p_user_ids', "ARRAY(SELECT md5('player-'||g)::uuid FROM generate_series(0,99)g)").replace('p_from', "'2026-10-26'::date").replace('p_until', "'2026-10-30 15:00Z'::timestamptz")
    plan = json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+expanded))
    def nodes(node):
        yield node
        for child in node.get('Plans', []):
            yield from nodes(child)
    bound = [node for node in nodes(plan[0]['Plan']) if node.get('Subplan Name') == 'CTE b']
    assert len(bound) == 1 and bound[0]['Actual Loops'] == 1 and bound[0]['Actual Rows'] == 1
    plans.append(plan)
    cases.append('full_fee_reader_100_members_null_finite_infinite_cutoff_missing_nonfinite_earned_share_rounding_equal')
    assert q("SELECT has_function_privilege('anon','ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz)','EXECUTE')") == 'f'
    assert q("SELECT has_function_privilege('authenticated','ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz)','EXECUTE')") == 't'
    q(migration, 'reader_changed')
    # Freeze refuses before reader rewrite; rollback leaves actual postimage.
    q("BEGIN;SET LOCAL native.frozen='on';" + migration, 'window_refused')
    assert q("SELECT pg_get_functiondef('ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz)'::regprocedure)") == after
    cases.append('cutoff_materialized_once_exact_semantics_acl_replay_freeze_guards')
