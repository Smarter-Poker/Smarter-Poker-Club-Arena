#!/usr/bin/env python3
"""The daily mission outbox row is locked once.

Migration *_the_daily_mission_outbox_row_is_locked_once.sql drops FOR UPDATE
from the outbox read in public.enqueue_daily_challenge_event(uuid,text,jsonb,
jsonb,jsonb,timestamptz). That read runs in the drain's per-player
subtransaction and the delete of the same row runs in enqueue's own
subtransaction, so on the pre-image every drained row dies with a MultiXact
xmax.

Two disposable PostgreSQL clusters hold the EXACT live definitions of the
drain chain (fixtures/daily-mission-outbox-lock/*.sql, md5-pinned against
production). One stays on the pre-image; the other applies the SHIPPED
migration unchanged. The harness proves:

  PINS       every fixture is the pinned live text, on both clusters;
  APPLY      the shipped migration installs and lands on its post md5;
  SAME       one identical stream (hand events through the hand trigger,
             repeated events, a duplicate event key, a replay of a booked key,
             a held player that takes the skip/backoff path, a 40-day-old
             event that is dead-lettered) drained by the four shard jobs
             leaves identical receipts, user_daily_challenges progress and
             completion, dashboard revisions and outbox residue;
  MULTIXACT  on the pre-image the drained outbox rows carry a MultiXact xmax
             (pageinspect HEAP_XMAX_IS_MULTI) and MultiXacts are created per
             event; after the change neither happens;
  PICKER     after the change a second shard-picker scan no longer re-reads
             the drained rows (their index entries are killed);
  CONCUR     four shard drains looping, hand inserts and direct enqueue calls
             for the same players at once: no deadlock, no error, nothing
             booked twice, nothing lost (inflow = receipts + queued +
             dead-lettered), and the two clusters end identical.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures/daily-mission-outbox-lock'
OUT = (ROOT / 'artifacts/daily-mission-outbox-lock').resolve()
OUT.mkdir(parents=True, exist_ok=True)

PINS = {
    'bump_daily_challenge_dashboard_revision': '367863ecd73d5909ba2ed8701ba8b168',
    'enqueue_daily_challenge_event': '1131a47e5e916b94ab0383ee570d4a60',
    'fn_assign_current_challenge_period': '04c79afcafb140a890cfce6dd4aafeb4',
    'fn_assign_current_challenge_period_serialized_body': 'd4b5951dd657206abed84d0e7c8872fa',
    'fn_drain_daily_challenge_event_outbox_user': '1f9a8c14027257664a61830770854b0b',
    'fn_enqueue_hand_daily_missions': 'a89665914529f8f2b981c26bfd10d6e4',
    'fn_lock_daily_mission_user': '0e9d2905374930bda4529a8febc6eff6',
    'fn_snapshot_daily_challenge_contract': 'e9794768e348367a511b6d1f04669934',
    'record_daily_challenge_event': '1e59c130b38fbe6d9c4728e9bac0a17e',
    'sp_drain_daily_challenge_event_outbox': '8d827eb13fb07f3d212ff3af839819f6',
}
POST_ENQUEUE = 'fb7a950cdbbc657b2b6a4b52b65443bf'
ENQ = "public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)"


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


PG = find_pg_bin()
AS_PG = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV['LC_ALL'] = 'C'

found = sorted((ROOT / 'supabase/migrations').glob('*_the_daily_mission_outbox_row_is_locked_once.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()
DEFS = {name: (FIX / f'{name}.sql').read_text() for name in PINS}

# Active production catalog (2026-10-04): id, tier, type, requirement, diamonds, threshold.
CATALOG = [
    ('bp_1000_1', 'daily', 'big_pots', 1, 20, 1000), ('bp_1000_3', 'daily', 'big_pots', 3, 34, 1000),
    ('bp_2500_1', 'daily', 'big_pots', 1, 30, 2500), ('bp_500_1', 'daily', 'big_pots', 1, 14, 500),
    ('bp_500_3', 'daily', 'big_pots', 3, 26, 500), ('bp_5000_1', 'daily', 'big_pots', 1, 48, 5000),
    ('cw_10000', 'daily', 'chips_won', 10000, 24, None), ('cw_100000', 'daily', 'chips_won', 100000, 70, None),
    ('cw_2500', 'daily', 'chips_won', 2500, 11, None), ('cw_25000', 'daily', 'chips_won', 25000, 40, None),
    ('fa_1', 'daily', 'friends_added', 1, 10, None), ('fa_3', 'daily', 'friends_added', 3, 25, None),
    ('hp_10', 'daily', 'hands_played', 10, 8, None), ('hp_100', 'daily', 'hands_played', 100, 30, None),
    ('hp_200', 'daily', 'hands_played', 200, 50, None), ('hp_25', 'daily', 'hands_played', 25, 12, None),
    ('hp_50', 'daily', 'hands_played', 50, 18, None), ('hw_15', 'daily', 'hands_won', 15, 26, None),
    ('hw_3', 'daily', 'hands_won', 3, 10, None), ('hw_30', 'daily', 'hands_won', 30, 42, None),
    ('hw_8', 'daily', 'hands_won', 8, 16, None), ('nsw_12', 'daily', 'hands_won_no_showdown', 12, 36, None),
    ('nsw_3', 'daily', 'hands_won_no_showdown', 3, 12, None), ('nsw_7', 'daily', 'hands_won_no_showdown', 7, 24, None),
    ('sd_10', 'daily', 'showdowns', 10, 20, None), ('sd_20', 'daily', 'showdowns', 20, 34, None),
    ('sd_3', 'daily', 'showdowns', 3, 9, None), ('sdw_10', 'daily', 'showdowns_won', 10, 38, None),
    ('sdw_2', 'daily', 'showdowns_won', 2, 12, None), ('sdw_5', 'daily', 'showdowns_won', 5, 22, None),
    ('sh_fh_1', 'daily', 'strong_hands', 1, 28, 7), ('sh_fl_1', 'daily', 'strong_hands', 1, 20, 6),
    ('sh_fl_2', 'daily', 'strong_hands', 2, 34, 6), ('sh_quad_1', 'daily', 'strong_hands', 1, 60, 8),
    ('sh_str_1', 'daily', 'strong_hands', 1, 15, 5), ('sh_str_3', 'daily', 'strong_hands', 3, 30, 5),
    ('tp_1', 'daily', 'tournaments_played', 1, 14, None), ('tp_3', 'daily', 'tournaments_played', 3, 30, None),
    ('tp_5', 'daily', 'tournaments_played', 5, 45, None),
    ('mo_bp_2500_25', 'monthly', 'big_pots', 25, 650, 2500), ('mo_chips_1m', 'monthly', 'chips_won', 1000000, 800, None),
    ('mo_hands_2500', 'monthly', 'hands_played', 2500, 500, None), ('mo_wins_500', 'monthly', 'hands_won', 500, 550, None),
    ('mo_sh_fh_25', 'monthly', 'strong_hands', 25, 680, 7), ('mo_tourneys_40', 'monthly', 'tournaments_played', 40, 600, None),
    ('wk_bp_1000_15', 'weekly', 'big_pots', 15, 145, 1000), ('wk_chips_250k', 'weekly', 'chips_won', 250000, 160, None),
    ('wk_hands_500', 'weekly', 'hands_played', 500, 120, None), ('wk_wins_100', 'weekly', 'hands_won', 100, 130, None),
    ('wk_nsw_50', 'weekly', 'hands_won_no_showdown', 50, 115, None), ('wk_sdw_40', 'weekly', 'showdowns_won', 40, 115, None),
    ('wk_sh_fl_10', 'weekly', 'strong_hands', 10, 150, 6), ('wk_tourneys_10', 'weekly', 'tournaments_played', 10, 140, None),
]

# Live table shapes (information_schema / pg_constraint / pg_index, 2026-10-04).
SCHEMA = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA realtime;
CREATE EXTENSION pageinspect;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) RETURNS void
  LANGUAGE sql AS $$ SELECT $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE TABLE public.daily_challenge_catalog (
  id text NOT NULL PRIMARY KEY,
  tier text NOT NULL CHECK (tier = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text])),
  challenge_type text NOT NULL,
  requirement integer NOT NULL CHECK (requirement > 0),
  chip_reward numeric NOT NULL CHECK (chip_reward >= 0),
  diamond_reward integer NOT NULL DEFAULT 0 CHECK (diamond_reward >= 0),
  name text NOT NULL,
  description text NOT NULL,
  threshold integer,
  is_active boolean NOT NULL DEFAULT false);
CREATE TABLE public.user_daily_challenges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  challenge_id text NOT NULL,
  assigned_date text NOT NULL DEFAULT CURRENT_DATE,
  progress integer NOT NULL DEFAULT 0,
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  claimed boolean NOT NULL DEFAULT false,
  claimed_at timestamp with time zone,
  challenge_name_snapshot text NOT NULL,
  challenge_description_snapshot text NOT NULL,
  challenge_type_snapshot text NOT NULL,
  tier_snapshot text NOT NULL,
  requirement_snapshot integer NOT NULL CONSTRAINT user_daily_challenges_requirement_snapshot_positive CHECK (requirement_snapshot > 0),
  chip_reward_snapshot numeric NOT NULL CONSTRAINT user_daily_challenges_chip_reward_snapshot_nonnegative CHECK (chip_reward_snapshot >= 0),
  diamond_reward_snapshot integer NOT NULL CONSTRAINT user_daily_challenges_diamond_reward_snapshot_nonnegative CHECK (diamond_reward_snapshot >= 0),
  threshold_snapshot integer,
  expired_at timestamp with time zone,
  CONSTRAINT user_daily_challenges_user_id_challenge_id_assigned_date_key UNIQUE (user_id, challenge_id, assigned_date),
  CONSTRAINT fk_user_daily_challenges_user_id_profiles FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT user_daily_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE INDEX idx_user_daily_challenges_user_date ON public.user_daily_challenges (user_id, assigned_date);
CREATE TABLE public.daily_challenge_dashboard_revisions (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.daily_challenge_event_outbox (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  amounts jsonb NOT NULL,
  magnitudes jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamp with time zone NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  dead_lettered_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  threshold_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(threshold_values) = 'object'::text),
  PRIMARY KEY (user_id, event_key));
CREATE INDEX idx_daily_challenge_event_outbox_shard_due ON public.daily_challenge_event_outbox
  USING btree ((((hashtext((user_id)::text) & 2147483647) % 4)), user_id, created_at) WHERE (dead_lettered_at IS NULL);
CREATE INDEX idx_daily_challenge_event_outbox_due ON public.daily_challenge_event_outbox (next_attempt_at, created_at);
CREATE TABLE public.daily_challenge_progress_events (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_key text NOT NULL CHECK ((length(event_key) >= 1) AND (length(event_key) <= 200)),
  amounts jsonb NOT NULL CHECK (jsonb_typeof(amounts) = 'object'::text),
  magnitudes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(magnitudes) = 'object'::text),
  occurred_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  threshold_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(threshold_values) = 'object'::text),
  PRIMARY KEY (user_id, event_key));
CREATE INDEX idx_daily_challenge_progress_events_created_at ON public.daily_challenge_progress_events (created_at);
CREATE TABLE public.hand_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_mission_events jsonb,
  ended_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now());
"""

