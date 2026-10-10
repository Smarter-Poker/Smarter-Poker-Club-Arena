# Player Command dated ledger and performance reads

The final live audit of Player Command at Deep Stack Society found a remaining
database statement timeout on Player Record's Seven Days control at 08:59 UTC.
The previous repair made lifetime reads fast; its dated branch still read the
hand-fact heap. A bounded read-only plan took 3,755 ms and 4,886 disk pages,
reading 18,557 player facts to return 9,161 dated facts. The performance RPC
used that same heap for its aggregates and all-time variant selector.

Two separately reserved migrations put exact UTC-day, normalized variant and
cash/MTT fact counts, fee/net amounts and recorded performance numerators at
the original fact transaction. Statement transition triggers handle insert,
update and deletion, including day, user, club, variant, classification and
recorded flag changes. Initialization uses one facts/delta snapshot and keeps
concurrent committed writes. It refuses a second seed. The private projections
and trigger functions have no direct browser or service-role writer.

Player Record's dated branch and Player Statistics read these exact facts.
Lifetime records retain their existing play totals. UTC dates, nullable dates
and variants, monetary precision, win/VPIP/PFR/3-bet/c-bet formulas, permission
checks, membership scope and existing retention behavior remain unchanged.
An absent initialization record produces an explicit error instead of zeroes.
Empty retained variant buckets do not remain in the variant selector.

The maintained PostgreSQL qualification command compares the complete RPC
results against the actual production preimages across range/variant matrices.
It covers snapshot concurrency, writer concurrency, duplicate-hand refusal,
corrections, rollback, retention, private grants and readiness failures. A
poisoned facts view reproduces the old dated/performance failure and proves the
new reads no longer depend on scanning the heap. The existing required
accounting workflow executes this extended qualification directly.

Real-time law: original fact INSERT/UPDATE/DELETE statement transitions update
the projection atomically; no polling, snapshot diff or repair job.

This is a database/qualification follow-up to the published Player Command
client repair. No new engine behavior or engine replacement is required.
Installation, protected integration and final live range/performance proof are
recorded separately in the task checkpoint.

The all-recorded captions in MemberManagementPage.tsx (line 533) and
PlayerStatisticsPage.tsx (line 360) said “Showing Lifetime Totals,” although
hand counts and results come from retained facts and shrink with the existing
history retention policy. Both captions now say “Showing All Recorded
Activity.” The figures, formulas and retention policy are unchanged. The
source was read before and after this copy correction; TypeScript and all 54
affected component/source checks passed before submission.
