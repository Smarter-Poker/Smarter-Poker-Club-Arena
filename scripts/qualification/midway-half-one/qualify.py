from pathlib import Path
import re,subprocess
# Run against a fresh isolated PostgreSQL database, never production.
import os
psql=[os.environ.get('PSQL', 'psql'), '-v', 'ON_ERROR_STOP=1']
def run(sql):
 r=subprocess.run(psql,input=sql,text=True,capture_output=True)
 print(r.stdout,r.stderr)
 if r.returncode:raise SystemExit(r.returncode)
old=Path('supabase/migrations/20260906004318_action_and_madness_are_one_game_per_blind_category.sql').read_text()
band=re.search(r'CREATE OR REPLACE FUNCTION public.fn_cash_stake_band.*?\n\$\$;',old,re.S).group()
guard=re.search(r'CREATE OR REPLACE FUNCTION public.fn_guard_one_game_per_blind_category.*?\n\$\$;',old,re.S).group()
run('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE cash_games(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,name text,template_name text,variant text,sb numeric,bb numeric,enabled boolean DEFAULT true,must_move boolean DEFAULT true);
'''+band+guard+'''
CREATE TRIGGER zz_one_game_per_blind_category BEFORE INSERT OR UPDATE OF enabled,template_name,variant,bb,club_id ON cash_games FOR EACH ROW EXECUTE FUNCTION fn_guard_one_game_per_blind_category();
CREATE UNIQUE INDEX cash_games_one_per_band_action_madness ON cash_games(club_id,template_name,variant,fn_cash_stake_band(bb)) WHERE enabled AND template_name IN ('action','madness');
INSERT INTO cash_games(club_id,name,template_name,variant,sb,bb)
SELECT 'fade0000-0000-0000-0000-000000000001','existing',t,v,1,2 FROM unnest(ARRAY['classic','action','madness']) t CROSS JOIN unnest(ARRAY['nlh','plo4','plo5','plo6','plo8']) v;
DO $$ BEGIN
 BEGIN INSERT INTO cash_games(club_id,name,template_name,variant,sb,bb) VALUES ('fade0000-0000-0000-0000-000000000001','missing','action','nlh',.5,1);
 RAISE EXCEPTION 'baseline did not refuse'; EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'BEFORE: reproduced duplicate-band refusal'; END;
END $$;
''')
run(Path('supabase/migrations/20261020204148_midway_half_one_cash_games.sql').read_text())
run('''INSERT INTO cash_games(club_id,name,template_name,variant,sb,bb)
SELECT 'fade0000-0000-0000-0000-000000000001','added',t,v,.5,1 FROM unnest(ARRAY['classic','action','madness']) t CROSS JOIN unnest(ARRAY['nlh','plo4','plo5','plo6','plo8']) v;
DO $$ DECLARE t text;v text; BEGIN
IF (SELECT count(*) FROM cash_games) <>30 THEN RAISE EXCEPTION 'missing games'; END IF;
FOREACH t IN ARRAY ARRAY['action','madness'] LOOP
 FOREACH v IN ARRAY ARRAY['nlh','plo4','plo5','plo6','plo8'] LOOP
  BEGIN INSERT INTO cash_games(club_id,name,template_name,variant,sb,bb) VALUES ('fade0000-0000-0000-0000-000000000001','duplicate',t,v,.5,1);
  RAISE EXCEPTION 'duplicate accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
 END LOOP;
END LOOP;
INSERT INTO cash_games(club_id,name,template_name,variant,sb,bb) VALUES ('00000000-0000-0000-0000-000000000001','other','action','nlh',1,2);
BEGIN INSERT INTO cash_games(club_id,name,template_name,variant,sb,bb) VALUES ('00000000-0000-0000-0000-000000000001','other','action','nlh',.5,1);
RAISE EXCEPTION 'other host changed'; EXCEPTION WHEN unique_violation THEN NULL; END;
IF fn_cash_stake_band(1)<>'low' OR fn_cash_game_category_key('fade0000-0000-0000-0000-000000000001','flh',.5,1)<>'low' THEN RAISE EXCEPTION 'band drift';END IF;
RAISE NOTICE 'AFTER: 15 combinations coexist, 10 style duplicate cases refused, other host and horse bands unchanged';
END $$;
''')