TRIGGERS = r"""
CREATE TRIGGER trg_snapshot_daily_challenge_contract_insert BEFORE INSERT ON public.user_daily_challenges
  FOR EACH ROW EXECUTE FUNCTION fn_snapshot_daily_challenge_contract();
CREATE TRIGGER trg_snapshot_daily_challenge_contract_update BEFORE UPDATE OF challenge_id, challenge_name_snapshot,
  challenge_description_snapshot, challenge_type_snapshot, tier_snapshot, requirement_snapshot, threshold_snapshot,
  chip_reward_snapshot, diamond_reward_snapshot ON public.user_daily_challenges
  FOR EACH ROW EXECUTE FUNCTION fn_snapshot_daily_challenge_contract();
CREATE TRIGGER trg_daily_challenge_revision_from_contract AFTER INSERT OR DELETE OR UPDATE ON public.user_daily_challenges
  FOR EACH ROW EXECUTE FUNCTION bump_daily_challenge_dashboard_revision();
CREATE TRIGGER trg_enqueue_hand_daily_missions AFTER INSERT ON public.hand_history
  FOR EACH ROW EXECUTE FUNCTION fn_enqueue_hand_daily_missions();
DO $g$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f','p') LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM PUBLIC',
      CASE WHEN (SELECT prokind FROM pg_proc WHERE oid = f) = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, f);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz) TO service_role';
END $g$;
"""

