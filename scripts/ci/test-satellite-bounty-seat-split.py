#!/usr/bin/env python3
"""PostgreSQL 17 qualification: a satellite seat into a bounty, PKO or
mystery-bounty target is booked exactly like a paid entry.

THE MIS-SPLIT (2026-09-04, Sunday Funday High Roller PKO 3f19bd70 and
a21c0cb6). 221 horses reached two PKO events (67.50 buy-in incl. 35.00
bounty, 7.50 fee, 3,500.00 guarantee) by satellite seat. The satellite-award
path in force then credited the whole 67.50 of each seat to the PRIZE ladder
(tournament_escrow.satellite_in = n x 67.50, bounty_in = 0) and
trg_seed_bounty_head raised bounty_pool with no bank behind it. On the
66-entrant event the field received 4,455.00 against an advertised
max(3,500, 66 x 32.50) + 66 x 35.00 = 5,810.00: 1,355.00 short.

From 20260911110907 until 20261017004440 the answer was to refuse: no
satellite could be opened into a bounty target and the settlement authority
refused one ("uses an unsupported bounty or Spin entry split"). Dan,
2026-10-16: "EVERY TOURNAMENT WITH A 25 BUY IN OR HIGHER SHOULD HAVE
SATELLITES INTO IT." Migration 20261017004440 makes the seat a paid entry:
split by fn_tournament_entry_split, the bounty slice on the bounty rail with a
funded head, escrow equal to the counters.

This qualification runs the migration's OWN postimages (read out of the
migration file, so the exact bytes that will be installed) of
fn_settle_satellite_tournament_pre_money_path_gate, its receipt
fn_ca_satellite_settlement_receipt, the seat-entitlement capture trigger and
the creation guard, on top of production's exact escrow triggers, escrow
reconstruction (fn_ca_tournament_escrow_chips), refund plan, bounty-head seed
trigger and mystery chest seed:

RED    the 09-04 arithmetic (production's own fn_tournament_entry_split):
       crediting the whole seat to the prize ladder shorts the 66-entrant
       field by exactly 1,355.00; production's preimage authority refuses the
       PKO target outright.
GREEN  66 satellite seats into the 09-04 PKO shape end funded at exactly
       5,810.00: prize 2,145.00, bounty 2,310.00 (66 funded 35.00 heads, no
       unfunded-head alert), fee 495.00; the stored escrow equals the
       counters and production's reconstruction; the refund plan agrees with
       every entitlement (satellite_gross, 32.50 + 35.00 + 7.50); a capped
       winner's noncash ticket carries the same split; a mystery target's
       chests are built from a pool that counts the seats; a plain target is
       booked exactly as before; Spin, unknown flags, a bounty larger than
       the buy-in and a Diamond bounty target are still refused before any
       write; and every postimage installs to the md5 its @live-proof line
       declares.

No production credentials, no network, no production rows.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = ROOT / 'scripts/ci/probes/satellite-bounty-split'
MIGRATION = ROOT / 'supabase/migrations/20261017004440_satellites_seat_bounty_targets.sql'

# Production identities read 2026-09-26 (prosrc md5) on project kuklfnapbkmacvwxktbh.
PINNED_PROSRC = {
    'fn_tournament_entry_split': '46074e04b60ecb97557b63ef25c5739d',
    'fn_satellite_target_is_deliverable': '04d7e4261b54193a2c46916eb8b9f41e',
    'fn_satellite_feeds_only_a_deliverable_target': 'e5fed8a4fe1dc07bf2628b84d07538ce',
}
# Production identities read 2026-10-16 (md5 of pg_get_functiondef).
PINNED_DEF = {
    'fn_ca_unit_floor_cents': '1aee5e7fa9aa60b575aeccd2793bd215',
    'fn_ca_tournament_unit_cents': '426ba550ff84f4210906a0071538803b',
    'fn_ca_recovery_fee_cents': '3960a8bc558ead330e1e47e7a38e31c4',
    'fn_ca_tournament_fee_ratio': '858c3f3cda609a0b427f294d1c9edf36',
    'fn_poker_diamond_tournament': 'c91028508fecc2d02e9003f2bdc2e38d',
    'fn_ca_tournament_escrow_chips': '0a2f5a27ed0e25e22b9d006f29b3b942',
    'fn_ca_tournament_escrow': '9d06895cfcd2d9902d343e54b633bad0',
    'fn_ca_escrow_apply': 'c6c26c25ab8a8b1222d375c7d6df0d2f',
    'fn_ca_escrow_on_seat_transfer_leg': 'e9c56f9c21635b21c7cf0d456eb18b8a',
    'fn_ca_escrow_on_rake_record': '0dc096bb5615758ed945365a45997c8c',
    'fn_ca_escrow_on_seat_payout': '8a247590515e39c56e717e218b532da1',
    'trg_seed_bounty_head': 'dcc816d3b32709a2ad55398b5d620351',
    'fn_ca_tournament_refund_plan': '5c60c0ab184aaf8dd8a83bae98e513f1',
    'fn_mystery_bounty_unrecorded_head_cents': 'f4ad4a01b350d16084517b3ce58bc6ba',
    'fn_mystery_bounty_seed': 'd8c0baeb38662b55136304d8af9b70fe',
}
PREIMAGE_GATE = ('preimage-fn_settle_satellite_tournament_pre_money_path_gate',
                 'fn_settle_satellite_tournament_pre_money_path_gate',
                 '384887d62082eec9a0d61a9d49d955a2')
OLD_REFUSAL = 'uses an unsupported bounty or Spin entry split'
NEW_REFUSAL = 'uses an unsupported Spin or unknown entry split'
GUARD_REFUSAL = 'the satellite settlement authority refuses a Spin entry split, unknown entry flags or a Diamond bounty'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'artifacts/satellite-bounty-seat-split')
out = parser.parse_args().output.resolve()
out.mkdir(parents=True, exist_ok=True)
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
env['LANG'] = 'C'
cluster = pathlib.Path(tempfile.mkdtemp(prefix='ca-satellite-bounty-split-'))
sock = cluster / 'socket'
sock.mkdir(mode=0o700)
PORT = '55773'
results = {'checks': [], 'production_mutations': False,
           'scope': "Migration 20261017004440's own postimages over production's exact escrow, seed, refund and split functions in an owned PG17 cluster. No production row is read or written."}
psql = [pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', PORT, '-U', 'postgres', '-d', 'postgres']


def command(args, sql=None, timeout=300):
    result = subprocess.run(list(map(str, args)), input=sql, text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def run(sql):
    return command(psql, sql)


def attempt(sql):
    result = subprocess.run(list(map(str, psql)), input='BEGIN;\n' + sql + '\nROLLBACK;\n',
                            text=True, capture_output=True, env=env, timeout=120)
    return result.returncode == 0, result.stderr.strip(), result.stdout.strip()


def check(name, passed, detail=None):
    entry = {'name': name, 'passed': bool(passed)}
    if detail is not None:
        entry['detail'] = detail
    results['checks'].append(entry)
    if not passed:
        raise AssertionError(name + ('' if detail is None else ': ' + str(detail)))


def refused(name, sql, needle):
    ok, err, _ = attempt(sql)
    check(name, (not ok) and needle in err, err[-400:])


def migration_functions():
    """Every CREATE OR REPLACE FUNCTION in the migration, keyed by name, plus
    the md5 each @live-proof line declares for it."""
    text = MIGRATION.read_text()
    bodies = {}
    for m in re.finditer(r'^CREATE OR REPLACE FUNCTION public\.(\w+)\(.*?\$function\$;\n', text, re.S | re.M):
        bodies[m.group(1)] = m.group(0)[:-2] + '\n'
    proofs = dict(re.findall(r"^-- @live-proof: md5\(pg_get_functiondef\('public\.(\w+)\([^']*\)'::regprocedure\)\) = '([0-9a-f]{32})'$", text, re.M))
    return bodies, proofs


SCHEMA = """
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TABLE public.clubs (id uuid PRIMARY KEY, asset text NOT NULL DEFAULT 'chips',
  is_platform boolean NOT NULL DEFAULT false, union_id uuid);
