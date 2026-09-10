"""Current satellite award funding on the existing isolated registration runtime.

Current baseline reproduces count, fee subtraction and empty-target bounty defects.
"""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parent
SOURCE = "c3000000-0000-4000-8000-000000000001"
TARGET = "c3000000-0000-4000-8000-000000000002"
CLUB = "c2000000-0000-4000-8000-000000000001"
def uid(n): return "c1000000-0000-4000-8000-" + str(n).zfill(12)

def verify(q, fresh, overlap, register, check):
    installed = ROOT / "fixtures/satellite-award-funding/installed.sql"
    manifest = json.loads((installed.parent / "source-manifest.json").read_text())

    corrections=list((ROOT.parents[1] / "supabase/migrations").glob("*_satellite_seats_count_once_and_keep_the_funded_prize.sql"))
    assert len(corrections)==1

    def prepare(name, entries=2, bounty=0, cap=100):
        fresh(name)
        q(installed.read_text())
        for fn in manifest["functions"] + manifest["reused_financial_functions"]:
            actual = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='%s'::regprocedure;" % fn["signature"])
            assert actual == fn["body_md5"], (fn["signature"], actual)
        if "--satellite-baseline" not in sys.argv:
            q(corrections[0].read_text())
            if name=="satellite_funded":
                q(corrections[0].read_text())  # The prospective source guard permits clean replay.
        for n in range(1, entries + 1):
            r = json.loads(q(register(n,n)))
            assert r.get("ok") is True, r
        q("""UPDATE tournaments SET status='COMPLETING',tournament_type='SATELLITE'
             WHERE id='%s';
             INSERT INTO tournaments(id,club_id,name,buy_in_amount,buy_in_fee,
               bounty_amount,is_bounty,start_time,max_players,status,current_players,
               prize_pool,bounty_pool,total_rake,variant)
             VALUES('%s','%s','Isolated Satellite Target',180,20,%s,%s,
               now()+interval '1 day',%s,'REGISTERING',0,0,0,0,'mtt');"""
          % (SOURCE,TARGET,CLUB,bounty,"true" if bounty else "false",cap))

    def award(n=1):
        return "SET test.actor='%s'; SELECT fn_award_satellite_seat('%s','%s','%s','Fixture %s',%s);" % (
            uid(n),SOURCE,TARGET,uid(n),n,n)

    relations = ["tournaments","tournament_players","tournament_escrow","chip_ledger",
                 "chip_ledger_idem","club_members","rake_records","tournament_payouts",
                 "wallet_transactions","tournament_refund_entitlements","entry_purchase_idempotency_receipts"]
    fingerprint_sql = "SELECT jsonb_build_array(" + ",".join(
        "(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM %s t)" % table
        for table in relations) + ");"
    def fingerprint(): return json.loads(q(fingerprint_sql))

    def balances():
        return json.loads(q("""SELECT jsonb_build_object(
          'wallets',(SELECT sum(chip_balance) FROM club_members),
          'source_pool',(SELECT prize_pool FROM tournaments WHERE id='%s'),
          'source_prize',(SELECT prize_balance FROM tournament_escrow WHERE tournament_id='%s'),
          'target_pool',(SELECT prize_pool FROM tournaments WHERE id='%s'),
          'target_bounty',(SELECT bounty_pool FROM tournaments WHERE id='%s'),
          'target_fee',(SELECT total_rake FROM tournaments WHERE id='%s'),
          'target_prize',(SELECT prize_balance FROM tournament_escrow WHERE tournament_id='%s'),
          'target_bounty_escrow',(SELECT bounty_balance FROM tournament_escrow WHERE tournament_id='%s'),
          'target_fee_escrow',(SELECT fee_balance FROM tournament_escrow WHERE tournament_id='%s'),
          'target_count',(SELECT current_players FROM tournaments WHERE id='%s'),
          'target_entries',(SELECT count(*) FROM tournament_players WHERE tournament_id='%s'),
          'transfers',(SELECT count(*) FROM chip_ledger WHERE metadata->>'kind'='satellite_seat_pool_transfer'),
          'receipts',(SELECT count(*) FROM tournament_payouts WHERE source='satellite_seat'),
          'wallet_receipts',(SELECT count(*) FROM wallet_transactions)
        );""" % (SOURCE,SOURCE,TARGET,TARGET,TARGET,TARGET,TARGET,TARGET,TARGET,TARGET)))

    def assert_funded(bounty=0, wallet_total=1600, paid_entries=0):
        observed=balances()
        expected=dict(wallets=wallet_total,source_pool=160,source_prize=160,
          target_pool=180*(1+paid_entries)-bounty,target_bounty=bounty,target_fee=20*(1+paid_entries),
          target_prize=180*(1+paid_entries)-bounty,target_bounty_escrow=bounty,target_fee_escrow=20*(1+paid_entries),
          target_count=1+paid_entries,target_entries=1+paid_entries,transfers=1,receipts=1,wallet_receipts=2+paid_entries)
        assert observed==expected,(observed,expected)
        proof=json.loads(q("""SELECT jsonb_build_object(
          'source',tp.source_satellite_id,'target',tp.tournament_id,'qualifier',tp.is_satellite_qualifier,
          'ledger_source',l.from_entity_id,'ledger_target',l.to_entity_id,
          'receipt_source',p.tournament_id,'receipt_target',p.metadata->>'satellite_target_id',
          'registration',p.metadata->>'registration_id','player_registration',tp.id,
          'amount',p.amount,'transfer',l.amount)
          FROM tournament_players tp JOIN chip_ledger l ON l.metadata->>'registration_id'=tp.id::text
          JOIN tournament_payouts p ON p.metadata->>'registration_id'=tp.id::text
          WHERE tp.tournament_id='%s';""" % TARGET))
        assert proof==dict(source=SOURCE,target=TARGET,qualifier=True,
          ledger_source=SOURCE,ledger_target=TARGET,receipt_source=SOURCE,receipt_target=TARGET,
          registration=proof["player_registration"],player_registration=proof["player_registration"],
          amount=200,transfer=200),proof

    if "--satellite-lock-reconciliation-only" in sys.argv:
        prepare("satellite_funded")  # Apply and reapply the recomposed candidate.
        # The fixture owner holds only B. A waiting award therefore proves that
        # the actual installed global helper still acquires the hand barrier.
        _, answer = overlap(
            "SELECT pg_advisory_xact_lock(hashtextextended('ca:hand-settlement-barrier:v1',0));",
            award(), closing=True)
        assert answer.get("awarded") is True,answer
        assert_funded()
        q("UPDATE tournaments SET prize_pool_finalized=true WHERE id='%s';" % TARGET)
        before=fingerprint()
        replay=json.loads(q(award()))
        assert replay.get("held_from_this_satellite") is True and replay.get("awarded") is False,replay
        assert fingerprint()==before,"reconciled closed replay wrote financial state"
        check("reconciled award applies twice waits on hand barrier funds once and replays after closure")
        return

    for target_status in ("REGISTERING","ANNOUNCED","RUNNING"):
        name="satellite_funded" if target_status=="REGISTERING" else "satellite_"+target_status.lower()
        prepare(name)
        if target_status!="REGISTERING":
            q("UPDATE tournaments SET status='%s',current_level=1,late_reg_levels=9 WHERE id='%s';"
              % (target_status,TARGET))
        answer=json.loads(q(award()))
        assert answer.get("awarded") is True, answer
        assert_funded()
        q("UPDATE tournaments SET prize_pool_finalized=true WHERE id='%s';" % TARGET)
        before=fingerprint()
        replay=json.loads(q(award()))
        assert replay.get("held_from_this_satellite") is True and replay.get("awarded") is False,replay
        assert fingerprint()==before,"closed target replay wrote financial state"
    check("all admitted target states count one funded seat and replay after closure")

    prepare("satellite_bounty",bounty=5)
    empty = json.loads(q("SELECT to_jsonb(e) FROM fn_ca_tournament_escrow('%s') e;" % TARGET))
    assert (empty["prize_balance"],empty["bounty_balance"],empty["fee_balance"]) == (0,0,0),empty
    assert json.loads(q(award())).get("awarded") is True
    assert_funded(bounty=5)
    rebuilt = json.loads(q("SELECT to_jsonb(e) FROM fn_ca_tournament_escrow('%s') e;" % TARGET))
    assert (rebuilt["prize_balance"],rebuilt["bounty_balance"],rebuilt["fee_balance"]) == (175,5,20),rebuilt
    check("target prize bounty and fee escrows preserve the funded satellite split")

    prepare("satellite_receipt_failure")
    q("""CREATE FUNCTION public.fixture_refuse_satellite_receipt() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'injected final satellite receipt failure' USING ERRCODE='23514'; END $f$;
      CREATE TRIGGER reject_satellite_receipt BEFORE INSERT ON tournament_payouts
      FOR EACH ROW EXECUTE FUNCTION public.fixture_refuse_satellite_receipt();""")
    before=fingerprint()
    q(award(),expected_error="injected final satellite receipt failure")
    assert fingerprint()==before,"late receipt failure committed a partial award"
    check("late satellite receipt failure rolls back source target escrow journal and seat")

    prepare("satellite_short_source",entries=1)
    before=fingerprint()
    q(award(),expected_error="Satellite transfer does not match its funded split")
    assert fingerprint()==before,"underfunded source partially awarded a seat"
    check("a genuinely funded but insufficient source refuses without partial writes")

    prepare("satellite_overlap_replay")
    first,second=overlap(award(),award())
    assert first.get("awarded") is True and second.get("held_from_this_satellite") is True,(first,second)
    assert_funded()
    check("overlapping same-award requests commit one funded seat")

    prepare("satellite_closed_contender")
    _,answer=overlap("UPDATE tournaments SET prize_pool_finalized=true WHERE id='%s';" % TARGET,
                     award(),closing=True)
    assert answer.get("reason")=="target_pool_finalized",answer
    observed=balances()
    assert observed["source_pool"]==360 and observed["source_prize"]==360,observed
    assert observed["target_entries"]==observed["transfers"]==observed["receipts"]==0,observed
    check("a target close commits before a waiting award and prevents every transfer write")

    prepare("satellite_last_place",cap=3)
    for n in (3,4):
        assert json.loads(q(register(n,100+n).replace(SOURCE,TARGET))).get("ok") is True
    first,second=overlap(award(1),award(2))
    assert first.get("awarded") is True and second.get("reason")=="target_full",(first,second)
    assert_funded(wallet_total=1200,paid_entries=2)
    check("two funded qualifiers racing for the final target place create one award")

    prepare("satellite_paid_entry_wins")
    target_register=register(1,101).replace(SOURCE,TARGET)
    first,second=overlap(target_register,award())
    assert first.get("ok") is True and second.get("reason")=="already_registered",(first,second)
    assert second.get("held_from_this_satellite") is False,second
    observed=balances()
    assert observed["source_pool"]==observed["source_prize"]==360,observed
    assert observed["target_entries"]==1 and observed["transfers"]==observed["receipts"]==0,observed
    assert observed["wallets"]==1400,observed
    check("a concurrent paid target entry wins without consuming the satellite source")