# Eight players spread over the four shards.
USERS = [str(uuid.UUID(int=0x5000 + i)) for i in range(8)]
NOW = datetime.now(timezone.utc).replace(microsecond=0)
T0 = NOW - timedelta(minutes=20)


def ts(dt):
    return dt.strftime('%Y-%m-%d %H:%M:%S+00')


def seed():
    users = ',\n'.join(f"('{u}')" for u in USERS)
    cat = ',\n'.join(
        f"('{i}', '{t}', '{ty}', {r}, 0, {d}, '{i}', '{i}', {'NULL' if th is None else th}, true)"
        for i, t, ty, r, d, th in CATALOG)
    return f"""
INSERT INTO auth.users (id) VALUES {users};
INSERT INTO public.profiles (id) VALUES {users};
INSERT INTO public.daily_challenge_catalog (id, tier, challenge_type, requirement, chip_reward, diamond_reward,
  name, description, threshold, is_active) VALUES {cat};
"""


class Cluster:
    def __init__(self, name, port):
        self.dir = Path(tempfile.mkdtemp(prefix=f'dm-outbox-{name}-', dir='/tmp'))
        self.sock = self.dir / 'socket'
        self.sock.mkdir(mode=0o700)
        if AS_PG:
            shutil.chown(self.dir, 'postgres')
            shutil.chown(self.sock, 'postgres')
        self.port = str(port)
        subprocess.run(AS_PG + [str(PG / 'initdb'), '-D', str(self.dir / 'data'), '-U', 'postgres', '-A', 'trust'],
                       env=ENV, check=True, capture_output=True)
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-l', str(self.dir / 'log'), '-w',
                        '-o', f"-k {self.sock} -p {self.port} -c listen_addresses='' -c fsync=off "
                              f"-c autovacuum=off -c deadlock_timeout=200ms -c max_connections=60 -c timezone=UTC",
                        'start'], env=ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def psql(self, sql, check=True, timeout=180):
        r = subprocess.run([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(self.sock),
                            '-p', self.port, '-U', 'postgres', '-d', 'postgres'],
                           input=sql, text=True, capture_output=True, env=ENV, timeout=timeout)
        if check and r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r

    def val(self, sql):
        return self.psql(sql).stdout.strip()

    def stop(self):
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-m', 'immediate', 'stop'],
                       env=ENV, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def install(c):
    c.psql(SCHEMA + seed())
    for name, d in DEFS.items():
        c.psql(d.rstrip('\n') + ';\n')
    c.psql(TRIGGERS)
    got = {}
    for name in PINS:
        got[name] = c.val(f"SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p "
                          f"WHERE p.proname = '{name}' AND p.pronamespace = 'public'::regnamespace;")
    return got == PINS, got


