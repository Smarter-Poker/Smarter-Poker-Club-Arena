# One refused stale identity no longer strands the others

2026-10-26

## What failed

Club Create Certification failed 28 times in a row over 14.5 hours. Every
failure was the same cleanup error:

> Stale Create Club Fixture Recovery Failed: Certification club
> e79ef191-3871-4ac8-9340-9213e0ca5b1e retirement was refused: this club has
> played: it is not a fixture

`cleanupStaleProductionE2EAccounts` (scripts/ci/production-e2e-account.mjs)
retires the clubs owned by each stale post-deploy identity and then removes
the identity. It threw on the first identity it could not recover.

What production held (read 2026-10-26, all private, no registrations, no
seats, zero chips):

| Club                         | Created      | State   | Holds                                                                |
| ---------------------------- | ------------ | ------- | -------------------------------------------------------------------- |
| Crest Cert Lobby 01a16659    | Oct 23 18:17 | retired | 1 closed table, 1 cancelled tournament with its cancellation receipt |
| Crest Cert Template 2793e75d | Oct 23 21:55 | active  | 21 tables, 12 registering tournaments                                |
| Crest Cert Template 095896f4 | Oct 24 15:09 | active  | 21 tables, 12 registering tournaments                                |

The Lobby club came from a certification that no longer exists on main. It
was retired off the live board on the day it was made. The retirement door
(`fn_ca_retire_certification_club`) never deletes a club that has tables,
tournaments or agents. Its tournament's `tournament_cancellation_receipts` row
references it with RESTRICT, and that receipt is an immutable record, so the
club can never be deleted. "Retired" is its correct final state. The account
door refuses any identity that owns a club, so its stale owner could never be
removed either.

Because the sweep stopped at that first identity, the two identities behind
it were never reached. Their active Template fixtures stayed up for two to
three days. #8152 noted those two owners and left them for this sweep.

## The fix

- Every stale candidate is still validated before any is touched. An invalid
  candidate still refuses the whole inventory.
- Each identity is then recovered on its own. A failure is collected, every
  other identity is still tried, and the run then fails with an AggregateError
  that names every failure and counts recovered and kept identities.
- The door's refusal is now carried as data on the error (`error.refusal`),
  next to the exported `RETIREMENT_REFUSAL_CLUB_HAS_HISTORY`.
- In the stale sweep only, a club that answers exactly that refusal and is
  already `lifecycle_status = 'retired'` is the finished state, not a failure.
  Its identity is kept as the owner of record, named in the log on every run,
  and not sent to the account door. The same refusal for a club that is still
  active fails the run as before. Every other caller of
  `retireProductionCreateClubFixtures` keeps the refusal as an error.

Nothing in the database changes, and no record is deleted or rewritten.

## Proof

`tests/unit/productionE2EAccount.test.ts`, new block "one refused stale
identity no longer strands the others", models the production state above:

- The retired Lobby fixture is kept and named, both Template identities are
  recovered, and the run succeeds.
- The same refusal on a club that is still active fails the run.
- After one identity fails, the next is still recovered and the run fails
  naming the first.
- An invalid candidate refuses the inventory before anything is touched.

Mutations: making the loop throw on the first failure, or no longer
recognising a retired club, each turns one of these red. The existing 109
cases in the file and `clubCreateCertificationContract.test.ts` still pass.
