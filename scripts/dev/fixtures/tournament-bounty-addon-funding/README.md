# Funded bounty entry and add-on

Run only this missing boundary through the existing private PostgreSQL 17 runner:

```sh
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --purchases-only --bounty-addon-only
```

The shared runner is unchanged; the purchase module selects this focused extension before its existing thirteen groups. The optional setup callback configures a PKO bounty before invoking the real registration authority. Table, seat and running state remain the existing synthetic purchase inputs.

The real 200-chip entry funds 175 prize, 5 bounty and 20 fee, with a 5-chip player bounty head. The real 15-chip add-on funds 15 prize and zero bounty or fee; seat and roster rise from 500 to 600 chips. Bounty escrow, bounty pool, cumulative bounty funding, immutable refund-bounty provenance and player head remain 5. A repeated add-on with a different client token returns the stored response without changing any tracked financial, seat or receipt row.

One group passed on 2026-09-10. Its runner completed normally and removed its private cluster. `runtime-evidence.json` records the observed result. No previous registration, purchase, cancellation or guarantee groups were rerun.

The fixture reuses the existing registration, satellite-refund and purchase bodies. Its small source-pinned overlay preserves the currently installed tournament-scoped settlement lock helper in the public purchase RPC and the installed scalar seat lookup optimization. All 34 purchase/helper bodies are checked against the manifest. A separate read-only catalog check confirmed the registration request and two-argument core bodies match their reused fixture; the request explicitly calls that core.

This proves positive bounty funding and add-on preservation. It does not execute a bounty obligation or payout, rebuy/re-entry after that payout, actual startup, hand commit, engine grant consumption, or HTTP/RLS. The three inherited bounty-payment read shapes remain empty. No prior payout or completion marker is synthesized. No production financial operation or migration is included.
