"""Satellite award failure injection against the isolated PostgreSQL fixture."""
def verify_satellite(run, mode="fixed"):
    a="'10000000-0000-0000-0000-000000000001'"
    b="'20000000-0000-0000-0000-000000000002'"
    u="'30000000-0000-0000-0000-000000000003'"
    club="'40000000-0000-0000-0000-000000000004'"
    ddl="""
ALTER TABLE tournaments ADD PRIMARY KEY(id), ADD name text, ADD club_id uuid,
 ADD status text, ADD buy_in_amount numeric, ADD buy_in_fee numeric,
 ADD max_players integer, ADD current_players integer DEFAULT 0, ADD current_level integer,
 ADD late_reg_levels integer, ADD rebuy_levels integer, ADD prize_pool_finalized boolean,
 ADD prize_pool numeric DEFAULT 0, ADD total_rake numeric DEFAULT 0, ADD tournament_type text;
CREATE TABLE tournament_players(id uuid DEFAULT gen_random_uuid(), tournament_id uuid,user_id uuid,username text,chips numeric,status text,is_satellite_qualifier boolean,source_satellite_id uuid,UNIQUE(tournament_id,user_id));
CREATE TABLE profiles(id uuid,display_name text,username text);
CREATE TABLE tournament_payouts(tournament_id uuid,user_id uuid,position integer,amount numeric,source text,idempotency_key text UNIQUE,paid_at timestamptz,tournament_type text,field_size integer,prize_pool numeric,recorded_by text,metadata jsonb);
CREATE TABLE financial_alerts(severity text,source text,message text,context jsonb);
CREATE FUNCTION fn_raise_server_financial_alert(text,text,text,jsonb,text) RETURNS void LANGUAGE sql AS 'INSERT INTO financial_alerts VALUES($1,$2,$3,$4)';
CREATE FUNCTION injected_payout_failure() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE fault text:=current_setting('test.payout_sqlstate',true);
BEGIN IF COALESCE(fault,'')<>'' THEN RAISE EXCEPTION 'injected payout failure' USING ERRCODE=fault; END IF; RETURN NEW; END $f$;
CREATE TRIGGER payout_fault BEFORE INSERT ON tournament_payouts FOR EACH ROW EXECUTE FUNCTION injected_payout_failure();
"""
    setup=f"""
INSERT INTO tournaments(id,name,club_id,status,buy_in_amount,buy_in_fee,prize_pool,tournament_type)
VALUES({a},'Satellite',{club},'COMPLETING',0,0,100,'SATELLITE'),
({b},'Target',{club},'REGISTERING',9,1,0,'MTT');
"""
    op=f"SELECT fn_award_satellite_seat({a},{b},{u},'Winner',1)"
    tables=["tournaments","tournament_players","rake_records","chip_ledger","tournament_payouts"]
    state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in tables)+")"
    cases=[]
    for destination in ["journal","payout"]:
        for code in ["55P03","40P01","23514","23505","XX001"]:
            cases.append((destination+code,"",f"PERFORM set_config('test.{destination}_sqlstate','{code}',true);",code))
    for amount in [0,5]:
        cases.append(("underfunded"+str(amount),f"UPDATE tournaments SET prize_pool={amount} WHERE id={a};","","23514"))
    cases.append(("missing_source",f"DELETE FROM tournaments WHERE id={a};","","23503"))
    cases.append(("ledger_collision",f"INSERT INTO chip_ledger(amount,idempotency_key) VALUES(10,'tourney:10000000-0000-0000-0000-000000000001:seat:30000000-0000-0000-0000-000000000003:pool_transfer');","","23505"))
    cases.append(("receipt_collision","INSERT INTO tournament_payouts(idempotency_key) VALUES('tourney:10000000-0000-0000-0000-000000000001:seat:30000000-0000-0000-0000-000000000003');","","23505"))
    expected="true" if mode=="fixed" else "false"
    for name,pre,fault,code in cases:
        run("BEGIN;"+ddl+setup+pre+f"""
DO $verify$
DECLARE before_state jsonb; after_state jsonb; caught boolean:=false; st text;
BEGIN
 SELECT {state} INTO before_state;
 {fault}
 BEGIN EXECUTE $op$ {op} $op$;
 EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS st=RETURNED_SQLSTATE;
   IF st<>'{code}' THEN RAISE EXCEPTION 'Unexpected state %: %',st,SQLERRM; END IF;
   caught:=true;
 END;
 SELECT {state} INTO after_state;
 IF caught <> {expected} THEN RAISE EXCEPTION 'Wrong propagation: {name}'; END IF;
 IF {expected} AND before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Partial award: {name}'; END IF;
 IF NOT {expected} AND before_state IS NOT DISTINCT FROM after_state THEN RAISE EXCEPTION 'Defect not reproduced: {name}'; END IF;
END $verify$;ROLLBACK;""")
    if mode=="fixed":
        run("BEGIN;"+ddl+setup+f"""
DO $verify$
DECLARE receipt jsonb; before_state jsonb; after_state jsonb;
BEGIN
 SELECT fn_award_satellite_seat({a},{b},{u},'Winner',1) INTO receipt;
 IF receipt->>'awarded'<>'true' OR (receipt->>'pool_transfer')::numeric<>10
 OR (SELECT prize_pool FROM tournaments WHERE id={a})<>90
 OR (SELECT prize_pool FROM tournaments WHERE id={b})<>9
 OR (SELECT total_rake FROM tournaments WHERE id={b})<>1
 OR (SELECT count(*) FROM tournament_players)<>1
 OR (SELECT sum(amount) FROM chip_ledger)<>10
 OR (SELECT sum(amount) FROM tournament_payouts)<>10
 THEN RAISE EXCEPTION 'Wrong successful award'; END IF;
 UPDATE tournaments SET status='COMPLETED' WHERE id={b};
 SELECT {state} INTO before_state;
 SELECT fn_award_satellite_seat({a},{b},{u},'Winner',1) INTO receipt;
 SELECT {state} INTO after_state;
 IF receipt->>'awarded'<>'false' OR receipt->>'held_from_this_satellite'<>'true'
 OR before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Replay changed closed award'; END IF;
END $verify$;ROLLBACK;""")
    print(f"Satellite {mode}: {len(cases)+(2 if mode=='fixed' else 0)} passing cases",flush=True)
