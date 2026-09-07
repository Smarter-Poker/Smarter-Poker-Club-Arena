# Audit Resume: Tournament Payment Contract

Recovered Revision 8 and inspected live guarantee SQL. Base: b2698309b65af11e3f940f53bbed3c119b2966c3.

The submitted receipt correction (376e74f14c04f4c76802bb4520ab12c9fffb6e9a, PR 3579) is absent from this main checkout. Its server CI failed; client tests and TypeScript passed. The original parser still accepts nonfinite moved amounts and overpaid success totals. Recover the existing behavior tests, reproduce the failure, then integrate the existing correction against current main and finish input-boundary verification. Do not change payment values or historical records.

Live read: 227 overlay records, zero below the tournament guarantee, zero unfinalized short pools, zero missing treasury_after values. This is a bounded historical read, not bank/journal or lifecycle certification.

Verification: pending. No completion claim. No production write performed in this continuation.

The receipt reproduction failed two tests on the original code. Recovered receipt logic plus malformed-reply handling passes 24 focused tests. Root and server typechecks pass. A full server run passed 6,480 tests and failed two metrics tests: both assumed an absent database, but used the checkout's configured live read client. Their failure is now explicitly injected at the Supabase boundary; the real collectors and snapshot assertions are unchanged. No monitor or production reporting behavior was added.

## Paid Place Ownership

The live settlement function increased amount_owed before rejecting a different user for an already-paid place. An actual-body temporary fixture reproduced a refused 200-chip request changing the recorded winner's 100-chip obligation to 200. Moving the existing ownership refusal before the update fixes the original transaction path. Installed migration 20260907233957 passed 15 cases covering higher/equal/lower requests, place/late-reg aliases, partially/fully paid winners, owner replay and a valid 30-chip top-up followed by replay. Credit and escrow helpers were mocked; real wallet triggers and simultaneous sessions remain untested. All fixtures self-aborted. No historical payment was made. The first apply failed on a missing function terminator and committed no change; the corrected single-transaction apply succeeded. The source filename matches the database-assigned version.

Both metrics isolation suites now pass: 25 tests. No assertions or time limits were weakened. Full server rerun and delivery verification remain pending.

Full server verification completed successfully: 456 test files, 6,482 tests passed, exit 0. The metrics fixtures now explicitly simulate an unavailable database, as their assertions require. Root and server TypeScript checks and 48 shipped-invariant tests also passed. These results do not certify all 216 audit requirements or live end-to-end money behavior.