CREATE TABLE public.union_clubs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), union_id uuid, club_id uuid);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY, name text, status text DEFAULT 'ANNOUNCED', variant text,
  tournament_type text DEFAULT 'MTT', club_id uuid, union_id uuid, format_contract text,
  start_time timestamptz, buy_in_amount numeric(15,2), buy_in_fee numeric(15,2),
  bounty_amount numeric(15,2) DEFAULT 0, guaranteed_prize numeric(15,2) DEFAULT 0,
  is_bounty boolean DEFAULT false, is_pko boolean DEFAULT false,
  is_mystery_bounty boolean DEFAULT false, is_premium_spin boolean DEFAULT false,
  satellite_target_id uuid, satellite_target uuid, satellite_seats integer,
  prize_pool numeric(18,2) DEFAULT 0, prize_pool_finalized boolean DEFAULT false,
  total_rake numeric(18,2) DEFAULT 0, bounty_pool numeric(18,2) DEFAULT 0,
  bounty_pool_paid numeric DEFAULT 0, max_players integer, current_players integer DEFAULT 0,
  current_level integer DEFAULT 0, late_reg_levels integer DEFAULT 0, rebuy_levels integer DEFAULT 4,
  ended_at timestamptz, updated_at timestamptz DEFAULT now(), on_break boolean DEFAULT false,
  break_started_at timestamptz, break_ends_at timestamptz, entry_contract_locked boolean DEFAULT false,
  payout_structure text, mystery_bounty_stage text DEFAULT 'pending',
  mystery_bounty_pool_percent numeric DEFAULT 50, mystery_bounty_regular_pool_percent numeric DEFAULT 50,
  mystery_bounty_pool_cents bigint, mystery_bounty_activated_at timestamptz,
  mystery_bounty_activated_players integer, mystery_bounty_activation_generation bigint DEFAULT 0);
CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, user_id uuid, username text,
  chips integer DEFAULT 0, status text DEFAULT 'registered', "position" integer,
  prize numeric(15,2) DEFAULT 0, rebuys integer DEFAULT 0, eliminated_at timestamptz,
  bounties_collected integer DEFAULT 0, bounty_winnings numeric(15,2) DEFAULT 0,
  mystery_bounty_value numeric(15,2) DEFAULT 0, current_bounty numeric DEFAULT 0,
  table_id uuid, club_id uuid, is_satellite_qualifier boolean DEFAULT false,
  source_satellite_id uuid, elimination_sequence bigint, registered_at timestamptz DEFAULT now(),
  UNIQUE (tournament_id, user_id));
-- Production's fn_stamp_entry_club gives a union entrant its member club;
-- every entrant here plays from the host club.
CREATE FUNCTION public.h_stamp_entry_club() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.club_id IS NULL THEN
    SELECT t.club_id INTO NEW.club_id FROM public.tournaments t WHERE t.id = NEW.tournament_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tournament_players_stamp_club BEFORE INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.h_stamp_entry_club();
CREATE TABLE public.tables (id uuid PRIMARY KEY, club_id uuid, tournament_id uuid, name text,
  status text DEFAULT 'waiting', lifecycle text, current_players integer DEFAULT 0,
  terminal_closed_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE TABLE public.table_seats (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid,
  seat_number integer, user_id uuid, stack numeric(15,2) DEFAULT 0, is_sitting_out boolean DEFAULT false,
  is_away boolean DEFAULT false, scheduled_leave_hands integer, left_at timestamptz,
  status text DEFAULT 'active', leave_pending boolean DEFAULT false, sit_out_at timestamptz);
CREATE TABLE public.tournament_escrow (
  tournament_id uuid PRIMARY KEY, enforced boolean DEFAULT true, gross_in numeric DEFAULT 0,
  fee_entries_in numeric DEFAULT 0, satellite_fee_in numeric DEFAULT 0, bounty_in numeric DEFAULT 0,
  overlay_in numeric DEFAULT 0, satellite_in numeric DEFAULT 0, prize_out numeric DEFAULT 0,
  bounty_out numeric DEFAULT 0, fee_out numeric DEFAULT 0, refund_prize numeric DEFAULT 0,
  refund_bounty numeric DEFAULT 0, refund_fee numeric DEFAULT 0,
  prize_balance numeric(15,2) DEFAULT 0, bounty_balance numeric(15,2) DEFAULT 0,
  fee_balance numeric(15,2) DEFAULT 0, opened_at timestamptz DEFAULT now(), opened_from text,
  updated_at timestamptz DEFAULT now(), closed_at timestamptz, close_note text,
  reserve_out numeric DEFAULT 0, reserve_in numeric DEFAULT 0, terminal_closed_at timestamptz);
CREATE TABLE public.chip_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), performed_by uuid, from_type text, from_entity_id uuid,
  from_label text, to_type text, to_entity_id uuid, to_label text, amount numeric(15,2),
  category text DEFAULT 'transfer', description text, club_id uuid, tournament_id uuid,
  created_at timestamptz DEFAULT now(), idempotency_key text UNIQUE, settlement_id text,
  actor_service text, pre_from_balance numeric, post_from_balance numeric, pre_to_balance numeric,
  post_to_balance numeric, status text DEFAULT 'posted', metadata jsonb);
CREATE TABLE public.chip_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid,
  from_user_id uuid, to_user_id uuid, amount numeric(14,2), transaction_type text, notes text,
  metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(), balance_after numeric(14,2));
