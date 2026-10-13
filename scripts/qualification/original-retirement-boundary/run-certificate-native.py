from pathlib import Path
import subprocess
import os,shutil
p=Path(__file__).resolve().parent
b=p/'fixtures'
socket=Path(os.environ['ORB_NATIVE_SOCKET'])
pg=Path(os.environ.get('PG_BIN',str(Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
args=[str(pg/'psql'),'-X','-q','-h',str(socket),'-p',os.environ.get('ORB_NATIVE_PORT','55931'),'-U','postgres','-v','ON_ERROR_STOP=1']
actual_satellite=(b/'actual-satellite-seat-owner.sql').read_text()
raw=(p/'finite245-corpus-exact-originals.jsonb').read_text()
s='BEGIN;SET check_function_bodies=off;'+(p/'actual-maintenance-freeze-native.sql').read_text()+actual_satellite
s+=(p/'proof-class.sql').read_text().replace('pg_temp.original_retirement_boundary_proof','smarter_private.original_retirement_boundary_proof').replace('LANGUAGE plpgsql IMMUTABLE','LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET timezone=\'UTC\'')
for f in ['paired-seat-proof.sql','final-tournament-proof.sql','closed-player-proof.sql','continued-chair-proof.sql','returned-cash-proof.sql','erased-base-proof.sql','finite245-certificate-authority-proposal.sql','finite245-case-insert-guard-proposal.sql','finite-family-proof-proposal.sql']:s+=(p/f).read_text()
s+="WITH x AS(SELECT value FROM jsonb_array_elements($corpus$"+raw+"$corpus$::jsonb)) INSERT INTO smarter_private.original_inventory_restoration_cases(event_id,source_name,row_id,family,original_witness,witness_md5,source_refs) SELECT(value->>'event_id')::bigint,value->>'source_name',(value->>'row_id')::uuid,value->>'family',value->'original_witness',md5((value->'original_witness')::text),value->'source_refs' FROM x;\n"
s+='CREATE TABLE public.union_pnl_original_flows(ledger_id uuid PRIMARY KEY,transaction_id xid8 NOT NULL,recognized_at timestamptz NOT NULL,game_scope jsonb NOT NULL,ledger_snapshot jsonb NOT NULL);'
s+=(p/'original-restoration-cash-return-proposal.sql').read_text()+(p/'original-erased-receivable-proposal.sql').read_text()
s+="""DO $test$DECLARE c record;r jsonb;n integer;cash numeric;held numeric;BEGIN FOR c IN SELECT event_id FROM smarter_private.original_inventory_restoration_cases ORDER BY event_id LOOP r:=smarter_private.certify_original_inventory_restoration(c.event_id,'2026-10-12 07:00:00Z');IF r->'original_inventory_certificate' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'certificate refused %',c.event_id;END IF;END LOOP;SELECT count(*) INTO n FROM smarter_private.original_inventory_restoration_certificates;IF n<>245 THEN RAISE EXCEPTION 'certificatecount';END IF;SELECT count(*),sum(cashouts) INTO n,cash FROM smarter_private.original_restoration_cash_returns('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00:00Z','2026-10-12 07:00:00Z');IF n<>33 OR cash IS DISTINCT FROM 11559.38::numeric THEN RAISE EXCEPTION 'original33 flowcount/sum % %',n,cash;END IF;r:=smarter_private.original_erased_cash_receivables('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00:00Z');SELECT sum((x->>'amount')::numeric) INTO held FROM jsonb_array_elements(r->'holdings')x;IF r->>'status' IS DISTINCT FROM 'ready' OR held IS DISTINCT FROM 1845.87::numeric THEN RAISE EXCEPTION 'original7 held %',r;END IF;SELECT * INTO c FROM smarter_private.original_inventory_restoration_certificates ORDER BY event_id LIMIT 1;
BEGIN INSERT INTO smarter_private.original_inventory_restoration_certificates VALUES(c.event_id,c.boundary,c.witness_md5,c.original_witness,c.proof||'{\"forged\":true}'::jsonb,md5((c.proof||'{\"forged\":true}'::jsonb)::text),clock_timestamp());RAISE EXCEPTION 'forgedcert admitted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
BEGIN PERFORM smarter_private.certify_original_inventory_restoration(c.event_id,c.boundary);RAISE EXCEPTION 'replay admitted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
BEGIN UPDATE smarter_private.original_inventory_restoration_certificates SET proof=proof||'{\"forged\":true}'::jsonb WHERE event_id=c.event_id;RAISE EXCEPTION 'certupdate admitted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
BEGIN DELETE FROM smarter_private.original_inventory_restoration_cases WHERE event_id=c.event_id;RAISE EXCEPTION 'casedelete admitted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
BEGIN
 UPDATE public.chip_ledger SET notes=COALESCE(notes,'')||'native-source-drift' WHERE id=(SELECT(original_witness#>>'{base_ledger,id}')::uuid FROM smarter_private.original_inventory_restoration_cases WHERE family='returned_cash' LIMIT 1);
 PERFORM count(*) FROM smarter_private.original_restoration_cash_returns('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00:00Z','2026-10-12 07:00:00Z');
 RAISE EXCEPTION 'source drift silently omitted original cashflow';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token) VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,'00000000-0000-0000-0000-000000000001');IF public.fn_platform_frozen() IS DISTINCT FROM true THEN RAISE EXCEPTION 'actualfreeze notactive';END IF;BEGIN PERFORM smarter_private.certify_original_inventory_restoration(c.event_id,c.boundary);RAISE EXCEPTION 'frozencert admitted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;RAISE NOTICE 'PASS245 actualsourcegetter/sixfamily proof/guarded immutablecertificate admissions; forgedcert/replay/update/delete refused isolatedonly';END $test$;ROLLBACK;"""
import os
if os.environ.get('NATIVE_GENERATE_ONLY'):
 Path(os.environ['NATIVE_GENERATE_ONLY']).write_text(s);raise SystemExit(0)
r=subprocess.run(args+['-d','original_source_refs'],input=s,text=True,capture_output=True);(socket/'finite245-certificate-native.log').write_text(r.stdout+r.stderr);print(r.returncode,(r.stdout+r.stderr)[-2000:]);raise SystemExit(r.returncode)
