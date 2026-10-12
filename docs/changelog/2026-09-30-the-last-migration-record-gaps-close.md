# The last migration-record gaps close (2026-09-30)

Two workflows were correctly red on migration records. Both are made honest
here by fixing the records; neither check was touched.

- `Applied Migrations Are Recorded`: production had applied three migrations
  that had no file anywhere, on `main` or on any of the 784 remote branches.
- `Production Integrity Audit`, `migrations_are_live`:
  `20260927160709_a_page_recompute_reads_only_the_evidence_that_changed.sql`
  merged in PR #5475 and could never be applied as written.

Follows `2026-09-30-the-red-workflows-get-their-verdicts.md`, sections 5b and 6.

---

## 1. Three applied migrations get their files, byte for byte

Each file was written by decoding production's own base64 of
`array_to_string(statements, chr(10))` in the shell. Nothing was pasted through
a JSON tool boundary and nothing was appended: no header and no trailing newline
the database does not already have. Each was compared against
`public.fn_ca_migration_text(version)` before commit.

| version          | production bytes | file bytes | md5 (both)                         |
| ---------------- | ---------------- | ---------- | ---------------------------------- |
| `20260928000425` | 6539             | 6539       | `de66975f200e5626484923840d0ad9d8` |
| `20260928000527` | 2505             | 2505       | `34e0c338493c5f009d0a7264c45e6db7` |
| `20260930032343` | 3330             | 3330       | `3262220dc4ad4a730439aef5476dd8c8` |

**The trap the byte check caught.** The first write of `20260930032343` came out
at 3327 bytes. Its header rules are U+2550 (three bytes each), and two of the
three rule lines had changed length in transcription. Per-line md5s against
production named lines 1 and 3; both were rebuilt from line 22, which is
byte-identical in production, and the whole file then matched.

Each has a row in `scripts/ci/recorded-migrations.manifest.json` with the live
evidence read on 2026-09-30:

- `20260928000425` is refused on its text by `check-definer-authorization`
  (anon rule) and `migration-version-collisions` (69-character name). The anon
  finding WAS true when it ran: `fn_horse_tag_ev_significance(date)` was
  created SECURITY DEFINER with PUBLIC execute. It was closed by
  `20260930181809 close_the_horse_tag_ev_console_to_the_browser`; its live ACL
  is `{postgres=X/postgres,service_role=X/postgres}` and no RLS policy
  references it. Production stored the 69-character name uncut.
- `20260928000527` created `fn_horse_daily_audit_fallback()` and cron job 373
  `horse-daily-audit-fallback`. Recorded as history only; the recording adds no
  schedule. Whether that fallback should outlive its cause is a CLAUDE.md 10.12
  question for its owner.
- `20260930032343` is data-only (the fleet engine switch). Its own pre-flight
  asserts the switch is off, so it can never be replayed.

**None of the three was re-applied or run.**

### What is still unrecorded, and why it stays that way

Recomputed from production and both repositories' migration listings, indexed
exactly as `check-applied-migrations-are-recorded.mjs` indexes them: **16**
applied migrations since `20260923000000` still have no file on `main` in
either repo, and every one of the 16 has its file on a remote branch now:

| versions                                             | branch                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `20260927154806`                                     | `agent/codex-billing-f83d-0927/fix/open-week-request-lock-order`             |
| `20260927170836`                                     | `agent/codex-profile-account-0927/fix/original-elimination-before-movement`  |
| `20260927170842` (file stamped `20260927165228`)     | `agent/codex-union-0927/fix/scoped-visible-operations`                       |
| `20260927220437`, `20260927220532`, `20260927221228` | `agent/cowork-claude-league-0927/fix/league-says-when-it-refuses-to-measure` |
| `20260927220533`                                     | `agent/cowork-claude-solver-0927/fix/uncommissioned-solver-is-not-an-outage` |
| `20260927220637`, `20260927221321`                   | `agent/cowork-claude-stackoff-0927/feat/deep-stack-one-pair-commitment`      |
| `20260927220647`, `20260927221452`                   | `agent/cowork-claude-leakreads-0927/fix/journaled-model-capacity`            |
| `20260928141826`, `20260928141849`                   | `fix/union-settlement-scale`                                                 |
| `20260928153000`                                     | `fix/seat-reopened-after-capture-is-original-population`                     |
| `20260929110440`, `20260929124252`                   | `fix/jackpot-share-on-the-felt-is-a-cash-result`                             |

