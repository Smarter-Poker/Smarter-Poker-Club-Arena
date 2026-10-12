"""The money-conservation scan reads every event in one pass (2026-10-03),
qualified in the maintained private PG17 cluster after every earlier
backed-payout qualification.

The installed scan (conservation-scan-before.sql, the live text) is the
oracle: it computes every delta through the scalar, one event at a time. The
successor must return the same report and leave the same alerts for every
window, tolerance and cap, and fn_tournament_conservation_deltas must equal
the scalar for every event in the fixture population. No production identity
is used.
"""
import hashlib
import json
import time


def qualify(context):
    q = context['query']; check = context['check']
    f = context['FIXTURE']; root = context['ROOT']
    pins = json.loads((f/'conservation-set-expectations.json').read_text())
    migration = (root/pins['migration']).read_text()
    before = (f/'conservation-scan-before.sql').read_text()
    deltas = (f/'conservation-set-deltas.sql').read_text()
    assert hashlib.md5(before.encode()).hexdigest() == pins['moneyBeforeMD5'], 'predecessor fixture bytes'
    assert hashlib.md5(deltas.encode()).hexdigest() == pins['deltasDefinitionMD5'], 'set fixture bytes'
    assert deltas.rstrip('\n') + ';' in migration, 'the migration declares the set function verbatim'
    rep = pins['replacement']
    assert before.count(rep['old']) == rep['count'] == 1, 'scan block'
    after = before.replace(rep['old'], rep['new'])
    assert hashlib.md5(after.encode()).hexdigest() == pins['moneyAfterMD5'], 'scan replacement bytes'
    defn = lambda fn: q("SELECT pg_get_functiondef('"+fn+"'::regprocedure);")+'\n'
    assert hashlib.md5(defn('fn_tournament_conservation_delta(uuid)').encode()).hexdigest() == pins['scalarMD5'], \
        'the scalar the set function mirrors is the qualified one'

    # The scan's own columns and the alert columns it reads, which the shared
    # fixture never needed. Every earlier event keeps a buy-in.
    q("""ALTER TABLE tournaments ADD COLUMN buy_in_amount numeric DEFAULT 10, ADD COLUMN buy_in_fee numeric DEFAULT 0;
         ALTER TABLE financial_alerts ADD COLUMN id uuid DEFAULT gen_random_uuid(),
           ADD COLUMN created_at timestamptz DEFAULT clock_timestamp(), ADD COLUMN resolved_at timestamptz;""")
    # Eligibility edges, each one an event the scan must or must not read:
    # cancelled (in), spin (out), free (out), fee only (in), still running
    # inside the 30-minute grace (out), older than every window (out), no end.
    q("""INSERT INTO tournaments(id,name,prize_pool,ended_at,status,variant,buy_in_amount,buy_in_fee) VALUES
      (md5('cs-cancelled')::uuid,'cs-cancelled',0,now()-interval '3 hours','CANCELLED',NULL,10,0),
      (md5('cs-spin')::uuid,'cs-spin',0,now()-interval '3 hours','COMPLETED','spin',10,0),
      (md5('cs-free')::uuid,'cs-free',0,now()-interval '3 hours','COMPLETED',NULL,0,0),
      (md5('cs-fee-only')::uuid,'cs-fee-only',0,now()-interval '3 hours','COMPLETED',NULL,0,2),
      (md5('cs-grace')::uuid,'cs-grace',0,now()-interval '10 minutes','COMPLETED',NULL,10,0),
      (md5('cs-ancient')::uuid,'cs-ancient',0,now()-interval '400 days','COMPLETED',NULL,10,0),
      (md5('cs-no-end')::uuid,'cs-no-end',0,NULL,'COMPLETED',NULL,10,0);
      INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
      SELECT id,'debit','tournament_buyin',37,id FROM tournaments WHERE name LIKE 'cs-%';
      INSERT INTO rake_records(tournament_id,rake_amount,is_tournament) VALUES
      (md5('cs-cancelled')::uuid,0,true),(md5('cs-fee-only')::uuid,2,true),(md5('cs-fee-only')::uuid,1,false);""")
    # Pass 1 material: one open alert whose event now balances (closes), one
    # whose event does not (stays), one naming no event (ignored).
    q("""INSERT INTO financial_alerts(severity,source,message,context) VALUES
      ('warning','fn_tournament_money_conservation','fixture balanced',
        jsonb_build_object('tournament_id',(SELECT id FROM tournaments WHERE name='tf-sat'))),
      ('warning','fn_tournament_money_conservation','fixture still off',
        jsonb_build_object('tournament_id',md5('cs-cancelled')::uuid)),
      ('warning','fn_tournament_money_conservation','fixture no event','{}'::jsonb);""")
    q(before)
    q('REVOKE ALL ON FUNCTION fn_tournament_money_conservation(integer,numeric,integer) FROM PUBLIC,anon,authenticated; '
      'GRANT EXECUTE ON FUNCTION fn_tournament_money_conservation(integer,numeric,integer) TO service_role;')
    check("md5(pg_get_functiondef('fn_tournament_money_conservation(integer,numeric,integer)'::regprocedure))='"+pins['moneyBeforeMD5']+"'",
          'installed predecessor')
    q('ANALYZE;')

    def scan(days, tol, cap):
        # Report (less its clock) and every alert row, then abort the same
        # private transaction so each comparison starts from identical rows.
        out = q('BEGIN; SELECT fn_tournament_money_conservation('+days+','+tol+','+cap+") - 'duration_ms';"+"""
          SELECT jsonb_agg(jsonb_build_object('s',severity,'m',message,'c',context,'r',resolved,'closed',resolved_at IS NOT NULL)
                 ORDER BY message, context::text) FROM financial_alerts; ROLLBACK;""")
        return [json.loads(line) for line in out.splitlines()]

    params = [('45', '1.0', '500'), ('1', '1.0', '200'), ('45', '0.05', '500'), ('2', '0', '500'),
              ('400', '0', '500'), ('0', '1.0', '500'), ('45', '1.0', '1')]
    expected = {p: scan(*p) for p in params}
    first = expected[('45', '1.0', '500')]
    assert first[0]['check_ran'] and first[0]['scanned'] > 1000, 'the oracle scanned the population'
    assert first[0]['flagged'] > 0, 'the population carries real conservation findings'
    assert first[0]['auto_resolved'] == 1, 'pass 1 closes the balanced alert and only it'
    print('backed-payout-conservation-set-oracle-captured')

    catalog = "SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_tournament_money_conservation(integer,numeric,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);"
    before_catalog = q(catalog)
    q('GRANT EXECUTE ON FUNCTION fn_tournament_money_conservation(integer,numeric,integer) TO authenticated;')
    q(migration, 'CONSERVATION_SET_AUTHORITY_CHANGED')
    q('REVOKE EXECUTE ON FUNCTION fn_tournament_money_conservation(integer,numeric,integer) FROM authenticated;')
    q("ALTER FUNCTION fn_tournament_money_conservation(integer,numeric,integer) SET statement_timeout='9s';")
    q(migration, 'CONSERVATION_SET_PREIMAGE_CHANGED')
    q("ALTER FUNCTION fn_tournament_money_conservation(integer,numeric,integer) RESET statement_timeout;")
    q("ALTER FUNCTION fn_tournament_conservation_delta(uuid) SET statement_timeout='9s';")
    q(migration, 'CONSERVATION_SET_PREIMAGE_CHANGED')
    q("ALTER FUNCTION fn_tournament_conservation_delta(uuid) RESET statement_timeout;")
    q(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'conservation rollback'; END $$; COMMIT;"), 'conservation rollback')
    check("md5(pg_get_functiondef('fn_tournament_money_conservation(integer,numeric,integer)'::regprocedure))='"+pins['moneyBeforeMD5']+"'"
          " AND to_regprocedure('fn_tournament_conservation_deltas(timestamptz,timestamptz)') IS NULL", 'conservation transaction rollback')
    q(migration)
    q(migration, 'CONSERVATION_SET_PREIMAGE_CHANGED')
    check("md5(pg_get_functiondef('fn_tournament_money_conservation(integer,numeric,integer)'::regprocedure))='"+pins['moneyAfterMD5']+"'", 'exact successor scan')
    check("md5(pg_get_functiondef('fn_tournament_conservation_deltas(timestamptz,timestamptz)'::regprocedure))='"+pins['deltasDefinitionMD5']+"'", 'exact set function')
    assert defn('fn_tournament_money_conservation(integer,numeric,integer)') == after, 'more than the scan block changed'
    check("md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure))='"+pins['scalarMD5']+"'", 'scalar untouched')
    assert q(catalog) == before_catalog, 'conservation successor changed authority or function identity'

    # Whole population, every event the fixture holds: same set of events as
    # the scan's own predicate, and the same delta as the scalar for each.
    assert q("""SELECT count(*) FROM fn_tournament_conservation_deltas('-infinity','infinity') d
                WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);""") == '0', \
        'conservation whole-population scalar parity'
    assert q("""SELECT count(*) FROM (
                  (SELECT id FROM fn_tournament_conservation_deltas(now()-interval '45 days', now()-interval '30 minutes')
                   EXCEPT ALL
                   SELECT t.id FROM tournaments t WHERE t.status IN ('COMPLETED','CANCELLED')
                     AND t.ended_at > now()-interval '45 days' AND t.ended_at < now()-interval '30 minutes'
                     AND COALESCE(t.variant,'') NOT IN ('spin') AND COALESCE(t.buy_in_amount,0)+COALESCE(t.buy_in_fee,0) > 0)
                  UNION ALL
                  (SELECT t.id FROM tournaments t WHERE t.status IN ('COMPLETED','CANCELLED')
                     AND t.ended_at > now()-interval '45 days' AND t.ended_at < now()-interval '30 minutes'
                     AND COALESCE(t.variant,'') NOT IN ('spin') AND COALESCE(t.buy_in_amount,0)+COALESCE(t.buy_in_fee,0) > 0
                   EXCEPT ALL
                   SELECT id FROM fn_tournament_conservation_deltas(now()-interval '45 days', now()-interval '30 minutes'))) x;""") == '0', \
        'conservation eligibility parity'
    included = q("SELECT string_agg(name, ',' ORDER BY name) FROM fn_tournament_conservation_deltas(now()-interval '45 days', now()-interval '30 minutes') WHERE name LIKE 'cs-%';")
    assert included == 'cs-cancelled,cs-fee-only', 'eligibility edges: '+included
    print('backed-payout-conservation-set-parity-passed')

    for pair, wanted in expected.items():
        got = scan(*pair)
        assert got == wanted, 'conservation scan outcome differs '+str(pair)+' '+json.dumps(got[0])+' vs '+json.dumps(wanted[0])
    for role in ['anon', 'authenticated']:
        q("SELECT count(*) FROM fn_tournament_conservation_deltas(now()-interval '1 day', now());", 'permission denied for function', role=role)
        q('SELECT fn_tournament_money_conservation(1,1.0,1);', 'permission denied for function', role=role)
    q("BEGIN; SELECT count(*) FROM fn_tournament_conservation_deltas(now()-interval '1 day', now()); ROLLBACK;", role='service_role')

    # Identical data, both reads; report the timing, assert only agreement.
    old_read = """SELECT count(*) FROM tournaments t WHERE t.status IN ('COMPLETED','CANCELLED')
      AND t.ended_at > now()-interval '45 days' AND t.ended_at < now()-interval '30 minutes'
      AND COALESCE(t.variant,'') NOT IN ('spin') AND COALESCE(t.buy_in_amount,0)+COALESCE(t.buy_in_fee,0) > 0
      AND abs(fn_tournament_conservation_delta(t.id)) > 1.0;"""
    new_read = "SELECT count(*) FROM fn_tournament_conservation_deltas(now()-interval '45 days', now()-interval '30 minutes') WHERE abs(delta) > 1.0;"
    values = []
    for label, sql in [('scalar per event', old_read), ('one pass', new_read)]:
        start = time.monotonic(); value = q(sql); elapsed = time.monotonic() - start
        values.append(value); print(json.dumps({'conservation_read': label, 'flagged': value, 'seconds': round(elapsed, 3)}))
    assert values[0] == values[1], 'large data flagged mismatch'
    print('backed-payout-conservation-set-native-acceptance-passed')
