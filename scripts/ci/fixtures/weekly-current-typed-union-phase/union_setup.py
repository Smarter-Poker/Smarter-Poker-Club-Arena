# Current exact owner capture supplied by root; never production execution.
capture=EXT/'current-union-dependencies.json'
catalog=json.loads(capture.read_text())
assert catalog['read_only']=='on'and len(catalog['owners'])==8 and len(catalog['tables'])==9
for t in catalog['tables']:
    name=t['name'];exists=q("SELECT to_regclass('public."+name+"')IS NOT NULL").stdout.strip()=='t'
    if not exists:q('CREATE TABLE public.'+name+'()')
    columns=set(json.loads(q("SELECT coalesce(jsonb_agg(attname),'[]')FROM pg_attribute WHERE attrelid='public."+name+"'::regclass AND attnum>0 AND NOT attisdropped").stdout.strip()))
    for c in t['columns']:
        if c['name']not in columns:q('ALTER TABLE public.'+name+' ADD COLUMN "'+c['name']+'" '+c['type'])
        # Epoch metadata is an external registry boundary; no epoch owner is stubbed.
        if c['default']and c['default']!='fn_ca_current_epoch()':q('ALTER TABLE public.'+name+' ALTER COLUMN "'+c['name']+'" SET DEFAULT '+c['default'])
        if c['notnull']:q('ALTER TABLE public.'+name+' ALTER COLUMN "'+c['name']+'" SET NOT NULL')
    for c in t['constraints']or[]:
        if c['definition'].startswith('FOREIGN KEY'):continue # existing native external FK boundary
        if q("SELECT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public."+name+"'::regclass AND conname='"+c['name']+"')").stdout.strip()=='t':continue
        q('ALTER TABLE public.'+name+' ADD CONSTRAINT "'+c['name']+'" '+c['definition'])
for r in catalog['owners']:
    assert hashlib.md5(r['definition'].encode()).hexdigest()==r['md5'],r['signature']
    q('SET check_function_bodies=off;'+r['definition'])
    assert q("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))").stdout.strip()==r['md5'],r['signature']
q("CREATE TABLE tournaments(id uuid PRIMARY KEY,tournament_type text);CREATE TABLE union_pnl_inventory_capture(singleton boolean PRIMARY KEY,captured_at timestamptz);INSERT INTO union_pnl_inventory_capture VALUES(true,'2026-10-19 07:00Z');ALTER TABLE accounting_close_partials ADD COLUMN cash_ids uuid[],ADD COLUMN cash_md5 bytea,ADD COLUMN fee_ids uuid[],ADD COLUMN fee_md5 bytea;ALTER TABLE accounting_close_certificates ADD PRIMARY KEY(kind,union_id,period_start,period_end);")
for row in json.loads((R/'scripts/ci/fixtures/inventory-proof-lifetime-sources.json').read_text())['functions']:
    if row['signature']=='public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)':q('SET check_function_bodies=off;'+row['definition']+';')