def hand_events(seq, users, at):
    """One hand's daily_mission_events array, deterministic in seq."""
    evs = []
    for k, u in enumerate(users):
        won = (seq + k) % 3 == 0
        pot = 400 + ((seq * 37 + k * 211) % 6000)
        strong = (seq + k) % 9
        amounts = {'hands_played': 1}
        mags = {}
        vals = {}
        if won:
            amounts.update({'hands_won': 1, 'chips_won': pot})
            if (seq + k) % 2:
                amounts['showdowns_won'] = 1
            else:
                amounts['hands_won_no_showdown'] = 1
        if (seq + k) % 2:
            amounts['showdowns'] = 1
        if pot >= 500:
            amounts['big_pots'] = 1
            vals['big_pots'] = [pot]
        if strong >= 5:
            amounts['strong_hands'] = 1
            vals['strong_hands'] = [strong]
        evs.append({'user_id': u, 'amounts': amounts, 'magnitudes': mags, 'values': vals})
    return evs


def hand_sql(hand_id, seq, users, at):
    ev = json.dumps(hand_events(seq, users, at)).replace("'", "''")
    return (f"INSERT INTO public.hand_history (id, daily_mission_events, ended_at) "
            f"VALUES ('{hand_id}', '{ev}'::jsonb, '{ts(at)}');\n")


def drain_all(c):
    for s in range(4):
        c.psql(f"CALL public.sp_drain_daily_challenge_event_outbox(5000, {s}, 4);")