Backfilling any of them would create a second file for a version another agent
is about to merge, and of two files sharing a version the second is silently
never applied (CLAUDE.md 4.5). No remaining gap is outside that set.

---

## 2. `20260927160709` is re-derived, not applied as written and not dropped

### What changed underneath it

Its STEP 2.1 refuses unless the calculator's `md5(prosrc)` is
`80f40737e9015888f2b5c4215c383bc5`. Production runs
`adea66332439cb1c0071f37ce12165b9`. The difference is exactly one expression,
proved byte for byte:

- `20260926042810`'s calculator body hashes to `80f40737...`.
- `20260927155651` step 3c rewrote the certificate loop's agreement instant for
  a tournament fee from `fee.charged_at` to
  `public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract)`.
- `042810`'s body with that one replacement hashes to `adea6633...`, the live
  prosrc. Nothing else differs.

That line sits in the certificate loop, which `160709` deliberately left alone,
and nowhere near the three evidence counts it rewrites for page calls. The live
body still reads the whole club-week on every page call, so the intent applies.

### What was done

`20260930232349_a_page_recompute_reads_only_changed_evidence_rederived.sql` is
`160709` with: the preimage set to `adea6633...`; `155651`'s agreement-instant
expression carried into the installed calculator, so applying it cannot revert
that fix; the page-path and table comments naming the new version; and the
postimage `cb7f9eabbe3849ec05df23f9f2a361df`, the md5 of the body in the file.
Every object name is the same.

`160709` is deleted in the same pull request, which is the remediation
`check-migrations-are-live.mjs` prescribes for a superseded file. It was never
in `schema_migrations`, and its precondition would also have broken a rebuild
from files.

The two insert guards were re-checked against today's writer:
`fn_accrue_cash_hand_commissions(uuid)` is still the only function that inserts
into either table; both batch inserts write `earned_at = source.created_at` and
leave `recorded_at` to its default `clock_timestamp()`; the source insert runs
after the batch and writes the same `earned_at`. 0 of the 237,214 batches of the
last three days break either fact.

Moved with it:

- `tests/a-page-reads-only-the-evidence-that-changed.law.test.ts`: the
  predecessor is `042810`'s body with `155651` step 3c replayed, refused unless
  `155651` still carries that exact old and new text; the pinned preimage is
  `adea6633...`.
- `scripts/dev/test-union-weekly-basis.py`: after `042810` the cluster takes
  `155651` step 3c (its two terms-at functions verbatim, then its
  replacement) and applies `20260930232349`. On postgresql@17: exit 0, 86 PASS
  steps; `page-evidence-regression` 955 PASS notices, 0 failures.
- `tests/fixtures/union-weekly-basis/source-binding.json` and
  `tests/fixtures/full-weekly-accounting/source-binding.json`: restamped, with
  the audit block `page_evidence_checkpoint_rederived_20260930`.
- `scripts/ci/schema-manifest.d/page-evidence-checkpoint.json`: owner text names
  the new migration.

Locks: the three indexes are built `CONCURRENTLY` outside any transaction
(SHARE UPDATE EXCLUSIVE; per-hand inserts continue). The transaction takes SHARE
ROW EXCLUSIVE on the two accrual tables for the two `CREATE TRIGGER`s, bounded by
`lock_timeout 5s`. The new table carries no foreign key.

No guard was weakened and no cron, sweep, backfill or watchdog was added.
