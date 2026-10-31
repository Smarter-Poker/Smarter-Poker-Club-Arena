#!/usr/bin/env python3
"""Native PG qualification of value-ticket selection and atomic escrow use.
The unchanged gameplay/admission and journal-writer closures are explicit fixture
boundaries; provider financial qualification and live readback remain required.
"""
import os,json,re,subprocess,tempfile,shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
root=Path(__file__).resolve().parents[2]
binpath=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
if not (binpath/'initdb').exists():
 candidate=shutil.which('initdb')
 if not candidate: raise RuntimeError('PostgreSQL initdb is required')
 binpath=Path(candidate).parent
base=Path(tempfile.mkdtemp(prefix='value-ticket-',dir=os.environ['TMPDIR']))
data=base/'data';sock=base/'socket';sock.mkdir();log=base/'postgres.log'
port='56477'
def command(name,*args,**kw):
 result=subprocess.run([str(binpath/name),*args],text=True,capture_output=True,**kw)
 if result.returncode:raise RuntimeError(result.stderr+'\n'+result.stdout+(log.read_text() if name=='pg_ctl' and log.exists() else ''))
 return result
def sql(text):return command('psql','-X','-qAt','-h',str(sock),'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1',input="SET test.actor='80000000-0000-4000-8000-000000000003';\n"+text).stdout.strip()
def check(statement):
 result=sql(statement)
 if result!='t':raise AssertionError(result)