RECEIPTS = ("SELECT coalesce(json_agg(json_build_object('u', user_id, 'k', event_key, 'a', amounts, 'm', magnitudes, "
            "'v', threshold_values, 'o', occurred_at) ORDER BY user_id, event_key), '[]') "
            "FROM public.daily_challenge_progress_events;")
UDC = ("SELECT coalesce(json_agg(json_build_object('u', user_id, 'c', challenge_id, 'd', assigned_date, 'p', progress, "
       "'done', completed, 'at', completed_at IS NOT NULL, 'cl', claimed, 'tier', tier_snapshot, 'req', requirement_snapshot) "
       "ORDER BY user_id, assigned_date, challenge_id), '[]') FROM public.user_daily_challenges;")
REV = ("SELECT coalesce(json_agg(json_build_object('u', user_id, 'r', revision) ORDER BY user_id), '[]') "
       "FROM public.daily_challenge_dashboard_revisions;")
OUTBOX = ("SELECT coalesce(json_agg(json_build_object('u', user_id, 'k', event_key, 'att', attempts, "
          "'dl', dead_lettered_at IS NOT NULL, 'err', split_part(coalesce(last_error, ''), ' at ', 1)) "
          "ORDER BY user_id, event_key), '[]') FROM public.daily_challenge_event_outbox;")


def snapshot(c):
    return {k: json.loads(c.val(q)) for k, q in (('receipts', RECEIPTS), ('udc', UDC), ('revisions', REV),
                                                ('outbox', OUTBOX))}


def outbox_multixact(c):
    """Deleted outbox tuples on disk, and how many carry a MultiXact xmax."""
    return json.loads(c.val("""
      SELECT json_build_object('deleted', count(*),
                               'multi', count(*) FILTER (WHERE (t_infomask & 4096) <> 0))
        FROM generate_series(0, pg_relation_size('public.daily_challenge_event_outbox') / 8192 - 1) b,
             LATERAL heap_page_items(get_raw_page('public.daily_challenge_event_outbox', b::int)) h
       WHERE h.t_xmax <> '0' AND (h.t_infomask & 2048) = 0 AND (h.t_infomask & 128) = 0;"""))


def multi_by_table(c):
    """Tuples carrying a MultiXact xmax, per drain table (lock-only or not)."""
    return json.loads(c.val("""
      SELECT json_object_agg(t, n) FROM (
        SELECT t, (SELECT count(*) FROM generate_series(0, pg_relation_size(t) / 8192 - 1) b,
                   LATERAL heap_page_items(get_raw_page(t, b::int)) h
                   WHERE (h.t_infomask & 4096) <> 0 AND (h.t_infomask & 2048) = 0) n
          FROM unnest(ARRAY['public.daily_challenge_event_outbox', 'public.profiles', 'auth.users',
                            'public.user_daily_challenges', 'public.daily_challenge_dashboard_revisions',
                            'public.daily_challenge_progress_events']) t) x;"""))


def member_lookups(c):
    """multixact_member SLRU lookups so far (backends flush on exit)."""
    time.sleep(0.3)
    return int(c.val("SELECT blks_hit + blks_read FROM pg_stat_slru WHERE name = 'multixact_member';"))


def next_mxid(c):
    return int(c.val("CHECKPOINT; SELECT next_multixact_id::text::bigint FROM pg_control_checkpoint();"))


def picker_reads(c):
    """Index entries the shard-0 picker reads, called twice in one session."""
    return json.loads(c.val("""
      CREATE TEMP TABLE r (n int, v bigint);
      DO $p$
      DECLARE i int; r0 bigint; u uuid;
        idx oid := 'public.idx_daily_challenge_event_outbox_shard_due'::regclass;
      BEGIN
        FOR i IN 1..2 LOOP
          r0 := pg_stat_get_xact_tuples_returned(idx);
          FOR s IN 0..3 LOOP
            EXECUTE format($q$SELECT o.user_id FROM public.daily_challenge_event_outbox o
              WHERE o.dead_lettered_at IS NULL AND (o.occurred_at < now() - interval '35 days' OR o.next_attempt_at <= now())
                AND (hashtext(o.user_id::text) & 2147483647) %% 4 = %s AND o.created_at <= now()
              ORDER BY o.user_id, o.created_at, o.event_key LIMIT 1$q$, s) INTO u;
          END LOOP;
          INSERT INTO r VALUES (i, pg_stat_get_xact_tuples_returned(idx) - r0);
        END LOOP;
      END $p$;
      SELECT json_agg(v ORDER BY n) FROM r;""").splitlines()[-1])


