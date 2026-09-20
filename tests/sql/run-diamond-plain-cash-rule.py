#!/usr/bin/env python3
"""Certify the one plain-cash rule in the isolated Phase 6 fixture.

Never connects to production. The migration loaded here is the same file that
was applied to kuklfnapbkmacvwxktbh, and the four functions it restates carry
byte-identical definitions in both places (md5 of pg_get_functiondef compared
after the apply), so what passes here is what the estate runs.

The two doors the migration edits IN PLACE rather than restating are
`fn_poker_diamond_buyin` and `fn_poker_diamond_top_up`. The fixture holds only
the first; the second was dry-run against production read-only before the apply
(clause found once, ends in THEN, replacement length as predicted) and verified
after it by definition length and by the absence of its own copy of the rule.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260912061500_one_rule_says_what_a_plain_diamond_cash_table_is.sql'
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
CMD = [PG_BIN + '/psql', '-X', '-q', '-At',
       '-h', '/tmp/codex-diamond-phase2-pg', '-p', '55472',
       '-d', 'poker_diamond_phase6_test', '-v', 'ON_ERROR_STOP=1']


def run(sql):
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.sql', dir=ROOT / 'tests/sql') as script:
        script.write(sql)
        script.flush()
        r = subprocess.run(CMD + ['-P', 'pager=off', '-f', script.name],
                           text=True, capture_output=True, cwd=ROOT / 'tests/sql', timeout=180)
    if r.returncode:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise RuntimeError('Isolated Diamond plain-cash-rule SQL failed')
    for line in r.stderr.splitlines():
        if 'NOTICE:' in line:
            print(line.split('NOTICE:', 1)[1].strip())
    return r.stdout.strip()


# The fixture's `fn_poker_diamond_top_up` does not exist, so the loop that
# edits the two money doors is narrowed to the one that does. Nothing else in
# the migration changes: the rule, the three staff doors and the final proof
# are loaded exactly as applied.
migration = MIGRATION.read_text()
narrowed = migration.replace(
    "ARRAY['fn_poker_diamond_buyin','fn_poker_diamond_top_up']",
    "ARRAY['fn_poker_diamond_buyin']").replace(
    "'fn_poker_diamond_buyin','fn_poker_diamond_top_up',",
    "'fn_poker_diamond_buyin',")
if narrowed == migration:
    raise RuntimeError('the migration no longer names the two money doors this runner narrows')

run(narrowed)
# The variant migration builds on the rule migration and is certified by the
# same acceptance file, because "which games" and "what shape" are one question
# about one table and splitting them would let the two answers drift.
VARIANTS = ROOT / 'supabase/migrations/20260912070000_the_diamond_arena_deals_the_games_the_estate_deals.sql'
run(VARIANTS.read_text())
print(run('\\ir poker-diamond-plain-cash-rule-acceptance.sql'))
print('One plain-cash rule certified in the isolated fixture; this is not public release.')
