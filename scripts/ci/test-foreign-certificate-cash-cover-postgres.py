#!/usr/bin/env python3
"""Exact unchanged foreign helper/views and original monetary family plus cash cover."""
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[2]
base=ROOT/'scripts/ci/test-zero-standalone-foreign-postgres.py'
hook=ROOT/'scripts/ci/fixtures/foreign-certificate-cash-cover/native-hook.py'
SOURCE_CASH_COVER_MIGRATION=ROOT/'supabase/migrations/20261027194250_foreign_certificates_read_their_original_cash_cover.sql'
s=base.read_text()
# The exact supported concurrent migration is installed before every original
# foreign/zero R2/R3, replay, refusal and concurrency case. No financial stub.
assert s.count('    load(zero_migration)')==1
s=s.replace('    load(zero_migration)','    load(zero_migration)\n    q(SOURCE_CASH_COVER_MIGRATION.read_text())')
marker='    metadata=json.loads(q('
assert s.count(marker)==1
s=s.replace(marker,"    exec(compile(hook.read_text(),str(hook),'exec'),globals())\n"+marker)
exec(compile(s,str(base),'exec'),globals())
