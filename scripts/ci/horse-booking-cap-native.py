"""Exercise the original booking trigger in the existing isolated PG owner."""
import concurrent.futures
import re


def verify(root, run, check, uid, migration):
    run('ALTER TABLE tables ADD COLUMN status text DEFAULT \'running\', ADD COLUMN tournament_id uuid; CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,start_time timestamptz); CREATE TABLE tournament_players(id uuid PRIMARY KEY,tournament_id uuid,user_id uuid,status text); CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid,user_id uuid,left_at timestamptz);')
    source=(root/'tests/sql/diamond-concurrency-doors.sql').read_text()
    for name in ['fn_concurrent_game_load','fn_enforce_four_table_limit']:
        match=re.search(r'CREATE OR REPLACE FUNCTION public\.'+name+r'\(.*?\$function\$;',source,re.S)
        if not match:
            raise AssertionError('Missing captured '+name)
        run(match.group(0))
    run((root/'tests/sql/fixtures/horse-booking-cap-before.sql').read_text())
    check('booking cap matches captured live preimage',run("SELECT md5(pg_get_functiondef('fn_enforce_booking_game_cap()'::regprocedure));")=='0770bebd2ce6924626f2c3c947d23038')
    run('CREATE TRIGGER booking_cap BEFORE INSERT OR UPDATE OF status ON tournament_players FOR EACH ROW EXECUTE FUNCTION fn_enforce_booking_game_cap(); CREATE TRIGGER seat_cap BEFORE INSERT ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_table_limit();')
    def seat(label, horse='cap-horse'):
        return "INSERT INTO tables(id) VALUES ('"+uid(label)+"'); INSERT INTO table_seats VALUES ('"+uid('seat-'+label)+"','"+uid(label)+"','"+uid(horse)+"',NULL);"
    def enter(label, horse='cap-horse'):
        return "INSERT INTO tournament_players VALUES ('"+uid('entry-'+label)+"','"+uid(label)+"','"+uid(horse)+"','registered');"
    for label in ['late-before','late-after','race-a','race-b','paid','future']:
        run("INSERT INTO tournaments VALUES ('"+uid(label)+"','"+('REGISTERING' if label=='future' else 'RUNNING')+"',now()+interval '2 hours');")
    for i in range(4):
        run(seat('base-'+str(i)))
    run(enter('late-before'))
    check('preimage admits fifth game through RUNNING bypass',run("SELECT count(*) FROM tournament_players;")=='1')
    run("DELETE FROM tournament_players;")
    run(migration.read_text())
    check('RUNNING late entry refuses before commitment', 'FOUR TABLE LIMIT' in run(enter('late-after'),False))
    check('refusal leaves no registration',run('SELECT count(*) FROM tournament_players;')=='0')
    # Paid admission is still honoured, and registered -> playing is not a new claim.
    run("ALTER TABLE tournament_players DISABLE TRIGGER booking_cap;"+enter('paid')+"ALTER TABLE tournament_players ENABLE TRIGGER booking_cap;")
    run("UPDATE tournament_players SET status='playing'; INSERT INTO tables(id,tournament_id) VALUES ('"+uid('paid-table')+"','"+uid('paid')+"'); INSERT INTO table_seats VALUES ('"+uid('paid-seat')+"','"+uid('paid-table')+"','"+uid('cap-horse')+"',NULL);")
    check('already paid entry and status transition retain their chair',run("SELECT count(*) FROM table_seats WHERE user_id='"+uid('cap-horse')+"';")=='5')
    for i in range(3):
        run(seat('race-base-'+str(i),'race-horse'))
    def race(label):
        # The actual registration transaction creates its roster then late seat
        # under the same reentrant table_cap lock. Sleep holds only local fixtures.
        sql='BEGIN;'+enter(label,'race-horse')+"SELECT pg_sleep(.15); INSERT INTO tables(id,tournament_id) VALUES ('"+uid('table-'+label)+"','"+uid(label)+"'); INSERT INTO table_seats VALUES ('"+uid('seat-'+label)+"','"+uid('table-'+label)+"','"+uid('race-horse')+"',NULL); COMMIT;"
        return run(sql,None)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(race,['race-a','race-b']))
    check('concurrent late registrations admit exactly one fourth game',sum(r.returncode==0 for r in results)==1 and sum('FOUR TABLE LIMIT' in r.stderr for r in results)==1)
    check('concurrent refusal rolls back roster and chair',run("SELECT count(*) FROM table_seats WHERE user_id='"+uid('race-horse')+"';")=='4')
    run(enter('future','future-horse'))
    check('advance future booking preserves one-hour load policy',run("SELECT fn_concurrent_game_load('"+uid('future-horse')+"');")=='0')