results = {'scope': 'the daily mission outbox row is locked once', 'cases': [], 'passed': False}


def case(name, ok, **kw):
    results['cases'].append({'case': name, **kw, 'ok': bool(ok)})
    print(('PASS ' if ok else 'FAIL ') + name, {k: v for k, v in kw.items() if k not in ('diff',)})


def diff(a, b):
    out = {}
    for k in a:
        if a[k] != b[k]:
            out[k] = {'old_only': [x for x in a[k] if x not in b[k]][:3], 'new_only': [x for x in b[k] if x not in a[k]][:3]}
    return out


def set_planner_to_index(c):
    # Production has thousands of outbox rows and plans these with the indexes;
    # a nearly empty local table would otherwise be sequentially scanned.
    c.psql("ALTER DATABASE postgres SET enable_seqscan = off;")


old = new = None
try:
    old = Cluster('old', 55861)
    new = Cluster('new', 55862)
    for c in (old, new):
        ok, got = install(c)
        case(f'PINS fixture definitions are the pinned live text ({c.port})', ok,
             mismatched={k: v for k, v in got.items() if PINS.get(k) != v})
        set_planner_to_index(c)

    r = new.psql(SHIPPED, check=False)
    post = new.val(f"SELECT md5(pg_get_functiondef('{ENQ}'::regprocedure));")
    acl_new = new.val(f"SELECT proacl::text FROM pg_proc WHERE oid = '{ENQ}'::regprocedure;")
    acl_old = old.val(f"SELECT proacl::text FROM pg_proc WHERE oid = '{ENQ}'::regprocedure;")
    case('APPLY the shipped migration lands on its post md5 with grants unchanged',
         r.returncode == 0 and post == POST_ENQUEUE and acl_new == acl_old,
         post=post, acl=acl_new, stderr=r.stderr.strip()[-400:])
    rerun = new.psql(SHIPPED, check=False)
    case('APPLY a second run refuses (pins the pre-image)', rerun.returncode != 0 and 'not the pinned text' in rerun.stderr,
         stderr=rerun.stderr.strip()[-200:])
    pre_sql = DEFS['enqueue_daily_challenge_event']
    case('APPLY the fixture pre-image takes the player lock before the row read',
         pre_sql.index('fn_lock_daily_mission_user') < pre_sql.index('FROM public.daily_challenge_event_outbox\n  WHERE'))

    # ---------------------------------------------------------------- SAME
    stream = []
    for seq in range(40):
        players = [USERS[(seq + j) % 8] for j in range(2 + seq % 4)]
        stream.append(hand_sql(str(uuid.UUID(int=0x9000 + seq)), seq, players, T0 + timedelta(seconds=seq * 7)))
    dup_hand = str(uuid.UUID(int=0x9000 + 3))
    extras = (
        # A duplicate event key queued while the first is still pending.
        f"INSERT INTO public.daily_challenge_event_outbox (user_id, event_key, amounts, occurred_at) "
        f"SELECT user_id, event_key, amounts, occurred_at FROM public.daily_challenge_event_outbox "
        f"WHERE event_key = 'hand:{dup_hand}' ON CONFLICT (user_id, event_key) DO NOTHING;\n"
        # A 40-day-old event: dead-lettered, never credited.
        f"INSERT INTO public.daily_challenge_event_outbox (user_id, event_key, amounts, occurred_at) "
        f"VALUES ('{USERS[1]}', 'hand:ancient', '{{\"hands_played\":1}}', '{ts(NOW - timedelta(days=40))}');\n")
    held = USERS[2]
    hold_sql = (f"BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('daily-missions-user:' || '{held}', 0)); "
                f"SELECT pg_sleep(8); COMMIT;")
    phases = {}
    for c in (old, new):
        c.psql(''.join(stream[:25]) + extras)
        mx0 = next_mxid(c)
        n0 = int(c.val("SELECT count(*) FROM public.daily_challenge_event_outbox WHERE dead_lettered_at IS NULL "
                       "AND occurred_at >= now() - interval '35 days';"))
        t = threading.Thread(target=c.psql, args=(hold_sql,), kwargs={'check': False})
        t.start()
        for _ in range(100):
            if c.val("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid();") != '0':
                break
            time.sleep(0.05)
        lk0 = member_lookups(c)
        drain_all(c)
        t.join()
        lk1 = member_lookups(c)
        booked = int(c.val("SELECT count(*) FROM public.daily_challenge_progress_events;"))
        mx1 = next_mxid(c)
        on_disk = outbox_multixact(c)
        by_table = multi_by_table(c)
        picks = picker_reads(c)
        lk2 = member_lookups(c)
        skipped = int(c.val(f"SELECT count(*) FROM public.daily_challenge_event_outbox WHERE user_id = '{held}' AND attempts > 0;"))
        phases[c.port] = {'queued': n0, 'booked': booked, 'mxids': mx1 - mx0, 'deleted_on_disk': on_disk,
                          'picker_reads_first_second': picks, 'held_player_skipped_rows': skipped,
                          'multixact_tuples_by_table': by_table,
                          'member_lookups_drain': lk1 - lk0, 'member_lookups_picker_scans': lk2 - lk1}
        # Replay of a booked key with the same payload, the rest of the stream, then the backoff.
        c.psql(''.join(stream[25:]) +
               f"INSERT INTO public.daily_challenge_event_outbox (user_id, event_key, amounts, magnitudes, threshold_values, occurred_at) "
               f"SELECT user_id, event_key, amounts, magnitudes, threshold_values, occurred_at "
               f"FROM public.daily_challenge_progress_events WHERE event_key = 'hand:{str(uuid.UUID(int=0x9000 + 5))}' "
               f"ON CONFLICT DO NOTHING;\n")
        drain_all(c)
    time.sleep(11)
    for c in (old, new):
        drain_all(c)
    a, b = snapshot(old), snapshot(new)
    po, pn = phases[old.port], phases[new.port]
    case('SAME receipts, progress, completion, revisions and outbox residue are identical', a == b,
         receipts=len(a['receipts']), udc_rows=len(a['udc']), completed=sum(1 for x in a['udc'] if x['done']),
         progressed=sum(1 for x in a['udc'] if x['p'] > 0), outbox_left=a['outbox'], diff=diff(a, b))
    case('SAME the stream reached the skip/backoff path and the dead-letter path on both',
         po['held_player_skipped_rows'] > 0 and pn['held_player_skipped_rows'] > 0
         and any(x['dl'] for x in a['outbox']), old=po['held_player_skipped_rows'], new=pn['held_player_skipped_rows'])
    case('SAME the replayed and duplicate keys were booked once',
         len({(x['u'], x['k']) for x in a['receipts']}) == len(a['receipts']))

    # ------------------------------------------------------------ MULTIXACT
    case('MULTIXACT on the pre-image every drained outbox row dies with a MultiXact xmax',
         po['deleted_on_disk']['deleted'] >= po['booked'] > 0 and po['deleted_on_disk']['multi'] >= po['booked']
         and po['member_lookups_picker_scans'] > 0, **po)
    case('MULTIXACT after the change no drained outbox row carries one',
         pn['deleted_on_disk']['deleted'] >= pn['booked'] > 0 and pn['deleted_on_disk']['multi'] == 0
         and pn['multixact_tuples_by_table']['public.daily_challenge_event_outbox'] == 0, **pn)
    case('MULTIXACT the change creates exactly one MultiXact fewer per booked event',
         po['booked'] == pn['booked'] and po['mxids'] - pn['mxids'] == pn['booked'],
         old=po['mxids'], new=pn['mxids'], booked=pn['booked'])
    case('PICKER after the change scanning the drained outbox needs no MultiXact lookup',
         po['member_lookups_picker_scans'] > 0 and pn['member_lookups_picker_scans'] == 0,
         old=po['member_lookups_picker_scans'], new=pn['member_lookups_picker_scans'],
         old_drain=po['member_lookups_drain'], new_drain=pn['member_lookups_drain'])

    # --------------------------------------------------------------- CONCUR
    for c in (old, new):
        c.psql("TRUNCATE public.daily_challenge_event_outbox, public.daily_challenge_progress_events, "
               "public.user_daily_challenges, public.daily_challenge_dashboard_revisions, public.hand_history;")
    conc = {}
    for c in (old, new):
        errors = []
        stop = threading.Event()
        lock = threading.Lock()

        def run(sql):
            r = c.psql(sql, check=False)
            if r.returncode != 0 or 'deadlock' in r.stderr.lower():
                with lock:
                    errors.append(r.stderr.strip()[-300:])

        def drainer(s):
            while not stop.is_set():
                run(f"CALL public.sp_drain_daily_challenge_event_outbox(5000, {s}, 4);")
                time.sleep(0.05)

        def hands(worker):
            for seq in range(60):
                players = [USERS[(seq + worker + j) % 8] for j in range(3)]
                run(hand_sql(str(uuid.UUID(int=0xA0000 + worker * 1000 + seq)), seq + worker, players,
                             NOW - timedelta(minutes=5) + timedelta(seconds=seq)))

        def direct(worker):
            for seq in range(40):
                u = USERS[(seq * 3 + worker) % 8]
                run(f"SET ROLE service_role; SELECT {ENQ.split('(')[0]}('{u}', 'tournament:{worker}-{seq}', "
                    f"'{{\"tournaments_played\":1}}'::jsonb, '{{}}'::jsonb, '{{}}'::jsonb, "
                    f"'{ts(NOW - timedelta(minutes=4) + timedelta(seconds=seq))}');")

        threads = [threading.Thread(target=drainer, args=(s,)) for s in range(4)]
        threads += [threading.Thread(target=hands, args=(w,)) for w in range(3)]
        threads += [threading.Thread(target=direct, args=(w,)) for w in range(2)]
        for t in threads:
            t.start()
        for t in threads[4:]:
            t.join()
        stop.set()
        for t in threads[:4]:
            t.join()
        deadline = time.time() + 80
        while time.time() < deadline:
            drain_all(c)
            due = int(c.val("SELECT count(*) FROM public.daily_challenge_event_outbox WHERE dead_lettered_at IS NULL;"))
            if due == 0:
                break
            time.sleep(2)
        inflow = 3 * 60 * 3 + 2 * 40
        receipts = int(c.val("SELECT count(*) FROM public.daily_challenge_progress_events;"))
        queued = int(c.val("SELECT count(*) FROM public.daily_challenge_event_outbox WHERE dead_lettered_at IS NULL;"))
        dead = int(c.val("SELECT count(*) FROM public.daily_challenge_event_outbox WHERE dead_lettered_at IS NOT NULL;"))
        retried = int(c.val("SELECT count(*) FROM public.daily_challenge_event_outbox WHERE attempts > 0;"))
        conc[c.port] = {'inflow': inflow, 'receipts': receipts, 'queued': queued, 'dead_lettered': dead,
                        'errors': errors[:5], 'error_count': len(errors), 'state': snapshot(c)}
    co, cn = conc[old.port], conc[new.port]
    for label, cc in (('pre-image', co), ('after', cn)):
        case(f'CONCUR {label}: no deadlock, no error, inflow = receipts + queued + dead-lettered, nothing twice',
             cc['error_count'] == 0 and cc['inflow'] == cc['receipts'] + cc['queued'] + cc['dead_lettered']
             and cc['queued'] == 0 and len({(x['u'], x['k']) for x in cc['state']['receipts']}) == cc['receipts'],
             **{k: v for k, v in cc.items() if k != 'state'})
    case('CONCUR both clusters end with identical receipts and progress',
         co['state']['receipts'] == cn['state']['receipts'] and co['state']['udc'] == cn['state']['udc'],
         receipts=len(cn['state']['receipts']), udc_rows=len(cn['state']['udc']),
         diff=diff({k: co['state'][k] for k in ('receipts', 'udc')}, {k: cn['state'][k] for k in ('receipts', 'udc')}))

    results['passed'] = all(x['ok'] for x in results['cases'])
except Exception as e:  # noqa: BLE001
    results['error'] = str(e)[-2000:]
    print('ERROR', results['error'])
finally:
    for c in (old, new):
        if c:
            c.stop()
    (OUT / 'result.json').write_text(json.dumps(results, indent=1, default=str) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': [(x['case'], x['ok']) for x in results['cases']]}, indent=1))

raise SystemExit(0 if results['passed'] else 1)
