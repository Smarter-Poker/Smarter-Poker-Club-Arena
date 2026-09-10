"""Compose genuine paid Heads-Up launches with the installed cash-ladder reader.

This fixture never installs Stage B, pays a prize, seeds a payout receipt, or
substitutes a financial owner. It is reusable input evidence for terminal work.
"""
from pathlib import Path
import hashlib
import json
import re

repo = Path(__file__).resolve().parents[2]
event = 'c3000000-0000-4000-8000-000000000001'
sources = {
    'supabase/migrations/20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql':
        'bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b',
    'supabase/migrations/20260910171924_satellite_seats_count_once_and_keep_the_funded_prize.sql':
        '9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3',
    'scripts/dev/fixtures/tournament-payout-amounts/installed.sql':
        'c153f83039a1a3346fb2d35dc59595f2d18c04797058bb9cfbbc98e06c0837a4',
}
selected = {
    'fn_ca_lock_settlement_lane_for_tournament': '3acb4c1d763181905cf5b64287f8f28f',
    'fn_tournament_live_seat_acquisition_requires_authority': '5a60bdd761aaaaad4b3bf982a3c50f6e',
    'fn_satellite_target_player_provenance_is_immutable': '266a6b06f5cc44bc953ca4c31933d7db',
    'fn_tournament_payouts_are_append_only': '6cfe150a2a360d878c9c389499e7b196',
    'fn_lock_daily_mission_user': '66c5a8c8da7471773a58dd7c346c9df0',
    'fn_ca_release_unseatable_registrant_at_launch': '4170a9f0298fb2e1e97ab7be5e2ec048',
    'fn_ca_escrow_on_rake_record': '3e628d6a57a93eeb61d494ee33f989a3',
    'fn_ca_tournament_place_amounts': '8f6cde5f5b799949506259f3064568b9',
}
observations = []
installed = {}


def definitions():
    result = {}
    for path, expected in sources.items():
        raw = (repo / path).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == expected, path
        text = raw.decode()
        for match in re.finditer(r'CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(', text):
            name = match[1]
            if name not in selected:
                continue
            opening = re.search(r'\bAS\s+(\$[A-Za-z0-9_]*\$)', text[match.start():])
            assert opening is not None, name
            body_start = match.start() + opening.end()
            end = text.index(opening[1], body_start)
            assert hashlib.md5(text[body_start:end].encode()).hexdigest() == selected[name], name
            assert name not in result, name
            result[name] = text[match.start():end + len(opening[1])] + ';'
    assert set(result) == set(selected), set(selected) - set(result)
    return result


def prepare(q):
    global installed
    # Reuse the exact imported dependency set. Add only the already-installed
    # amount reader; a missing financial dependency must never become a stub.
    available = set(json.loads(q("SELECT json_agg(proname) FROM pg_proc WHERE pronamespace='public'::regnamespace;")))
    wanted = {name: definition for name, definition in definitions().items()
              if name in available or name == 'fn_ca_tournament_place_amounts'}
    assert {'fn_ca_lock_settlement_lane_for_tournament', 'fn_ca_escrow_on_rake_record',
            'fn_ca_tournament_place_amounts'}.issubset(wanted)
    q('BEGIN;\nSET LOCAL check_function_bodies=off;\n' + '\n'.join(wanted.values()) + '\nCOMMIT;')
    names = ','.join("'" + name + "'" for name in wanted)
    actual = json.loads(q("SELECT json_object_agg(proname,md5(prosrc)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (" + names + ");"))
    expected = {name: selected[name] for name in wanted}
    assert actual == expected, (actual, expected)
    if installed:
        assert installed == actual, 'every fresh fixture uses the same successor bodies'
    installed = actual


def verify_launched(q, snapshot, variant, chips, check):
    before = snapshot()
    query = "SELECT COALESCE(json_agg(json_build_object('place',place,'amount',amount) ORDER BY place),'[]')::text FROM public.fn_ca_tournament_place_amounts('" + event + "');"
    ladder = json.loads(q(query))
    assert ladder == [{'place': 1, 'amount': 380}], ladder
    assert json.loads(q(query)) == ladder, 'same funded inputs must return the same ladder'
    after = snapshot()
    assert after == before, 'ladder pricing may not write money or change source rows'
    result = json.loads(q("""SELECT json_build_object(
        'wallets',(SELECT sum(chip_balance) FROM club_members),
        'wallet_debits',(SELECT sum(amount) FROM wallet_transactions WHERE type='debit'),
        'wallet_credits',(SELECT count(*) FROM wallet_transactions WHERE type='credit'),
        'journal_debits',(SELECT sum(amount) FROM chip_ledger WHERE from_type='player_wallet'),
        'gross',(SELECT gross_in FROM tournament_escrow),
        'prize',(SELECT prize_balance FROM tournament_escrow),
        'fee',(SELECT fee_balance FROM tournament_escrow),
        'bounty',(SELECT bounty_balance FROM tournament_escrow),
        'display_prize',(SELECT prize_pool FROM tournaments),
        'display_fee',(SELECT total_rake FROM tournaments),
        'seat_score',(SELECT sum(stack) FROM table_seats WHERE left_at IS NULL),
        'roster_score',(SELECT sum(chips) FROM tournament_players),
        'entries',(SELECT count(*) FROM tournament_players),
        'draws',(SELECT count(*) FROM spin_reserve_ledger),
        'payouts',(SELECT count(*) FROM tournament_payouts),
        'obligations',(SELECT count(*) FROM tournament_obligations),
        'status',(SELECT status FROM tournaments),
        'launch_completed',(SELECT completed_at IS NOT NULL FROM tournament_launch_receipts)
    )::text;"""))
    expected = dict(wallets=1600, wallet_debits=400, wallet_credits=0,
                    journal_debits=400, gross=400, prize=380, fee=20, bounty=0,
                    display_prize=380, display_fee=20, seat_score=2*chips,
                    roster_score=2*chips, entries=2, draws=0, payouts=0,
                    obligations=0, status='RUNNING', launch_completed=True)
    assert result == expected, (result, expected)
    assert result['wallets'] + result['prize'] + result['fee'] + result['bounty'] == 2000
    assert sum(row['amount'] for row in ladder) == result['prize']
    observations.append(dict(variant=variant, starting_stack=chips, state=result,
                             ladder=ladder, source_unchanged=True,
                             source_before_sha256=hashlib.sha256(before.encode()).hexdigest(),
                             source_after_sha256=hashlib.sha256(after.encode()).hexdigest(),
                             public_table_count=len(json.loads(before))))
    check(variant + ' ' + str(chips) + ': actual funded launch prices exactly its prize custody and preserves every source row')


def evidence():
    return dict(scope='Real paid Heads-Up admission and launch to installed amount derivation',
                input_sha256=sources, installed_body_md5=installed, variants=observations,
                production_mutations=False, stage_b_installed=False,
                terminal_payment_exercised=False,
                limits=['Synthetic local auth and supporting operational tables.',
                        'This is amount derivation from actual funded entries, not a paid terminal receipt.',
                        'The original 16 Heads-Up groups also run; the historical full suite had 53 groups total.',
                        'Broader current production dependency, HTTP/RLS, real-dealer and terminal closure remain separate.'])
