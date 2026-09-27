# Cashier totals read the receipt range without wide heap visits

The production default-week receipt aggregate took 3,237 ms for 11,714 rows,
including 2,087 physical read blocks. The existing club/time index cannot
supply the amount and directional user IDs needed by totals. Recent receipt
pages also had not been vacuumed since September 18. This contributes to the
existing statement timeout; it does not establish every cause of the full RPC's
latency or promise a specific production speedup.

The online companion adds a club/time covering index. Its short migration
verifies the exact valid, ready, live index and unchanged cashier function
definitions before setting four table-local autovacuum/analyze options. The
measured insert/change rate supports roughly four maintenance opportunities per
day. PostgreSQL's existing maintenance mechanism remains responsible; no new
scheduler, RPC, money write, permission or accounting predicate is introduced.

Native PostgreSQL 17 qualification uses 910,000 synthetic interleaved receipts
and the existing complete cashier accounting/authentication oracle. A covering
index alone still visits recent heap pages. After native visibility maintenance,
the identical aggregate uses an index-only scan, zero heap fetches and under one
quarter of the original buffers. This is a mechanism test, not a production
benchmark. Tests also cover absent/wrong/invalid/not-ready/dead indexes, ownership
and function drift including missing functions, rollback, concurrent write
progress, interrupted build cleanup, and the captured production freeze guards
under a non-superuser PostgreSQL-member login. All financial RPC definitions,
OIDs, ACLs and security settings remain identical.

The supported Supabase CLI session exposed a separate admission defect before
any index build: its temporary non-superuser login may SET ROLE postgres, but
the existing maintenance boundary trusted only fixed login names. The companion
prerequisite migration admits that exact catalog privilege. It retains the
request-role rejection rules, complete thaw-certificate predicate, function
ownership and ACLs; a similar login name or membership without SET remains
refused. Native tests use the actual captured auth/entry/platform/boundary graph,
not a replacement freeze predicate. Missing/incomplete/expired certificates and
both hourly/event-owned freezes retain their existing behavior.

The first native index fixture used a local freeze-input stub and did not catch
this connected caller defect. Its admission result was superseded by the real
caller regression, not treated as proof that a production build had started.
Root readback on September 27 also found 20,820/20,826 pages already visible;
the stale-vacuum observation above is dated evidence, not current state.

Installation follows the maintained online snapshot-index pattern:

1. Install the separately qualified maintenance-caller prerequisite once,
   through the existing admitted migration path, and read it back. It refuses
   drift in its own preimage and all connected freeze/DDL function definitions.
   Then read current DDL admission, source hashes, index absence/shape and active
   operation ownership. Use a configured direct or session connection with
   verified TLS. Do not use a transaction pool or a Management API query.
2. Set bounded session timeouts separately, then execute exactly the one
   top-level statement in
   `scripts/ops/build-cashier-totals-index-concurrently.sql`. PostgreSQL forbids
   this operation inside `BEGIN`. Preserve the hourly/event freeze guard; no
   override or blocking fallback exists.
3. Read the durable index catalog and same-session outcome. An error can leave
   an invalid, maintained index. An unknown acknowledgment requires observing
   that same operation, not another build. Deliberate cleanup is a separate
   explicit `DROP INDEX CONCURRENTLY` only after ownership, inactivity and
   invalidity are proved; never drop a valid index to retry.
4. Once the exact index is valid/ready/live, install the one short qualified
   migration, record its actual history version and read back the options and
   unchanged financial function catalog. Never replay an installed migration.
5. Verify actual visibility maintenance, the equivalent read plan and the
   existing authorized cashier browser test. Source/native success alone is
   not installation or live acceptance.

The online index completed through the owned native TLS session at September27
00:19:09 UTC. Catalog readback reported valid/ready/live and 65,765,376 bytes.
The short settings migration was installed once at 00:19:37 UTC under actual
provider history `20260927001937`; its 4,776 SQL bytes remain unchanged. Readback
verified all four options plus the existing freeze setting and unchanged cashier
RPC OIDs, ACLs and definition hashes. Source filenames match actual history;
neither migration may be replayed. Production browser acceptance is separate.

The maintenance-caller prerequisite was installed once on September 27 at
00:18:20 UTC under provider history `20260927001820`. Readback retained its OID,
owner, ACLs and search path; definition MD5 is
`05b537b57c9f51a5164e20a1cd0e67e0`. The source filename is aligned to that
actual record with unchanged 4,410 SQL bytes; it must not be replayed.
