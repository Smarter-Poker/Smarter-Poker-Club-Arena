# Cancellation policy boundary proof

Run from the repository with its existing registration fixtures:

```sh
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --cancellation-policy-only
```

Adding `--baseline` retains the captured installed cancellation body. The observed baseline already reproduced the violation: a tournament with `started_at` set reached the first escrow write and returned the fixture's `PX001` trap instead of refusing cancellation. Repeating that baseline is unnecessary.

The written policy is in `tests/unit/tournamentsNeverCancel.test.ts` and `.agent/audits/2026-08-19-tournament-breaks-rake-and-never-cancel.md`. Started tournaments resume or settle. The installed unfilled, unstarted, pre-draw Spin expiry is a scoped exception. Managed operator close is empty-only. A scheduled `start_time` alone is not proof that a tournament started.

`installed.sql` retains the full captured `atomic_cancel_tournament(uuid,uuid)` and the existing fixture's real escrow functions. A fixture-only `BEFORE INSERT OR UPDATE` trigger traps the first escrow write. Refused cases must return SQLSTATE `55000`; eligible cases must reach the existing financial authority and return `PX001`. This establishes routing and refusal, not successful cancellation funding.

The proposed migration inserts a refusal after existing committed-receipt replay and before any financial path. It checks actual start, running/break status, a positive Spin multiplier, completed launch, durable draw or reserve evidence, persisted hands, and paid non-refund obligations. Live `spin_multiplier` defaults to zero, so only `COALESCE(spin_multiplier,0)>0` is multiplier evidence. The migration accepts only the reviewed baseline body, verifies the resulting body and is idempotent for that exact result.

The revised candidate has fourteen intended groups: nine evidence refusals; generic unstarted, default-zero pre-draw and past-scheduled-start allowed routing; committed-receipt replay; and cancellation waiting behind a transaction that commits draw evidence. All fourteen groups for the revised candidate passed on 2026-09-10: eight refusal cases in the first segment, followed by six remaining cases after correcting a synthetic obligation kind from `prize` to the installed valid value `place`. The first segment stopped at that fixture setup error; the six-case continuation completed with normal cluster cleanup. `runtime-evidence.json` preserves both results without treating the first runner exit as successful. Use `--cancellation-policy-from paid_award` only to reproduce that continuation; the default executes all fourteen groups. The earlier `IS NOT NULL` candidate is superseded and must not be applied.

The draw overlap commits synthetic draw markers while the real cancellation function waits for the parent lock; it does not execute the Spin draw RPC. The stored-response receipt reader is synthetic and proves replay routing only, not canonical receipt validation. Start, hand, and paid-award evidence is seeded directly. Authentication is service-like fixture behavior. These cases do not prove HTTP/RLS, full cancellation settlement, the actual hand commit, actual award payers or historical refund correctness.

Current review hashes are in `source-manifest.json`. Full candidate and supersession details are in the recovery bundle's `candidate-review.json`. The revised runtime result is verified. Production application remains subject to root integration and review.