CREATE TABLE public.rake_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hand_id uuid,
  table_id uuid, club_id uuid, rake_amount numeric(18,4) DEFAULT 0, bbj_contribution numeric(18,4) DEFAULT 0,
  pot_size numeric(18,4), num_players integer, created_at timestamptz DEFAULT now(),
  is_tournament boolean DEFAULT false, tournament_id uuid, source text DEFAULT 'cash_game', metadata jsonb);
CREATE TABLE public.tournament_rake_settlements (tournament_id uuid PRIMARY KEY, club_id uuid,
  amount numeric(15,2) DEFAULT 0, settled_at timestamptz, attributed_at timestamptz);
CREATE TABLE public.wallet_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  wallet_type text, amount numeric(15,2), type text, category text, description text,
  related_entity_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.wallet_credit_idempotency (key text PRIMARY KEY, user_id uuid, amount numeric,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.tournament_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid,
  user_id uuid, "position" integer, amount numeric(15,2) DEFAULT 0, source text, idempotency_key text UNIQUE,
  paid_at timestamptz DEFAULT now(), tournament_type text, field_size integer, prize_pool numeric,
  payout_structure jsonb, recorded_by text, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE public.tournament_obligations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid,
  kind text, place integer, user_id uuid, amount_owed numeric(15,2) DEFAULT 0, amount_paid numeric(15,2) DEFAULT 0,
  source text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), settled_at timestamptz);
CREATE TABLE public.tournament_guarantee_overlays (tournament_id uuid PRIMARY KEY, amount numeric(15,2));
CREATE TABLE public.tournament_refund_tranches (tournament_id uuid, user_id uuid, entitlement_id uuid,
  source_wallet_club_id uuid, amount_paid_now numeric(15,2), refund_prize numeric(15,2),
  refund_bounty numeric(15,2), refund_fee numeric(15,2));
CREATE TABLE public.spin_reserve_ledger (tournament_id uuid, kind text, amount numeric);
CREATE TABLE public.poker_diamond_tournament_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid, kind text, amount numeric, idempotency_key text, user_id uuid, prize_part numeric,
  bounty_part numeric, fee_part numeric, registration_id uuid, wallet_journal_id uuid, custody_id uuid);
CREATE TABLE public.poker_diamond_custody (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  purpose text, target_id uuid, entry_key text);
CREATE TABLE public.tournament_knockout_candidates (tournament_id uuid, eliminated_user_id uuid, state text);
CREATE TABLE public.tournament_bounty_chests (tournament_id uuid, seq integer, tier text, amount_cents bigint,
  status text DEFAULT 'available', PRIMARY KEY (tournament_id, seq));
CREATE TABLE public.financial_alerts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), severity text, source text,
  message text, context jsonb DEFAULT '{}', resolved boolean DEFAULT false, created_at timestamptz DEFAULT now());

-- The immutable settlement evidence, with production's own CHECK contracts.
CREATE TABLE public.tournament_satellite_settlements (
  tournament_id uuid PRIMARY KEY, target_id uuid, target_was_missing boolean DEFAULT false,
  target_contract_version bigint, winner_id uuid, field_size integer, advertised_seats integer,
  pool numeric(15,2), target_buy_in numeric(15,2), target_fee numeric(15,2), ticket_cost numeric(15,2),
  ticket_award_count integer, seat_count integer, cash_ticket_count integer, entry_ticket_count integer,
  remainder numeric(15,2), bubble_user_id uuid, bubble_position integer, source_table_count integer,
  source_table_ids uuid[], source_seat_count integer, source_seat_ids uuid[], released_seat_count integer,
  released_seat_ids uuid[], source_closed_at timestamptz, source_escrow_closed_at timestamptz,
  source_escrow_close_note text, settled_at timestamptz DEFAULT now(), receipt_version integer DEFAULT 2,
  qualifier_ids uuid[],
  CHECK ((target_id <> tournament_id)),
  CHECK ((ticket_cost = (target_buy_in + target_fee))),
  CHECK ((ticket_award_count = ((seat_count + cash_ticket_count) + entry_ticket_count))),
  CHECK ((ticket_award_count <= field_size)),
  CHECK ((pool = (((ticket_award_count)::numeric * ticket_cost) + remainder))),
  CHECK ((pool >= ((advertised_seats)::numeric * ticket_cost))),
  CHECK ((remainder < ticket_cost)),
  CHECK (((target_was_missing IS FALSE) AND (target_contract_version IS NULL))),
  CHECK ((((remainder = (0)::numeric) AND (bubble_user_id IS NULL) AND (bubble_position IS NULL)) OR ((remainder > (0)::numeric) AND (bubble_user_id IS NOT NULL) AND (bubble_position = (ticket_award_count + 1)) AND (bubble_position <= field_size))) IS TRUE),
  CHECK (((ticket_cost > (0)::numeric) AND (ticket_cost = round(ticket_cost, 2)))),
  CHECK (((target_buy_in >= (0)::numeric) AND (target_buy_in = round(target_buy_in, 2)))),
  CHECK (((target_fee >= (0)::numeric) AND (target_fee = round(target_fee, 2)))));
CREATE TABLE public.tournament_satellite_awards (
  tournament_id uuid, place integer CHECK (place > 0), user_id uuid, delivery_kind text, amount numeric(15,2),
  payout_id uuid UNIQUE, payout_source text, idempotency_key text UNIQUE, registration_id uuid UNIQUE,
  ticket_id uuid UNIQUE, obligation_id uuid, obligation_kind text, created_at timestamptz DEFAULT now(),
  UNIQUE (tournament_id, user_id),
  CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)))),
  CHECK ((((delivery_kind = 'seat'::text) AND (registration_id IS NOT NULL) AND (ticket_id IS NULL) AND (obligation_id IS NULL) AND (obligation_kind IS NULL) AND (payout_source = 'satellite_seat'::text)) OR ((delivery_kind = 'cash'::text) AND (registration_id IS NULL) AND (ticket_id IS NULL) AND (obligation_id IS NOT NULL) AND (obligation_kind = ANY (ARRAY['seat'::text, 'place'::text])) AND (payout_source <> 'satellite_seat'::text)) OR ((delivery_kind = 'ticket'::text) AND (registration_id IS NULL) AND (ticket_id IS NOT NULL) AND (obligation_id IS NULL) AND (obligation_kind IS NULL) AND (payout_source = 'satellite_ticket'::text))) IS TRUE));