try:
 command('initdb','-D',str(data),'-A','trust','--no-locale','-U','postgres')
 command('pg_ctl','-D',str(data),'-l',str(log),'-o',f'-k {sock} -p {port} -h 127.0.0.1','-w','start')
 fixture=root/'tests/fixtures/cashier-value-tickets'
 sql((fixture/'bootstrap.sql').read_text())
 owners=json.loads((fixture/'owners.json').read_text())
 sql('\n'.join(row['definition'].rstrip()+';' for row in owners))
 sql((fixture/'issuer.sql').read_text())
 migration=next((root/'supabase/migrations').glob('*_cashier_tickets_match_any_equal_entry_value.sql'))
 sql(migration.read_text())
 C='80000000-0000-4000-8000-000000000001';I='80000000-0000-4000-8000-000000000002';H='80000000-0000-4000-8000-000000000003'
 A='80000000-0000-4000-8000-000000000004';B='80000000-0000-4000-8000-000000000005';W='80000000-0000-4000-8000-000000000006'
 actor=lambda who:f"SELECT set_config('test.actor','{who}',false);"
 sql(f"INSERT INTO profiles VALUES('{I}',false),('{H}',true);INSERT INTO club_members VALUES('{C}','{I}',100,'owner','active',NULL,now()),('{C}','{H}',0,'member','active',NULL,now());INSERT INTO tournaments(id,club_id,buy_in_amount,buy_in_fee,bounty_amount,is_bounty) VALUES('{A}','{C}',22.5,2.5,0,false),('{B}','{C}',22.5,2.5,10,true),('{W}','{C}',36,4,0,false);")
 ticket=json.loads(sql(actor(I)+f"SELECT fn_issue_tournament_ticket_phase2_core_20260831('{C}','{H}',25,NULL,'value-25');").splitlines()[-1])['ticket_id']
 check(f"SELECT chip_balance=75 FROM club_members WHERE user_id='{I}';")
 for event in (A,B):check(f"SELECT (fn_ca_find_cashier_entry_ticket_for('{event}','{H}')->>'ticket_id')='{ticket}';")
 check(f"SELECT fn_ca_find_cashier_entry_ticket_for('{W}','{H}')->>'ticket_id' IS NULL;")
 check(f"SELECT fn_ca_use_cashier_entry_ticket('{W}','{ticket}','{H}')->>'reason'='ticket_entry_contract_mismatch';")
 sql(actor(H)+f"UPDATE tournaments SET status='COMPLETED' WHERE id='{A}';")
 check(f"SELECT fn_register_for_tournament_with_ticket_before_terminal_gate('{A}','{ticket}')->>'reason'='registration_closed';")
 check(f"SELECT status='issued' FROM tournament_tickets WHERE id='{ticket}';")
 check(f"SELECT chip_balance=0 FROM club_members WHERE user_id='{H}';")
 sql(actor(H)+f"SELECT fn_register_for_tournament_with_ticket_before_terminal_gate('{B}','{ticket}');")
 check(f"SELECT status='redeemed' FROM tournament_tickets WHERE id='{ticket}';")
 check(f"SELECT chip_balance=0 FROM club_members WHERE user_id='{H}';")
 check('SELECT count(*)=1 AND sum(charge)=25 AND sum(prize)=12.5 AND sum(bounty)=10 AND sum(rake)=2.5 FROM entry_receipts;')
 check(f"SELECT fn_register_for_tournament_with_ticket_before_terminal_gate('{B}','{ticket}')->>'replayed'='true';")
 check(f"SELECT fn_register_for_tournament_with_ticket_before_terminal_gate('{A}','{ticket}')->>'reason'='ticket_already_used';")
 check("SELECT count(*)=1 FROM chip_transactions WHERE transaction_type='tournament_ticket_redeem';")
 check("SELECT NOT has_function_privilege('authenticated','fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid)','EXECUTE') AND has_function_privilege('service_role','fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid)','EXECUTE');")
 # A fresh value ticket can race for two distinct eligible events; its row
 # lock must permit exactly one purchase, regardless of which event wins.
 sql(f"UPDATE tournaments SET status='REGISTERING' WHERE id='{A}'; DELETE FROM tournament_players; DELETE FROM entry_receipts;")
 ticket2=json.loads(sql(actor(I)+f"SELECT fn_issue_tournament_ticket_phase2_core_20260831('{C}','{H}',25,NULL,'race-25');").splitlines()[-1])['ticket_id']
 with ThreadPoolExecutor(max_workers=2) as pool:
  outcomes=list(pool.map(lambda event:json.loads(sql(f"SELECT fn_register_for_tournament_with_ticket_before_terminal_gate('{event}','{ticket2}');")),(A,B)))
 assert sum(r.get('ok') is True for r in outcomes)==1,outcomes
 check('SELECT count(*)=1 AND sum(charge)=25 FROM entry_receipts;')
 check(f"SELECT chip_balance=0 FROM club_members WHERE user_id='{H}';")
 check(f"SELECT count(*)=1 FROM chip_transactions WHERE metadata->>'ticket_id'='{ticket2}' AND transaction_type='tournament_ticket_redeem';")
 # Price and asset checks precede all wallet movement.
 ticket3=json.loads(sql(actor(I)+f"SELECT fn_issue_tournament_ticket_phase2_core_20260831('{C}','{H}',25,NULL,'guards-25');").splitlines()[-1])['ticket_id']
 check(f"SELECT fn_ca_use_cashier_entry_ticket('{A}','{ticket3}','{I}')->>'reason'='ticket_not_owned';")
 check(f"SET test.frozen='true'; SELECT fn_ca_use_cashier_entry_ticket('{A}','{ticket3}','{H}')->>'reason'='platform_frozen';")
 sql(f"UPDATE tournaments SET asset='diamonds' WHERE id='{A}';")
 check(f"SELECT fn_ca_use_cashier_entry_ticket('{A}','{ticket3}','{H}')->>'reason'='not_a_cashier_entry_ticket';")
 sql(f"UPDATE tournaments SET asset='chips',club_id='80000000-0000-4000-8000-000000000099' WHERE id='{A}';")
 check(f"SELECT fn_ca_use_cashier_entry_ticket('{A}','{ticket3}','{H}')->>'reason'='ticket_source_club_unavailable';")
 check(f"SELECT status='issued' FROM tournament_tickets WHERE id='{ticket3}';")
 check(f"SELECT chip_balance=0 FROM club_members WHERE user_id='{H}';")
 print('PASS: native value matching, accounting split, rollback, duplicate and concurrent redemption, ownership, freeze, currency, club and private ACL')
finally:
 if (data/'postmaster.pid').exists():command('pg_ctl','-D',str(data),'-m','immediate','-w','stop')
 shutil.rmtree(base)
