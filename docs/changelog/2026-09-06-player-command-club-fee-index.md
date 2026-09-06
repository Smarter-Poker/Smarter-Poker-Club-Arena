# Player Command Club Fee Index

## Outcome

Player Command's staff roster can now seek directly into the selected club's
hand facts when calculating fee and hand totals. It no longer has to inspect
facts belonging to other clubs before returning the first roster page.

## Safety

- The existing server-side current-club and downline authorization remains the
  source of truth.
- The index is built concurrently so hand-settlement writes remain available.
- No club, member, horse, wallet, balance, or chip row is changed.
- Deployment fails closed if PostgreSQL does not report the index ready and
  valid.

## Evidence

- Production runs `34023330596` and `34026631034` both caught the cold roster
  page exceeding its 45-second release budget.
- `tests/unit/playerCommandClubFeeIndex.test.ts` locks the club scoping, index
  shape, concurrent build, and validity check into the suite.