CREATE TABLE public.tournament_satellite_remainders (tournament_id uuid PRIMARY KEY, user_id uuid, place integer,
  amount numeric(15,2), payout_id uuid, payout_source text, payout_position integer, idempotency_key text,
  obligation_id uuid, obligation_kind text, obligation_place integer, evidence_kind text,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.tournament_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, issued_by uuid, holder_id uuid,
  value numeric CHECK (value > 0), note text, status text DEFAULT 'issued', redeemed_at timestamptz,
  cancelled_at timestamptz, created_at timestamptz DEFAULT now(), redemption_mode text DEFAULT 'wallet_chips',
  source_tournament_id uuid, source_satellite_id uuid, source_refund_entitlement_id uuid,
  source_satellite_award_place integer, entry_prize numeric(15,2), entry_bounty numeric(15,2),
  entry_fee numeric(15,2),
  CHECK (((((redemption_mode = 'wallet_chips'::text) AND (source_tournament_id IS NULL) AND (source_satellite_id IS NULL) AND (source_refund_entitlement_id IS NULL) AND (source_satellite_award_place IS NULL) AND (entry_prize IS NULL) AND (entry_bounty IS NULL) AND (entry_fee IS NULL)) OR ((redemption_mode = 'tournament_entry_only'::text) AND (issued_by = '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid) AND (source_tournament_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (((source_refund_entitlement_id IS NOT NULL) AND (source_satellite_award_place IS NULL)) OR ((source_refund_entitlement_id IS NULL) AND (source_satellite_award_place > 0) AND (source_tournament_id <> source_satellite_id))) AND (entry_prize IS NOT NULL) AND (entry_prize >= (0)::numeric) AND (entry_prize = round(entry_prize, 2)) AND (entry_bounty IS NOT NULL) AND (entry_bounty >= (0)::numeric) AND (entry_bounty = round(entry_bounty, 2)) AND (entry_fee IS NOT NULL) AND (entry_fee >= (0)::numeric) AND (entry_fee = round(entry_fee, 2)) AND (value = round(((entry_prize + entry_bounty) + entry_fee), 2)))) IS TRUE)));
CREATE TABLE public.tournament_refund_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, user_id uuid, entitlement_kind text,
  charge_category text, refund_wallet_club_id uuid, gross numeric(15,2), refund_prize numeric(15,2),
  refund_bounty numeric(15,2), refund_fee numeric(15,2), source_ledger_id uuid UNIQUE, registration_id uuid,
  source_satellite_id uuid, source_award_place integer, source_ticket_id uuid, escrow_bucket text,
  evidence_kind text, created_at timestamptz DEFAULT transaction_timestamp(),
  UNIQUE (tournament_id, user_id, entitlement_kind, source_ledger_id),
  CHECK ((gross = ((refund_prize + refund_bounty) + refund_fee))),
  CHECK ((((entitlement_kind = 'wallet_charge'::text) AND (charge_category = ANY (ARRAY['tournament_buyin'::text, 'rebuy'::text, 'addon'::text])) AND (registration_id IS NULL) AND (source_satellite_id IS NULL) AND (source_award_place IS NULL) AND (source_ticket_id IS NULL) AND (escrow_bucket = 'wallet_gross'::text) AND (evidence_kind = ANY (ARRAY['atomic_wallet_charge'::text, 'cutover_wallet_charge'::text]))) OR ((entitlement_kind = 'satellite_seat'::text) AND (charge_category = 'satellite_seat'::text) AND (registration_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (source_satellite_id <> tournament_id) AND (source_award_place > 0) AND (source_ticket_id IS NULL) AND (escrow_bucket = ANY (ARRAY['satellite_gross'::text, 'satellite_in'::text])) AND (evidence_kind = ANY (ARRAY['atomic_satellite_seat'::text, 'cutover_satellite_seat'::text]))) OR ((entitlement_kind = 'tournament_ticket'::text) AND (charge_category = 'tournament_ticket'::text) AND (registration_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (source_award_place IS NULL) AND (source_ticket_id IS NOT NULL) AND (escrow_bucket = 'ticket_gross'::text) AND (evidence_kind = 'atomic_tournament_ticket'::text))) IS TRUE),
  CHECK (((refund_prize >= (0)::numeric) AND (refund_prize = round(refund_prize, 2)))),
  CHECK (((refund_bounty >= (0)::numeric) AND (refund_bounty = round(refund_bounty, 2)))),
  CHECK (((refund_fee >= (0)::numeric) AND (refund_fee = round(refund_fee, 2)))));

CREATE TABLE public.club_members (club_id uuid, user_id uuid, status text DEFAULT 'active', role text);
-- Harness knob: the concurrent game load each winner reports.
CREATE TABLE public.h_game_load (user_id uuid PRIMARY KEY, load integer NOT NULL);
-- Harness knob: which RUNNING targets are inside late registration.
CREATE TABLE public.h_late_open (tournament_id uuid PRIMARY KEY);
"""

# The parts of the estate this qualification does not exercise. Each stand-in
# does exactly what the real authority does to the rows read here, and no more.
STUBS = """
CREATE FUNCTION public.fn_ca_lock_mtt_admission_contract() RETURNS text LANGUAGE sql AS $$ SELECT 'unlimited-mtt-v2'::text $$;
CREATE FUNCTION public.fn_ca_lock_settlement_lane_for_satellite_finish(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.fn_lock_accounting_tournament_recognition_week(uuid, timestamptz) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.fn_ca_assert_satellite_asset(p_satellite uuid, p_target uuid) RETURNS boolean
  LANGUAGE plpgsql AS $$ BEGIN RETURN public.fn_poker_diamond_tournament(p_target); END $$;
CREATE FUNCTION public.fn_poker_diamond_tournament_open_shadow(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.fn_poker_diamond_tournament_escrow(uuid)
  RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric,
                prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric,
                prize_balance numeric, bounty_balance numeric, fee_balance numeric)
  LANGUAGE sql AS $$ SELECT NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,
                            NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric,NULL::numeric WHERE false $$;
CREATE FUNCTION public.fn_poker_diamond_tournament_custody(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE FUNCTION public.fn_ca_tournament_bust_at(uuid, uuid) RETURNS timestamptz LANGUAGE sql AS $$ SELECT NULL::timestamptz $$;
CREATE FUNCTION public.fn_ca_tournament_is_unlimited(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.fn_tournament_late_registration_open(p_tournament uuid) RETURNS boolean
  LANGUAGE sql AS $$ SELECT EXISTS (SELECT 1 FROM public.h_late_open o WHERE o.tournament_id = p_tournament) $$;
CREATE FUNCTION public.fn_concurrent_game_load(p_user uuid, a uuid, b uuid, c uuid) RETURNS integer
  LANGUAGE sql AS $$ SELECT COALESCE((SELECT l.load FROM public.h_game_load l WHERE l.user_id = p_user), 0) $$;
CREATE FUNCTION public.fn_tournament_club_for_user(uuid, uuid, p_club uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT p_club $$;
CREATE FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"status":"harness"}'::jsonb $$;
-- fn_credit_and_log: the wallet credit, its idempotency key, the payout row it
-- writes for a positioned prize, and the prize_out the wallet journal trigger
-- books in the event's escrow.
CREATE FUNCTION public.fn_credit_and_log(p_user_id uuid, p_amount numeric, p_idempotency_key text,
  p_category text, p_description text, p_related_entity_id uuid, p_wallet_type text, p_table_id uuid,
  p_hand_id uuid, p_payout_position integer, p_payout_source text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.wallet_credit_idempotency(key, user_id, amount) VALUES (p_idempotency_key, p_user_id, p_amount);
  INSERT INTO public.wallet_transactions(user_id, wallet_type, amount, type, category, description, related_entity_id)
  VALUES (p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description, p_related_entity_id);
  INSERT INTO public.tournament_payouts(tournament_id, user_id, "position", amount, source, idempotency_key, recorded_by)
  VALUES (p_related_entity_id, p_user_id, p_payout_position, p_amount, p_payout_source, p_idempotency_key, 'credit_and_log');
  PERFORM public.fn_ca_escrow_apply(p_related_entity_id, 'prize credit', p_prize_out => p_amount);
  RETURN true;
END $$;
-- fn_settle_tournament_rake: the satellite's whole fee bank leaves to the
-- club, settled and attributed.
CREATE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  INSERT INTO public.tournament_rake_settlements(tournament_id, amount, settled_at, attributed_at)
  VALUES (p_tournament_id, v, now(), now());
  PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'rake out', p_fee_out => v);
  RETURN jsonb_build_object('ok', true, 'amount', v, 'attributed', true);
END $$;
"""

TRIGGERS = """
CREATE TRIGGER zz_ca_escrow_seat_transfer_leg AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.to_type = 'prize_liability'::text) AND (new.idempotency_key ~~ 'tourney:%:seat:%:pool_transfer'::text))) EXECUTE FUNCTION fn_ca_escrow_on_seat_transfer_leg();
CREATE TRIGGER zz_ca_escrow_rake_record AFTER INSERT ON public.rake_records FOR EACH ROW WHEN (((new.is_tournament IS TRUE) AND (new.tournament_id IS NOT NULL))) EXECUTE FUNCTION fn_ca_escrow_on_rake_record();
CREATE TRIGGER zz_ca_escrow_seat_payout AFTER INSERT ON public.tournament_payouts FOR EACH ROW WHEN ((new.source = 'satellite_seat'::text)) EXECUTE FUNCTION fn_ca_escrow_on_seat_payout();
CREATE TRIGGER seed_bounty_head AFTER INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION trg_seed_bounty_head();
CREATE TRIGGER tournament_satellite_award_captures_refund_entitlement AFTER INSERT ON public.tournament_satellite_awards FOR EACH ROW WHEN ((new.delivery_kind = 'seat'::text)) EXECUTE FUNCTION fn_ca_capture_satellite_seat_entitlement();
CREATE TRIGGER satellite_feeds_only_a_deliverable_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_satellite_feeds_only_a_deliverable_target();
"""

CLUB = "'00000000-0000-0000-0000-0000000000c1'"
DIAMOND_CLUB = "'00000000-0000-0000-0000-0000000000d1'"


def fixture(sat, target, field, pool, seats, *, target_sql, winner_load=0):
    """A finished satellite: one winner still playing, field-1 sequenced busts,
    its finalized pool and fee in escrow, one table with the winner's chair."""
    fee = round(pool * 0.1, 2)
    return f"""
{target_sql}
SELECT public.fn_ca_escrow_apply('{target}', 'harness target open');
INSERT INTO public.tournaments(id, name, status, variant, tournament_type, club_id, buy_in_amount, buy_in_fee,
  satellite_target_id, satellite_seats, prize_pool, prize_pool_finalized)
VALUES ('{sat}', 'Satellite', 'RUNNING', 'satellite', 'SATELLITE', {CLUB}, 10, 1, '{target}', {seats}, {pool}, true);
SELECT public.fn_ca_escrow_apply('{sat}', 'harness source open');
SELECT public.fn_ca_escrow_apply('{sat}', 'harness source entries', p_gross_in => {pool} + {fee});
INSERT INTO public.rake_records(club_id, rake_amount, pot_size, num_players, is_tournament, tournament_id, source, metadata)
VALUES ({CLUB}, {fee}, {pool} + {fee}, {field}, true, '{sat}', 'fn_register_for_tournament', '{{"kind":"tournament_entry_fee"}}');
INSERT INTO public.tournament_players(tournament_id, user_id, username, status, elimination_sequence, eliminated_at)
SELECT '{sat}', ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'P' || g,
       CASE WHEN g = 1 THEN 'playing' ELSE 'eliminated' END,
       CASE WHEN g = 1 THEN NULL ELSE {field} + 1 - g END,
       CASE WHEN g = 1 THEN NULL ELSE timestamptz '2026-10-16 12:00:00+00' - make_interval(secs => g) END
  FROM generate_series(1, {field}) g;
INSERT INTO public.h_game_load(user_id, load) VALUES ('00000000-0000-4000-8000-000000000001', {winner_load});
INSERT INTO public.tables(id, club_id, tournament_id, name, status, current_players)
VALUES (gen_random_uuid(), {CLUB}, '{sat}', 'Final', 'running', 1);
INSERT INTO public.table_seats(table_id, seat_number, user_id, stack)
SELECT tb.id, 1, '00000000-0000-4000-8000-000000000001', 1000 FROM public.tables tb WHERE tb.tournament_id = '{sat}';
"""


def target_row(tid, *, buy_in=67.50, fee=7.50, bounty=35.00, flags="true, true, false, false",
               variant="'progressive_bounty'", ttype="'MTT'", club=CLUB, guarantee=3500):
    return (f"INSERT INTO public.tournaments(id, name, status, variant, tournament_type, club_id, format_contract, "
            f"buy_in_amount, buy_in_fee, bounty_amount, guaranteed_prize, is_bounty, is_pko, is_mystery_bounty, "
            f"is_premium_spin, max_players) VALUES ('{tid}', 'Target', 'REGISTERING', {variant}, {ttype}, {club}, "
            f"'mtt-v2', {buy_in}, {fee}, {bounty}, {guarantee}, {flags}, NULL);")


SETTLE = "SELECT public.fn_settle_satellite_tournament_pre_money_path_gate('{sat}', '00000000-0000-4000-8000-000000000001');"

try:
    check('postgres-17', command([pg / 'postgres', '--version']).startswith('postgres (PostgreSQL) 17.'))
    command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log',
             '-o', f"-k {sock} -p {PORT} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=8",
             '-w', 'start'])
    run(SCHEMA)
    run(f"INSERT INTO public.clubs(id, asset, is_platform) VALUES ({CLUB}, 'chips', false), ({DIAMOND_CLUB}, 'diamonds', true);")

    run(STUBS)
    # Production's exact functions, each proved to be production's text.
    for name, want in PINNED_PROSRC.items():
        run((PROBE / f'{name}.sql').read_text() + ';')
        got = run(f"SELECT md5(prosrc) FROM pg_proc WHERE proname='{name}'")
        check(f'exact-production-{name}', got == want, got)
    for name, want in PINNED_DEF.items():
        text = (PROBE / f'{name}.sql').read_text()
        check(f'exact-production-text-{name}', hashlib.md5(text.encode()).hexdigest() == want)
        run(text + ';')
        got = run(f"SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.proname='{name}'")
        check(f'exact-production-{name}', got == want, got)
    pre_file, pre_name, pre_md5 = PREIMAGE_GATE
    pre_text = (PROBE / f'{pre_file}.sql').read_text()
    check('exact-production-preimage-gate-text', hashlib.md5(pre_text.encode()).hexdigest() == pre_md5)

    # ------------------------------------------------------------------ RED ---
    short = run("""
      SELECT string_agg(n || ':' || round(owed - paid, 2), ',' ORDER BY n)
        FROM (SELECT n, GREATEST(3500.00, n * s.prize) + n * s.bounty AS owed, n * 67.50 AS paid
                FROM (VALUES (66), (155)) v(n)
                CROSS JOIN LATERAL public.fn_tournament_entry_split(67.50, 7.50, 35.00, true) s) z""")
    check('RED-the-0904-mis-split-shorts-66-entrants-by-1355-and-155-by-0', short == '66:1355.00,155:0.00', short)
    split = run("SELECT charge || '/' || rake || '/' || bounty || '/' || prize FROM public.fn_tournament_entry_split(67.50, 7.50, 35.00, true)")
    check('the-split-carves-35-bounty-and-32.50-prize-from-a-75-seat', split == '75.00/7.50/35.00/32.50', split)

    # The migration's own bytes, and the md5 each @live-proof line declares.
    bodies, proofs = migration_functions()
    check('the-migration-declares-every-postimage', set(bodies) == set(proofs) and len(bodies) == 11,
          sorted(set(bodies) ^ set(proofs)))
    # Production's preimage authority on the PKO: refused before any write.
    # The award and creation triggers attach once their postimages exist.
    trig = [line for line in TRIGGERS.split('\n') if line.strip()]
    run('\n'.join(trig[:4]))
    run(bodies['fn_ca_satellite_settlement_receipt'] + ';')
    run(pre_text + ';')
    S0, T0 = '10000000-0000-4000-8000-000000000000', '20000000-0000-4000-8000-000000000000'
    refused('RED-production-refuses-the-0904-PKO-target-before-any-write',
            fixture(S0, T0, 2, 95.00, 1, target_sql=target_row(T0)) + SETTLE.format(sat=S0), OLD_REFUSAL)

    # Every postimage installs (check_function_bodies on), and to exactly the
    # md5 its @live-proof line declares.
    for name, body in bodies.items():
        run(body + ';')
        got = run(f"SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.proname='{name}'")
        check(f'postimage-{name}-installs-to-its-declared-md5', got == proofs[name], got)
    run('\n'.join(trig[4:]))

    def settle(sat, target, field, pool, seats, **kw):
        return fixture(sat, target, field, pool, seats, **kw) + SETTLE.format(sat=sat)

    # ---------------------------------------------------------------- GREEN ---
    # 66 seats (field 67, pool 66 x 75.00 + 20.00) into the 09-04 PKO shape.
    S, T = '10000000-0000-4000-8000-000000000066', '20000000-0000-4000-8000-000000000066'
    probe66 = settle(S, T, 67, 4970.00, 66, target_sql=target_row(T)) + f"""
SELECT json_build_object(
  'seat_count', (SELECT seat_count FROM public.tournament_satellite_settlements WHERE tournament_id = '{S}'),
  'prize_pool', (SELECT prize_pool FROM public.tournaments WHERE id = '{T}'),
  'bounty_pool', (SELECT bounty_pool FROM public.tournaments WHERE id = '{T}'),
  'total_rake', (SELECT total_rake FROM public.tournaments WHERE id = '{T}'),
  'current_players', (SELECT current_players FROM public.tournaments WHERE id = '{T}'),
  'funded_field', (SELECT GREATEST(guaranteed_prize, prize_pool) + bounty_pool FROM public.tournaments WHERE id = '{T}'),
  'escrow', (SELECT json_build_object('prize', prize_balance, 'bounty', bounty_balance, 'fee', fee_balance,
                                      'gross_in', gross_in, 'bounty_in', bounty_in, 'satellite_in', satellite_in,
                                      'satellite_fee_in', satellite_fee_in)
               FROM public.tournament_escrow WHERE tournament_id = '{T}'),
  'shadow', (SELECT json_build_object('prize', prize_balance, 'bounty', bounty_balance, 'fee', fee_balance)
               FROM public.fn_ca_tournament_escrow_chips('{T}')),
  'heads', (SELECT json_build_object('n', count(*), 'sum', sum(current_bounty), 'min', min(current_bounty))
              FROM public.tournament_players WHERE tournament_id = '{T}'),
  'unfunded_head_alerts', (SELECT count(*) FROM public.financial_alerts WHERE source = 'trg_seed_bounty_head'),
  'entitlements', (SELECT json_build_object('n', count(*), 'bucket', min(escrow_bucket), 'prize', min(refund_prize),
                                            'bounty', min(refund_bounty), 'fee', min(refund_fee))
                     FROM public.tournament_refund_entitlements WHERE tournament_id = '{T}'),
  'v2_legs', (SELECT count(*) FROM public.chip_ledger WHERE to_entity_id = '{T}'
                AND metadata->>'entry_split_version' = '2' AND (metadata->>'entry_bounty')::numeric = 35.00),
  'refund_plan_rows', (SELECT count(*) FROM public.fn_ca_tournament_refund_plan('{T}', '00000000-0000-4000-8000-000000000001')),
  'source_escrow', (SELECT json_build_object('prize', prize_balance, 'fee', fee_balance, 'closed', closed_at IS NOT NULL)
                      FROM public.tournament_escrow WHERE tournament_id = '{S}'),
  'replay', (SELECT (public.fn_ca_satellite_settlement_receipt('{S}', '00000000-0000-4000-8000-000000000001')->>'seat_count')));
"""
    ok, err, outp = attempt(probe66)
    check('GREEN-66-seats-into-the-0904-PKO-settle', ok, err[:600])
    got = json.loads(outp.splitlines()[-1])
    results['pko_66'] = got
    check('GREEN-66-seats-are-delivered-as-seats', got['seat_count'] == 66 and got['current_players'] == 66, got)
    check('GREEN-the-field-is-funded-at-exactly-5810.00', float(got['funded_field']) == 5810.00, got['funded_field'])
    check('GREEN-prize-2145-bounty-2310-fee-495',
          (float(got['prize_pool']), float(got['bounty_pool']), float(got['total_rake'])) == (2145.00, 2310.00, 495.00), got)
    e = got['escrow']
    check('GREEN-the-escrow-equals-the-counters',
          (float(e['prize']), float(e['bounty']), float(e['fee'])) == (2145.00, 2310.00, 495.00), e)
    check('GREEN-the-bounty-slice-is-on-the-bounty-rail-not-satellite-in',
          (float(e['gross_in']), float(e['bounty_in']), float(e['satellite_in']), float(e['satellite_fee_in']))
          == (66 * 67.50, 2310.00, 0.0, 495.00), e)
    check('GREEN-production-reconstruction-agrees-with-the-stored-escrow',
          {k: float(v) for k, v in got['shadow'].items()} == {'prize': 2145.0, 'bounty': 2310.0, 'fee': 495.0}, got['shadow'])
    check('GREEN-every-head-is-a-funded-35.00',
          got['heads']['n'] == 66 and float(got['heads']['sum']) == 2310.00 and float(got['heads']['min']) == 35.00, got['heads'])
    check('GREEN-no-unfunded-bounty-head-was-seeded', got['unfunded_head_alerts'] == 0, got['unfunded_head_alerts'])
    check('GREEN-every-seat-refunds-its-exact-split',
          got['entitlements'] == {'n': 66, 'bucket': 'satellite_gross', 'prize': 32.50, 'bounty': 35.00, 'fee': 7.50},
          got['entitlements'])
    check('GREEN-every-seat-leg-names-its-split', got['v2_legs'] == 66, got['v2_legs'])
    check('GREEN-the-refund-plan-agrees-with-every-entitlement', got['refund_plan_rows'] == 0, got['refund_plan_rows'])
    check('GREEN-the-satellite-closes-at-zero',
          got['source_escrow'] == {'prize': 0.00, 'fee': 0.00, 'closed': True}, got['source_escrow'])
    check('GREEN-the-receipt-replays-the-bounty-seats', got['replay'] == '66', got['replay'])

    # A late seat into a RUNNING PKO after a knockout. Its bounty bank is the
    # pool less what the knockout paid (production 2026-10-16: every RUNNING
    # bounty event holds bounty_balance = bounty_pool - bounty_pool_paid), so a
    # pre-check of bounty_balance = bounty_pool would refuse every late seat.
    S, T = '10000000-0000-4000-8000-00000000001a', '20000000-0000-4000-8000-00000000001a'
    running = target_row(T) + f"""
UPDATE public.tournaments SET status = 'RUNNING', current_level = 2, current_players = 2,
       prize_pool = 65.00, bounty_pool = 70.00, bounty_pool_paid = 35.00, total_rake = 15.00 WHERE id = '{T}';
INSERT INTO public.h_late_open(tournament_id) VALUES ('{T}');
INSERT INTO public.tournament_players(tournament_id, user_id, username, status, current_bounty)
VALUES ('{T}', '30000000-0000-4000-8000-000000000001', 'Paid A', 'playing', 52.50),
       ('{T}', '30000000-0000-4000-8000-000000000002', 'Paid B', 'eliminated', 35.00);
"""
    ok, err, outp = attempt(running.replace(target_row(T), target_row(T) + f"""
SELECT public.fn_ca_escrow_apply('{T}', 'harness target open');
SELECT public.fn_ca_escrow_apply('{T}', 'two paid entries and one knockout', p_gross_in => 150.00,
       p_fee_entries_in => 15.00, p_bounty_in => 70.00, p_bounty_out => 35.00);""")
        + fixture(S, T, 2, 95.00, 1, target_sql='SELECT 1;').replace(
            f"SELECT public.fn_ca_escrow_apply('{T}', 'harness target open');", '')
        + SETTLE.format(sat=S) + f"""
SELECT json_build_object(
  'kind', (SELECT delivery_kind FROM public.tournament_satellite_awards WHERE tournament_id = '{S}'),
  'pools', (SELECT prize_pool || '/' || bounty_pool || '/' || bounty_pool_paid || '/' || total_rake || '/' || current_players
              FROM public.tournaments WHERE id = '{T}'),
  'escrow', (SELECT prize_balance || '/' || bounty_balance || '/' || fee_balance
               FROM public.tournament_escrow WHERE tournament_id = '{T}'));
""")
    check('GREEN-a-late-seat-into-a-running-PKO-after-a-knockout-settles', ok, err[:600])
    got = json.loads(outp.splitlines()[-1])
    check('GREEN-the-late-seat-funds-its-head-beside-the-paid-knockout',
          got == {'kind': 'seat', 'pools': '97.50/105.00/35.00/22.50/3', 'escrow': '97.50/70.00/22.50'}, got)

    # A four-table-cap winner: a noncash ticket carrying the same split.
    S, T = '10000000-0000-4000-8000-0000000000ca', '20000000-0000-4000-8000-0000000000ca'
    ok, err, outp = attempt(settle(S, T, 2, 95.00, 1, target_sql=target_row(T), winner_load=4) + f"""
INSERT INTO public.club_members(club_id, user_id) VALUES ({CLUB}, '00000000-0000-4000-8000-000000000001');
SELECT json_build_object('kind', (SELECT delivery_kind FROM public.tournament_satellite_awards WHERE tournament_id = '{S}'),
  'ticket', (SELECT json_build_object('value', value, 'prize', entry_prize, 'bounty', entry_bounty, 'fee', entry_fee)
               FROM public.tournament_tickets WHERE source_satellite_id = '{S}'),
  'target_untouched', (SELECT prize_pool = 0 AND bounty_pool = 0 FROM public.tournaments WHERE id = '{T}'),
  'finder', (SELECT (public.fn_ca_find_tournament_entry_ticket_for('{T}', '00000000-0000-4000-8000-000000000001')->>'ticket_id')::uuid
                    IS NOT DISTINCT FROM (SELECT id FROM public.tournament_tickets WHERE source_satellite_id = '{S}')));
""")
    check('GREEN-a-capped-winner-settles', ok, err[:600])
    got = json.loads(outp.splitlines()[-1])
    check('GREEN-a-capped-winners-ticket-carries-the-split-and-the-finder-offers-it',
          got == {'kind': 'ticket', 'ticket': {'value': 75.00, 'prize': 32.50, 'bounty': 35.00, 'fee': 7.50},
                  'target_untouched': True, 'finder': True}, got)

    # A mystery-bounty target: the chests are built from a pool counting seats.
    S, T = '10000000-0000-4000-8000-0000000000ab', '20000000-0000-4000-8000-0000000000ab'
    ok, err, outp = attempt(settle(S, T, 5, 300.00, 4, target_sql=target_row(
        T, flags='true, false, true, false', variant="'mystery_bounty'", guarantee=0)) + f"""
UPDATE public.tournaments SET prize_pool_finalized = true WHERE id = '{T}';
SELECT json_build_object('bounty_pool', (SELECT bounty_pool FROM public.tournaments WHERE id = '{T}'),
  'seed', public.fn_mystery_bounty_seed('{T}', 4,
     '[{{"seq":1,"tier":"a","amount_cents":3000}},{{"seq":2,"tier":"b","amount_cents":2000}},{{"seq":3,"tier":"c","amount_cents":2000}}]'::jsonb));
""")
    check('GREEN-satellite-seats-into-a-mystery-target-settle', ok, err[:600])
    got = json.loads(outp.splitlines()[-1])
    check('GREEN-the-mystery-chests-count-the-satellite-seats',
          float(got['bounty_pool']) == 140.00 and got['seed'].get('ok') is True
          and got['seed'].get('pool_cents') == 7000, got)

    # A plain target is booked exactly as before.
    S, T = '10000000-0000-4000-8000-0000000000aa', '20000000-0000-4000-8000-0000000000aa'
    ok, err, outp = attempt(settle(S, T, 2, 60.00, 1, target_sql=target_row(
        T, buy_in=45.00, fee=5.00, bounty=0, flags='false, false, false, false', variant="'freezeout'")) + f"""
SELECT json_build_object(
  'escrow', (SELECT json_build_object('gross_in', gross_in, 'satellite_in', satellite_in, 'bounty_in', bounty_in,
                                      'prize', prize_balance, 'fee', fee_balance)
               FROM public.tournament_escrow WHERE tournament_id = '{T}'),
  'bucket', (SELECT escrow_bucket || '/' || refund_prize || '/' || refund_bounty || '/' || refund_fee
               FROM public.tournament_refund_entitlements WHERE tournament_id = '{T}'),
  'v2', (SELECT count(*) FROM public.chip_ledger WHERE metadata ? 'entry_split_version'),
  'head', (SELECT current_bounty FROM public.tournament_players WHERE tournament_id = '{T}'));
""")
    check('GREEN-a-plain-target-still-settles', ok, err[:600])
    got = json.loads(outp.splitlines()[-1])
    check('GREEN-a-plain-seat-is-booked-exactly-as-before',
          got == {'escrow': {'gross_in': 0, 'satellite_in': 45.00, 'bounty_in': 0, 'prize': 45.00, 'fee': 5.00},
                  'bucket': 'satellite_in/45.00/0.00/5.00', 'v2': 0, 'head': 0}, got)

    # Still refused, before any write.
    for label, sql_target, needle in (
        ('a-spin-target', target_row('20000000-0000-4000-8000-0000000005e1', variant="'spin'"), NEW_REFUSAL),
        ('a-premium-spin-target', target_row('20000000-0000-4000-8000-0000000005e1', flags='false, false, false, true',
                                             variant="'freezeout'"), NEW_REFUSAL),
        ('an-unknown-flag', target_row('20000000-0000-4000-8000-0000000005e1', flags='true, NULL, false, false'), NEW_REFUSAL),
        ('a-bounty-larger-than-the-buy-in', target_row('20000000-0000-4000-8000-0000000005e1', bounty=80.00),
         'has a misconfigured bounty split'),
        ('a-diamond-bounty-target', target_row('20000000-0000-4000-8000-0000000005e1', club=DIAMOND_CLUB),
         'Diamond target'),
    ):
        tid, sid = '20000000-0000-4000-8000-0000000005e1', '10000000-0000-4000-8000-0000000005e1'
        # The settlement's own refusal, behind the creation guard (bypassed
        # here exactly as a target changed after its satellite opened).
        sql = ('ALTER TABLE public.tournaments DISABLE TRIGGER satellite_feeds_only_a_deliverable_target;\n'
               + fixture(sid, tid, 2, 95.00, 1, target_sql=sql_target) + SETTLE.format(sat=sid))
        ok, err, outp = attempt(sql + f"""
SELECT 1;""")
        check(f'GREEN-the-authority-still-refuses-{label}', (not ok) and needle in err, err[-400:])

    # The creation guard opens a satellite into a bounty target, and only that.
    PKO, SAT = "'20000000-0000-4000-8000-00000000f019'", "'10000000-0000-4000-8000-00000000005a'"
    for label, sql_target in (
        ('a-pko', target_row(PKO.strip("'"))),
        ('a-flat-bounty', target_row(PKO.strip("'"), flags='true, false, false, false', variant="'bounty'")),
        ('a-mystery-bounty', target_row(PKO.strip("'"), flags='true, false, true, false', variant="'mystery_bounty'")),
    ):
        ok, err, _ = attempt(sql_target + f"\nINSERT INTO public.tournaments(id, name, variant, club_id, satellite_target_id) "
                                          f"VALUES ({SAT}, 'S', 'satellite', {CLUB}, {PKO});")
        check(f'GREEN-a-satellite-can-be-opened-into-{label}-target', ok, err[-300:])
    for label, sql_target in (
        ('a-spin', target_row(PKO.strip("'"), variant="'spin'")),
        ('a-premium-spin', target_row(PKO.strip("'"), flags='false, false, false, true', variant="'freezeout'")),
        ('an-unknown-flag', target_row(PKO.strip("'"), flags='true, NULL, false, false')),
        ('a-diamond-bounty', target_row(PKO.strip("'"), club=DIAMOND_CLUB)),
    ):
        refused(f'GREEN-a-satellite-into-{label}-target-is-still-refused',
                sql_target + f"\nINSERT INTO public.tournaments(id, name, variant, club_id, satellite_target_id) "
                             f"VALUES ({SAT}, 'S', 'satellite', {CLUB}, {PKO});", GUARD_REFUSAL)
    refused('GREEN-a-live-satellite-target-cannot-become-a-spin',
            target_row(PKO.strip("'")) + f"\nINSERT INTO public.tournaments(id, name, variant, club_id, satellite_target_id) "
                                         f"VALUES ({SAT}, 'S', 'satellite', {CLUB}, {PKO});\n"
                                         f"UPDATE public.tournaments SET is_premium_spin = true WHERE id = {PKO};",
            'is fed by a live satellite and cannot take a Spin entry split')
finally:
    subprocess.run(list(map(str, [pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'immediate', 'stop'])),
                   capture_output=True, env=env)
    shutil.rmtree(cluster, ignore_errors=True)
    (out / 'results.json').write_text(json.dumps(results, indent=2, default=str) + '\n')

print(json.dumps({'passed': all(c['passed'] for c in results['checks']), 'checks': len(results['checks'])}))
