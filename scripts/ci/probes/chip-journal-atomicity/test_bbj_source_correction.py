"""Source-bound historical BBJ leg: no second balance credit, no duplicate, atomic receipt."""
import os
from pathlib import Path

def verify_bbj_source_correction(run):
    here=Path(__file__).resolve().parent
    paths=list((here.parents[3]/"supabase/migrations").glob("*_bbj_incident_records_its_missing_main_leg.sql"))
    assert len(paths)==1
    migration=paths[0].read_text()
    function=migration.replace("DO $correction$","CREATE FUNCTION pg_temp.apply_correction() RETURNS void LANGUAGE plpgsql AS $correction$",1)
    original=os.environ.get("PGDATABASE","postgres")
    run("CREATE DATABASE bbj_source_correction_probe")
    os.environ["PGDATABASE"]="bbj_source_correction_probe"
    try:
        run("""
CREATE TABLE ca_drift_incidents(id uuid PRIMARY KEY, entity_id uuid,club_id uuid,source text,metadata jsonb,
 hand_id uuid,table_id uuid,status text,resolved_at timestamptz,ledger_balanced boolean,
 auto_repair_status text,root_cause text,resolution text,correction_ref text);
CREATE TABLE bbj_contributions(id uuid PRIMARY KEY,pool_id uuid,club_id uuid,table_id uuid,
 hand_id uuid,hand_number bigint,amount numeric,main_portion numeric,backup_portion numeric,
 promo_portion numeric,created_at timestamptz);
CREATE TABLE hand_history(id uuid,table_id uuid,hand_number bigint);
CREATE TABLE ca_bbj_pool_snapshots(id bigint,prev_id bigint,pool_id uuid,taken_at timestamptz,
 unexplained_main numeric,unexplained_backup numeric,unexplained_promo numeric,write_failures int);
CREATE TABLE ca_ledger_write_failures(id bigint,delta numeric,club_id uuid,user_id uuid,
 occurred_at timestamptz,sqlstate text,message text);
CREATE TABLE chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),performed_by uuid NOT NULL,
 from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,to_label text,
 amount numeric CHECK(amount>0 AND amount=round(amount,2)),category text,description text,notes text,
 club_id uuid,table_id uuid,hand_id uuid,settlement_id text,idempotency_key text UNIQUE,
 created_at timestamptz DEFAULT now(),actor_service text,metadata jsonb);
CREATE TABLE balances(scope text PRIMARY KEY,amount numeric);
""")
        C="2a1132b9-5ba2-42e6-9f01-30a7fcffebe3"
        P="a7a65cfc-64e8-4134-afe5-68d3c1a86348"
        T="8dea0f9f-6e1f-47c4-8ff5-b53a7dd941ce"
        H="13b01044-f5bf-44bc-aa43-b851af031db2"
        I="ca15a882-0066-425f-94a7-2a6cf636840e"
        S="f390afc0-7cb4-432f-9ef7-9bc8a00245dc"
        U="2d1cd6c3-5700-4af9-a271-d4863fdab20d"
        B="ab13105c-6ef3-4381-8cae-e061f70c93c2"
        R="e6b81927-1f96-411e-bfe8-7e568b310809"
        when="2026-09-08 02:18:10.791319+00"
        seed=f"""
INSERT INTO ca_drift_incidents(id,entity_id,club_id,source,metadata,status,root_cause,resolution,correction_ref)
 VALUES('{I}','{P}','{C}','fn_bbj_reconcile','{{"snapshot_id":249,"unexplained_main":0.25}}',
 'resolved','old lag diagnosis','old resolution','old reference');
INSERT INTO bbj_contributions VALUES('{S}','{P}','{C}','{T}','{H}',7882379,.5,.25,.12,.13,'{when}');
INSERT INTO hand_history VALUES('{H}','{T}',7882379);
INSERT INTO ca_bbj_pool_snapshots VALUES
 (246,243,'{P}','2026-09-08 01:38:30+00',0,0,0,0),
 (249,246,'{P}','2026-09-08 02:38:32+00',.25,0,0,1);
INSERT INTO ca_ledger_write_failures VALUES(871,.25,'{C}','{P}','{when}','55P03',
 'fn_ca_autoledger bbj_pools.main_balance: canceling statement due to lock timeout');
INSERT INTO chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
 amount,category,description,club_id,table_id,hand_id,created_at) VALUES
 ('{B}','{U}','table_stack','{T}','bbj_pool','{P}',.12,'bbj_contribution',
 'auto-ledgered bbj_pools.backup_balance delta 0.12','{C}','{T}','{H}','{when}'),
 ('{R}','{U}','table_stack','{T}','bbj_pool','{P}',.13,'bbj_contribution',
 'auto-ledgered bbj_pools.promo_balance delta 0.13','{C}','{T}','{H}','{when}');
INSERT INTO balances VALUES('main',100.25),('backup',100.12),('promo',100.13),('table',99.5),('player',200);
"""
        tables=["chip_ledger","ca_drift_incidents","bbj_contributions","balances","ca_ledger_write_failures","ca_bbj_pool_snapshots","hand_history"]
        state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {n} t)" for n in tables)+")"
        run("BEGIN;"+seed+function+f"""
DO $t$ DECLARE original_incident jsonb;before_balances jsonb;after_state jsonb;BEGIN
 SELECT to_jsonb(i) INTO original_incident FROM ca_drift_incidents i;
 SELECT jsonb_agg(to_jsonb(b) ORDER BY scope) INTO before_balances FROM balances b;
 PERFORM pg_temp.apply_correction();
 IF (SELECT count(*) FROM chip_ledger)<>3 OR (SELECT sum(amount) FROM chip_ledger)<>.5
  OR (SELECT amount FROM chip_ledger WHERE to_label='bbj_pools.main_balance')<>.25
  OR (SELECT metadata->'source_main_leg_correction'->'previous_incident' FROM ca_drift_incidents)
       IS DISTINCT FROM original_incident
  OR (SELECT jsonb_agg(to_jsonb(b) ORDER BY scope) FROM balances b) IS DISTINCT FROM before_balances
  OR NOT EXISTS(SELECT 1 FROM chip_ledger WHERE idempotency_key IS NOT NULL
      AND created_at='{when}' AND (metadata->>'recorded_at')::timestamptz>created_at
      AND metadata->>'journal_only'='true')
 THEN RAISE EXCEPTION 'Incorrect source correction or duplicate balance credit'; END IF;
 SELECT {state} INTO after_state;
 PERFORM pg_temp.apply_correction();
 IF after_state IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Replay mutated state';END IF;
END $t$;ROLLBACK;""")
        count=2
        changes=[
            ("UPDATE bbj_contributions SET main_portion=.30 WHERE id IS NOT NULL","P0001"),
            ("UPDATE bbj_contributions SET hand_number=7882380 WHERE id IS NOT NULL","P0001"),
            ("UPDATE hand_history SET table_id=gen_random_uuid() WHERE id IS NOT NULL","P0001"),
            ("UPDATE ca_ledger_write_failures SET delta=.12 WHERE id=871","P0001"),
            ("UPDATE ca_ledger_write_failures SET sqlstate='55006' WHERE id=871","P0001"),
            ("UPDATE ca_bbj_pool_snapshots SET unexplained_backup=.01 WHERE id=249","P0001"),
            ("UPDATE ca_bbj_pool_snapshots SET taken_at='2026-09-08 02:30+00' WHERE id=246","P0001"),
            ("UPDATE chip_ledger SET amount=.11 WHERE id='"+B+"'","P0001"),
            ("DELETE FROM chip_ledger WHERE id='"+B+"'","P0002"),
            (f"INSERT INTO chip_ledger(performed_by,hand_id,category,amount) VALUES('{U}','{H}','bbj_contribution',.25)","P0001"),
            (f"INSERT INTO chip_ledger(performed_by,hand_id,category,amount,idempotency_key) VALUES('{U}','{H}','bbj_contribution',.24,'bbj-source-main-leg:{S}')","P0001"),
        ]
        for change,code in changes:
            run("BEGIN;"+seed+function+change+";"+f"""
DO $t$ DECLARE before_state jsonb; caught boolean:=false; st text;BEGIN
 SELECT {state} INTO before_state;
 BEGIN PERFORM pg_temp.apply_correction();
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS st=RETURNED_SQLSTATE;
  IF st<>'{code}' THEN RAISE EXCEPTION 'Unexpected error %: %',st,SQLERRM;END IF;caught:=true;END;
 IF NOT caught OR before_state IS DISTINCT FROM {state}
 THEN RAISE EXCEPTION 'Unsafe source accepted or failed correction changed rows';END IF;
END $t$;ROLLBACK;""")
            count+=1
        for table in ["chip_ledger","ca_drift_incidents"]:
            for code in ["55P03","40P01","23514","23505","XX001"]:
                trigger=f"""
CREATE FUNCTION pg_temp.fail_write() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'injected' USING ERRCODE='{code}';END $f$;
CREATE TRIGGER fail_write BEFORE INSERT OR UPDATE ON {table}
 FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_write();
"""
                run("BEGIN;"+seed+function+trigger+f"""
DO $t$ DECLARE before_state jsonb;caught boolean:=false;st text;BEGIN
 SELECT {state} INTO before_state;
 BEGIN PERFORM pg_temp.apply_correction();
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS st=RETURNED_SQLSTATE;
 IF st<>'{code}' THEN RAISE EXCEPTION 'Wrong fault %: %',st,SQLERRM;END IF;caught:=true;END;
 IF NOT caught OR before_state IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Partial correction committed';END IF;
END $t$;ROLLBACK;""")
                count+=1
        run("BEGIN;"+function+"SELECT pg_temp.apply_correction();ROLLBACK;")
        count+=1
        print(f"BBJ source correction: {count} PostgreSQL cases passed",flush=True)
    finally:
        os.environ["PGDATABASE"]=original
