"""Additional checks against an already isolated and seeded local fixture."""
import concurrent.futures
import json
import subprocess
import time

CALL = "public.fn_ca_unregister_tournament_player_exact('c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',NULL,'concurrent cash refund','c8000000-0000-4000-8000-000000000001')"


def verify(args, log):
    def q(sql, fail=False):
        result = subprocess.run(args + ['-c', sql], capture_output=True, text=True, timeout=15)
        log.write(result.stdout + result.stderr)
        log.flush()
        if fail:
            assert result.returncode != 0 and 'injected receipt failure' in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    # A late receipt failure must roll back the real wallet, journal and escrow.
    q("CREATE FUNCTION public.probe_refuse_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$; CREATE TRIGGER probe_refuse BEFORE INSERT ON public.tournament_unregistration_receipts FOR EACH ROW EXECUTE FUNCTION public.probe_refuse_receipt();")
    q('SELECT ' + CALL, fail=True)
    before = json.loads(q("SELECT jsonb_build_object('wallet',(SELECT chip_balance FROM public.club_members),'escrow',(SELECT prize_balance+bounty_balance+fee_balance FROM public.tournament_escrow),'credits',(SELECT count(*) FROM public.wallet_transactions),'registrations',(SELECT count(*) FROM public.tournament_players),'receipts',(SELECT count(*) FROM public.tournament_unregistration_receipts),'keys',(SELECT count(*) FROM public.wallet_credit_idempotency));"))
    assert before == dict(wallet=100, escrow=200, credits=0, registrations=1, receipts=0, keys=0), before
    q('DROP TRIGGER probe_refuse ON public.tournament_unregistration_receipts; DROP FUNCTION public.probe_refuse_receipt();')
    log.write('PASS late receipt failure rolls back every financial write\n')

    owner = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, bufsize=1)
    try:
        owner.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0)); SELECT 'owner-ready';\n")
        owner.stdin.flush()
        while owner.stdout.readline().strip() != 'owner-ready':
            if owner.poll() is not None:
                raise AssertionError('lock owner exited: ' + owner.stderr.read())
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            contender = pool.submit(q, "SET application_name='phase3-satellite-refund-contender'; SELECT " + CALL + ';')
            waiting = False
            for _ in range(20):
                waiting = q("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='phase3-satellite-refund-contender' AND wait_event_type='Lock');") == 't'
                if waiting:
                    break
                time.sleep(0.025)
            assert waiting, 'second refund never overlapped the held authority lock'
            owner.stdin.write('SELECT ' + CALL + '; COMMIT;\n')
            owner.stdin.close()
            first = owner.stdout.read().strip()
            assert owner.wait(timeout=15) == 0, owner.stderr.read()
            second = contender.result(timeout=15)
        first, second = json.loads(first), json.loads(second)
        assert first['replayed'] is False and second['replayed'] is True, (first, second)
        assert {k:v for k,v in first.items() if k!='replayed'} == {k:v for k,v in second.items() if k!='replayed'}
        after = json.loads(q("SELECT jsonb_build_object('wallet',(SELECT chip_balance FROM public.club_members),'escrow',(SELECT prize_balance+bounty_balance+fee_balance FROM public.tournament_escrow),'credits',(SELECT count(*) FROM public.wallet_transactions),'tranches',(SELECT count(*) FROM public.tournament_refund_tranches),'receipts',(SELECT count(*) FROM public.tournament_unregistration_receipts),'tickets',(SELECT count(*) FROM public.tournament_tickets));"))
        assert after == dict(wallet=300, escrow=0, credits=1, tranches=1, receipts=1, tickets=0), after
        log.write('PASS actual overlapping requests commit one cash refund and replay one receipt\n')
        log.flush()
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait(timeout=5)
