"""Execute satellite split and shared refund accounting on an isolated PostgreSQL database."""
import os, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[4]
source=Path(__file__).with_name("test_atomicity.py")
parser={"__name__":"satellite_split_parser"}
exec(compile(source.read_text().split("\npg=os.environ",1)[0],str(source),"exec"),parser)
if os.environ.get("PGNODE"):
 args=[os.environ["PGNODE"],str(Path(__file__).with_name("postgres-runtime")/"query.mjs")]
else:
 args=[os.environ.get("PSQL","/opt/homebrew/opt/postgresql@17/bin/psql"),"-X","-q","-h",os.environ["PGHOST"],"-p",os.environ["PGPORT"],"-U",os.environ["PGUSER"],"-d",os.environ.get("PGDATABASE","postgres"),"-v","ON_ERROR_STOP=1"]
def run(sql):
 r=subprocess.run(args,input=sql,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout
fixture=Path(__file__).with_name("fixture.sql").read_text()+Path(__file__).with_name("satellite-split-fixture.sql").read_text()
names={"fn_award_satellite_seat","fn_deliver_satellite_ticket_exact","fn_ca_escrow_on_seat_transfer_leg","fn_ca_escrow_on_rake_record","fn_ca_escrow_on_seat_payout","trg_seed_bounty_head"}
# This probe owns the v2 funded-entry split and corresponding legacy
# wallet-refund apportionment. Pin its complete function graph at the migration
# that established that contract; later cancellation/refund authorities have
# separate schemas and probes and must not expand this isolated fixture.
contract_migration="20260908144013_satellite_entries_preserve_the_funded_split.sql"
defs=parser["authoritative_function_closure"](
 root,"",names,through=contract_migration
)
run("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA auth CASCADE;"+fixture+"\n"+"\n".join(d for _,d in defs)+"""
CREATE TRIGGER seed_bounty AFTER INSERT ON tournament_players FOR EACH ROW EXECUTE FUNCTION trg_seed_bounty_head();
CREATE TRIGGER seat_in AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (NEW.idempotency_key LIKE 'tourney:%:seat:%:pool_transfer') EXECUTE FUNCTION fn_ca_escrow_on_seat_transfer_leg();
CREATE TRIGGER fee_in AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_ca_escrow_on_rake_record();
CREATE TRIGGER seat_out AFTER INSERT ON tournament_payouts FOR EACH ROW WHEN (NEW.source='satellite_seat') EXECUTE FUNCTION fn_ca_escrow_on_seat_payout();
""")
a="'10000000-0000-0000-0000-000000000001'"; b="'20000000-0000-0000-0000-000000000002'"; u="'30000000-0000-0000-0000-000000000003'"; club="'40000000-0000-0000-0000-000000000004'"
count=0
for flag in ['is_bounty','is_pko','is_mystery_bounty','none']:
 for fee in [0,1]:
  for mixed in [False,True]:
   bounty=0 if flag=='none' else 5; prize=10-bounty; charge=10+fee
   flags="" if flag=='none' else f", {flag}"
   values="" if flag=='none' else ", true"
   setup=f"""
INSERT INTO tournaments(id,name,club_id,status,buy_in_amount,buy_in_fee,prize_pool,tournament_type,bounty_amount{flags})
VALUES({a},'Satellite',{club},'COMPLETING',100,0,100,'SATELLITE',0{values}),
({b},'Target',{club},'REGISTERING',10,{fee},0,'MTT',{bounty}{values});
INSERT INTO wallet_transactions VALUES({a},'debit','tournament_buyin',100);
"""
   if mixed:
    setup+=f"""
INSERT INTO wallet_transactions VALUES({b},'debit','tournament_buyin',{charge});
INSERT INTO rake_records(tournament_id,is_tournament,rake_amount,source) VALUES({b},true,{fee},'paid_entry');
UPDATE tournaments SET prize_pool={prize},bounty_pool={bounty},total_rake={fee} WHERE id={b};
"""
   sql=f"""BEGIN;{setup}
DO $test$ DECLARE r jsonb; e record; s record; BEGIN
 SELECT fn_deliver_satellite_ticket_exact({a},{b},{u},'Winner',1,{charge}) INTO r;
 IF r->>'delivery'<>'seat' THEN RAISE EXCEPTION 'Not seated: %',r; END IF;
 IF (SELECT prize_pool FROM tournaments WHERE id={b})<>{prize*(2 if mixed else 1)}
 OR (SELECT bounty_pool FROM tournaments WHERE id={b})<>{bounty*(2 if mixed else 1)}
 OR (SELECT current_bounty FROM tournament_players WHERE user_id={u})<>{bounty}
 OR (SELECT prize_pool FROM tournaments WHERE id={a})<>{100-charge}
 THEN RAISE EXCEPTION 'Entry liabilities do not conserve ticket'; END IF;
 SELECT * INTO e FROM tournament_escrow WHERE tournament_id={b};
 SELECT * INTO s FROM fn_ca_tournament_escrow({b});
 IF e.prize_balance<>{prize*(2 if mixed else 1)} OR e.bounty_balance<>{bounty*(2 if mixed else 1)} OR e.fee_balance<>{fee*(2 if mixed else 1)}
 OR e.prize_balance<>s.prize_balance OR e.bounty_balance<>s.bounty_balance OR e.fee_balance<>s.fee_balance
 THEN RAISE EXCEPTION 'Escrow disagreement actual %, shadow %',row_to_json(e),row_to_json(s); END IF;
 SELECT fn_deliver_satellite_ticket_exact({a},{b},{u},'Winner',1,{charge}) INTO r;
 IF r->>'already'<>'true' OR (SELECT count(*) FROM tournament_payouts)<>1 THEN RAISE EXCEPTION 'Replay changed award'; END IF;
 INSERT INTO wallet_transactions VALUES({b},'credit','refund',{charge});
 PERFORM fn_ca_escrow_apply({b},'test refund',p_refund=>{charge});
 INSERT INTO rake_records(tournament_id,is_tournament,rake_amount,source) SELECT {b},true,-{fee},'fn_unregister_from_tournament' WHERE {fee}>0;
 SELECT * INTO e FROM tournament_escrow WHERE tournament_id={b};
 IF e.prize_balance<>{prize if mixed else 0} OR e.bounty_balance<>{bounty if mixed else 0} OR e.fee_balance<>{fee if mixed else 0}
 THEN RAISE EXCEPTION 'Refund split wrong %',row_to_json(e); END IF;
 DELETE FROM tournament_escrow WHERE tournament_id={b};
 PERFORM fn_ca_escrow_apply({b},'test reconstruct');
 SELECT * INTO e FROM tournament_escrow WHERE tournament_id={b};
 IF e.prize_balance<>{prize if mixed else 0} OR e.bounty_balance<>{bounty if mixed else 0} OR e.fee_balance<>{fee if mixed else 0}
 THEN RAISE EXCEPTION 'Reconstructed refund wrong %',row_to_json(e); END IF;
END $test$; ROLLBACK;"""
   run(sql);count+=1
print("PASS",count,"format/fee/mixed-entry scenarios: split, escrow, replay, refund, reconstruction")
