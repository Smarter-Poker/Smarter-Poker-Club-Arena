"""Additional current-reader, SQL-role and late receipt witnesses for closeout."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[2]
SOURCE="c3000000-0000-4000-8000-000000000001"
TARGET="c3000000-0000-4000-8000-000000000002"
CLUB="c2000000-0000-4000-8000-000000000001"
USER="c1000000-0000-4000-8000-000000000001"

def verify(q,fresh,overlap,register,check):
    installed=(ROOT/"scripts/dev/fixtures/satellite-award-funding/installed.sql").read_text()
    correction=next((ROOT/"supabase/migrations").glob("*_satellite_seats_count_once_and_keep_the_funded_prize.sql")).read_text()
    def setup(name,bounty=0,corrected=True):
        fresh(name);q(installed)
        if corrected:q(correction)
        for n in (1,2):assert json.loads(q(register(n,n))).get("ok") is True
        q(f"UPDATE tournaments SET status='COMPLETING',tournament_type='SATELLITE' WHERE id='{SOURCE}'; INSERT INTO tournaments(id,club_id,name,buy_in_amount,buy_in_fee,bounty_amount,is_bounty,start_time,max_players,status,current_players,prize_pool,bounty_pool,total_rake,variant) VALUES('{TARGET}','{CLUB}','Current reader closeout',180,20,{bounty},{'true' if bounty else 'false'},now()+interval '1 day',100,'REGISTERING',0,0,0,0,'mtt');")
    def award():return f"SET test.actor='{USER}'; SELECT public.fn_award_satellite_seat('{SOURCE}','{TARGET}','{USER}','Fixture1',1);"
    relations=["tournaments","tournament_players","tournament_escrow","chip_ledger","chip_ledger_idem","club_members","rake_records","tournament_payouts","wallet_transactions","tournament_refund_entitlements","entry_purchase_idempotency_receipts"]
    fp="SELECT jsonb_build_array("+",".join("(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM "+table+" t)" for table in relations)+");"
    def fingerprint():return json.loads(q(fp))
    def read():return json.loads(q(f"SELECT to_jsonb(e) FROM fn_ca_tournament_escrow('{TARGET}') e;"))
    setup("current_baseline",bounty=5,corrected=False)
    baseline=read()
    assert baseline["bounty_balance"]==5 and baseline["prize_balance"]==-5,baseline
    assert json.loads(q(award())).get("awarded") is True
    observed=json.loads(q(f"SELECT jsonb_build_object('count',current_players,'prize',(SELECT prize_balance FROM tournament_escrow WHERE tournament_id='{TARGET}')) FROM tournaments WHERE id='{TARGET}';"))
    assert observed==dict(count=2,prize=150),observed
    check("current reader baseline reproduces phantom bounty, duplicate seat count and duplicate fee subtraction")
    setup("service_role")
    answer=json.loads(q("SET ROLE service_role; "+award()))
    assert answer.get("awarded") is True,answer
    before=fingerprint()
    assert json.loads(q("SET ROLE service_role; "+award())).get("held_from_this_satellite") is True
    assert fingerprint()==before
    for role in ("authenticated","anon"):
        q(f"SET ROLE {role}; "+award(),expected_error="permission denied for function fn_award_satellite_seat")
        q(f"SET ROLE {role}; SELECT * FROM public.fn_ca_tournament_escrow('{TARGET}');",expected_error="permission denied for function fn_ca_tournament_escrow")
    assert fingerprint()==before
    check("actual service role awards and replays; authenticated and anon cannot execute private money helpers")
    for bounty in (0,5):
        setup("witnessed_late_receipt_"+str(bounty),bounty=bounty)
        q(f"""
        CREATE FUNCTION public.fixture_witness_final_award() RETURNS trigger LANGUAGE plpgsql AS $w$
        BEGIN
          IF (SELECT count(*) FROM tournament_payouts WHERE source='satellite_seat') IS DISTINCT FROM 1
            OR (SELECT count(*) FROM chip_ledger WHERE metadata->>'kind'='satellite_seat_pool_transfer') IS DISTINCT FROM 1
            OR (SELECT sum(chip_balance) FROM club_members) IS DISTINCT FROM 1600
            OR (SELECT current_players FROM tournaments WHERE id='{TARGET}') IS DISTINCT FROM 1
            OR (SELECT count(*) FROM tournament_players WHERE tournament_id='{TARGET}') IS DISTINCT FROM 1
            OR (SELECT prize_pool FROM tournaments WHERE id='{SOURCE}') IS DISTINCT FROM 160
            OR (SELECT prize_balance FROM tournament_escrow WHERE tournament_id='{SOURCE}') IS DISTINCT FROM 160
            OR (SELECT prize_balance FROM tournament_escrow WHERE tournament_id='{TARGET}') IS DISTINCT FROM {180-bounty}
            OR (SELECT bounty_balance FROM tournament_escrow WHERE tournament_id='{TARGET}') IS DISTINCT FROM {bounty}
            OR (SELECT fee_balance FROM tournament_escrow WHERE tournament_id='{TARGET}') IS DISTINCT FROM 20
          THEN RAISE EXCEPTION 'late witness did not observe every funded component'; END IF;
          RAISE EXCEPTION 'fully funded final receipt failure witnessed' USING ERRCODE='23514';
        END $w$;
        CREATE TRIGGER zzzz_closeout_final_award AFTER INSERT ON tournament_payouts FOR EACH ROW EXECUTE FUNCTION public.fixture_witness_final_award();
        """)
        before=fingerprint()
        q(award(),expected_error="fully funded final receipt failure witnessed")
        assert fingerprint()==before
        check("late receipt observes all funded components then rolls back all11 relations; bounty="+str(bounty))
    setup("ticket_reader_only",corrected=False)
    # Synthetic journal input isolates this reader delta; this is not a ticket
    # redemption/payment end-to-end claim. All ledger triggers remain enabled.
    q(f"INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,tournament_id,idempotency_key,metadata,pre_from_balance,post_from_balance) VALUES('{USER}','escrow','{SOURCE}','prize_liability','{TARGET}',200,'ticket_redeem','{CLUB}','{TARGET}','fixture:ticket-reader:closeout','{{}}',200,0);")
    ticket_before=read()
    assert ticket_before["prize_in"]==200 and ticket_before["prize_balance"]==200,ticket_before
    before=fingerprint();q(correction)
    assert read()==ticket_before
    assert fingerprint()==before
    check("current ticket-redemption reader inflow is byte-preserved and numerically unchanged on synthetic ledger input")
    setup("source_gates")
    signature="public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)"
    before=fingerprint()
    captured=json.loads((ROOT/'scripts/dev/fixtures/satellite-award-funding/current-closeout-source.json').read_text())
    original_award=next(r['definition'] for r in captured if r['signature'].startswith('fn_award_satellite_seat('))
    assert 'DEFAULT NULL::text' in original_award
    mutations=[
      ('default argument',original_award.replace('DEFAULT NULL::text',"DEFAULT 'fixture'::text",1).rstrip()+';'),
      ('missing lock helper','ALTER FUNCTION public.fn_ca_lock_settlement_lane_global() RENAME TO fixture_missing_global;'),
      ("strict",f"ALTER FUNCTION {signature} STRICT;"),
      ("path",f"ALTER FUNCTION {signature} SET search_path=pg_catalog;"),
      ("owner",f'ALTER FUNCTION {signature} OWNER TO "smarter.poker";'),
      ("acl",f"GRANT EXECUTE ON FUNCTION {signature} TO authenticated;"),
      ("body","CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global() RETURNS void LANGUAGE plpgsql AS $x$ BEGIN RETURN; END $x$;"),
      ("trigger disabled","ALTER TABLE public.tournament_players DISABLE TRIGGER trg_sync_tournament_current_players;"),
      ("trigger update only","DROP TRIGGER trg_sync_tournament_current_players ON public.tournament_players; CREATE TRIGGER trg_sync_tournament_current_players AFTER UPDATE OF status,tournament_id ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION public.fn_sync_tournament_current_players();"),
      ("trigger columns","DROP TRIGGER trg_sync_tournament_current_players ON public.tournament_players; CREATE TRIGGER trg_sync_tournament_current_players AFTER INSERT OR DELETE OR UPDATE OF status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION public.fn_sync_tournament_current_players();"),
    ]
    for name,mutation in mutations:
        q("BEGIN; "+mutation+"\n"+correction,expected_error="Satellite correction")
        assert fingerprint()==before
        q(correction)
        check("source gate refuses "+name+" drift and retains every financial row")
