#!/usr/bin/env python3
"""Qualify the actual clock trigger and migration in an isolated PG17 cluster."""
import json, os, pathlib, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
PG=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}; ENV.update(LC_ALL='C',LANG='C')
CLUSTER=pathlib.Path(tempfile.mkdtemp(prefix='highlighted-clock-'))
PSQL=[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','55784','-U','postgres']
def call(args,sql=None,ok=True):
    r=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=ENV,timeout=60)
    if ok and r.returncode: raise RuntimeError(r.stderr)
    return r

def run(sql): return call(PSQL,sql).stdout.strip()
checks=[]
def check(name,condition):
    if not condition: raise AssertionError(name)
    checks.append(name)
try:
    call([PG/'initdb','-D',CLUSTER/'data','-U','postgres','--auth=trust','--no-locale'])
    call([PG/'pg_ctl','-D',CLUSTER/'data','-l',CLUSTER/'pg.log','-o','-k "" -p 55784 -h 127.0.0.1','-w','start'])
    run('''CREATE TABLE tournaments(id serial,name text,status text DEFAULT 'REGISTERING',tournament_type text DEFAULT 'MTT',variant text DEFAULT 'freezeout',
      buy_in_amount numeric DEFAULT 10,buy_in_fee numeric DEFAULT 0,is_bounty bool,is_pko bool,is_mystery_bounty bool,bounty_amount numeric,
      blind_structure text,is_pinned bool DEFAULT false,late_reg_levels int DEFAULT 8,rebuy_levels int DEFAULT 8,late_reg_mins int DEFAULT 80);
    CREATE TABLE tournament_schedules(id serial,name text,config jsonb,updated_at timestamptz);
    CREATE FUNCTION fn_ca_blind_contract_number(jsonb) RETURNS numeric LANGUAGE sql AS $$SELECT ($1#>>'{}')::numeric$$;
    CREATE FUNCTION fn_ca_mtt_late_registration_minutes(jsonb,int) RETURNS int LANGUAGE sql AS $$SELECT ($1->0->>'durationMinutes')::int*$2$$;
    ''')
    old=(ROOT/'supabase/migrations/20261021222049_lock_tournament_level_clocks.sql').read_text()
    run(old[:old.index('CREATE OR REPLACE FUNCTION public.fn_ca_tournament_lock_level_clock()')]+'COMMIT;')
    run((ROOT/'scripts/ci/fixtures/highlighted-level-clock/installed-trigger.sql').read_text()+';')
    run('''CREATE TRIGGER tournaments_lock_level_clock BEFORE INSERT OR UPDATE OF blind_structure ON tournaments
      FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_lock_level_clock();
      INSERT INTO tournaments(name,is_pinned,blind_structure) VALUES
      ('Ordinary Deep Stack',false,'[{"durationMinutes":10,"bigBlind":50}]'),
      ('Highlighted Deep Stack',true,'[{"durationMinutes":10,"bigBlind":50}]'),
      ('Daily Turbo',false,'[{"durationMinutes":5,"bigBlind":50}]');
      INSERT INTO tournaments(name,status,blind_structure) VALUES('Running Deep Stack','RUNNING','[{"durationMinutes":10,"bigBlind":50}]');
      INSERT INTO tournament_schedules(config) VALUES
      ('{"type":"mtt","blindStructure":[{"durationMinutes":10,"bigBlind":50}]}'),
      ('{"type":"mtt","isFeatured":true,"blindStructure":[{"durationMinutes":10,"bigBlind":50}]}'),
      ('{"type":"mtt","blindStructure":[{"durationMinutes":5,"bigBlind":50}]}');''')
    check('RED ordinary deep stack uses ten',run("SELECT blind_structure::jsonb->0->>'durationMinutes' FROM tournaments WHERE id=1")=='10')
    migration=(ROOT/'supabase/migrations/20261031212642_only_highlighted_tournaments_may_have_ten_minute_levels.sql').read_text()
    run(migration)
    check('existing scheduled ordinary is eight',run("SELECT blind_structure::jsonb->0->>'durationMinutes' FROM tournaments WHERE id=1")=='8')
    check('late entry nominal clock follows eight levels',run('SELECT late_reg_mins FROM tournaments WHERE id=1')=='64')
    check('highlighted ten preserved',run("SELECT blind_structure::jsonb->0->>'durationMinutes' FROM tournaments WHERE id=2")=='10')
    check('turbo remains five',run("SELECT blind_structure::jsonb->0->>'durationMinutes' FROM tournaments WHERE id=3")=='5')
    check('active event clock not rewritten mid-level',run("SELECT blind_structure::jsonb->0->>'durationMinutes' FROM tournaments WHERE id=4")=='10')
    check('all schedule definitions agree',run("SELECT string_agg(config->'blindStructure'->0->>'durationMinutes',',' ORDER BY id) FROM tournament_schedules")=='8,10,5')
    run("INSERT INTO tournaments(name,blind_structure) VALUES('Future Deep Stack','[{\"durationMinutes\":12,\"bigBlind\":50}]');")
    check('future creation is capped by real trigger',run("SELECT blind_structure::jsonb->0->>'durationMinutes' FROM tournaments WHERE id=5")=='8')
    run("INSERT INTO tournaments(name,tournament_type,variant,blind_structure) VALUES('Custom SNG','SNG','sng','[{\"durationMinutes\":12,\"bigBlind\":50},{\"duration\":180,\"bigBlind\":100}]');")
    check('short formats cap slow custom levels without slowing faster ones',run("SELECT blind_structure::jsonb->0->>'durationMinutes' FROM tournaments WHERE id=6")=='8' and run("SELECT blind_structure::jsonb->1->>'duration' FROM tournaments WHERE id=6")=='180')
    check('repeat and drift refused', 'HIGHLIGHTED_LEVEL_CLOCK_PREIMAGE_CHANGED' in call(PSQL,migration,False).stderr)
    print(json.dumps({'checks':checks,'production_mutations':False},indent=2))
finally:
    call([PG/'pg_ctl','-D',CLUSTER/'data','-m','immediate','-w','stop'],ok=False)
    shutil.rmtree(CLUSTER)