# Current union basis reads the original computed source plan, not an old hourly projection.
u="'cae11000-0000-0000-0000-000000000100'::uuid"
q("CREATE FUNCTION fixture_union()RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT "+u+"$$;")
seed=q("SELECT pg_get_functiondef('own_playing_seed(boolean,integer,boolean)'::regprocedure)").stdout.strip()
seed=seed.replace('public.own_playing_seed(', 'public.own_union_seed(',1)
old="(id,name,owner_id,chip_treasury,is_union,asset,lifecycle_status)VALUES(club,'Own playing synthetic '||club,caw_u('O'),1000,false,'chips','active')"
new="(id,name,owner_id,chip_treasury,is_union,asset,lifecycle_status,union_id)VALUES(club,'Own playing synthetic '||club,caw_u('O'),1000,false,'chips','active',fixture_union())"
assert seed.count(old)==1;seed=seed.replace(old,new)
needle=' FOR n IN 1..3 LOOP'
add=""" INSERT INTO union_clubs(id,union_id,club_id,club_commission_rate,rate_cash)VALUES(caw_u('union-club'),fixture_union(),club,.9,.9);
 PERFORM own_history(10020,'union_clubs',caw_u('union-club')::text,'2026-10-15',jsonb_build_object('id',caw_u('union-club'),'club_id',club,'union_id',fixture_union(),'club_commission_rate',.9,'rate_cash',.9));
"""
assert seed.count(needle)==1;seed=seed.replace(needle,add+needle)
seed=seed.replace("'union_id',NULL)","'union_id',fixture_union())")
seed=seed.replace("own_original_earning_contract(club,caw_u('A'),amt,NULL,earned)","own_original_earning_contract(club,caw_u('A'),amt,fixture_union(),earned)")
old="INSERT INTO accounting_cash_bank_receipts(rake_record_id,club_id,club_ledger_id,banked_at,amount)VALUES(rr,club,journal,earned,amt);"
new="INSERT INTO union_wallet_transactions(id,union_id,club_id,amount,wallet,direction,tx_type,created_at,notes,balance_after)VALUES(journal,fixture_union(),club,amt,'rake_wallet','credit','rake',earned,'Native original source bank credit',amt);INSERT INTO accounting_cash_bank_receipts(rake_record_id,club_id,union_id,union_transaction_id,banked_at,amount)VALUES(rr,club,fixture_union(),journal,earned,amt);"
assert seed.count(old)==1;seed=seed.replace(old,new)
# The synthetic original source's bank journal names its true union destination.
seed=seed.replace("'chip_retirement',NULL,amt,'burn'", "'union_wallet',fixture_union(),amt,'rake'")
old="accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,recorded_at)VALUES(src,rr,caw_u('A'),club,earned,amt,contract,earned)"
new="accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,recorded_at,union_id,coordinator_union_id)VALUES(src,rr,caw_u('A'),club,earned,amt,contract,earned,fixture_union(),fixture_union())"
assert seed.count(old)==1;seed=seed.replace(old,new)
q('SET check_function_bodies=off;'+seed)
union_seed_sql="SET LOCAL test.own_namespace='global-typed-union';INSERT INTO unions(id,name,owner_id,slug)VALUES(fixture_union(),'Native third-scope union',caw_u('O'),'native-third-scope');INSERT INTO union_wallets(union_id,rake_wallet,chip_balance)VALUES(fixture_union(),102,0);INSERT INTO union_settlement_floor(union_id,earliest_period_start,reason)VALUES(fixture_union(),'2026-10-19 07:00Z','Isolated native closed week');SELECT own_union_seed();INSERT INTO fixture_scope VALUES(fixture_union(),'union');SELECT caw_assert((smarter_private.prepare_own_agent_interpretation(fixture_union(),NULL,'2026-10-19 07:00Z','2026-10-26 07:00Z'))->>'ready'='true','real union source interpretation');SELECT fn_rakeback_split_write(caw_u('club'),'2026-10-19','2026-10-25',ARRAY[caw_u('A')]);INSERT INTO accounting_period_recompute_requests(club_id,period_start,period_end,status,last_requested_at,attempted_at,last_result)VALUES(caw_u('club'),'2026-10-19','2026-10-25','complete',clock_timestamp()-interval '1 second',clock_timestamp(),jsonb_build_object('accounting_version',2,'status','ready','club_id',caw_u('club'),'period_start','2026-10-19','period_end','2026-10-25')) ON CONFLICT(club_id,period_start,period_end)DO UPDATE SET status=excluded.status,last_requested_at=excluded.last_requested_at,attempted_at=excluded.attempted_at,last_result=excluded.last_result;SELECT fn_weekly_accounting_attempt_begin(true);SELECT caw_assert((fn_accounting_union_earned_plan(fixture_union(),'2026-10-19 07:00Z','2026-10-26 07:00Z')->>'period_rake')::numeric=102,'original earned plan computes actual102');SELECT caw_assert((SELECT payout=91.8 AND rate=.9 FROM fn_union_club_rake_basis(fixture_union(),'2026-10-19 07:00Z','2026-10-26 07:00Z',true)),'original basis proves90pct');SELECT caw_assert((SELECT array_agg(club_id)=ARRAY[caw_u('club')]FROM fn_accounting_week_clubs(fixture_union(),NULL,'2026-10-19 07:00Z','2026-10-26 07:00Z')),'actual union club discovery');SELECT fn_weekly_accounting_attempt_end();"
# Include native union bank money in the all-funding-before-any-gross observation.
q("CREATE FUNCTION fixture_observe_union_bank()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.from_type='union_wallet'AND NEW.to_type='club_treasury'THEN INSERT INTO fixture_order(kind,club_id)VALUES('bank',NEW.club_id);END IF;RETURN NEW;END$$;CREATE TRIGGER fixture_union_bank AFTER INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fixture_observe_union_bank();")
