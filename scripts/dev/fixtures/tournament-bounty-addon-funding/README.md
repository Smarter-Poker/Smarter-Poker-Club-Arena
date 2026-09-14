# Funded bounty entry and add-on

Run only this missing boundary through the existing private PostgreSQL 17 runner:

```sh
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --purchases-only --bounty-addon-only
```

The purchase module selects this focused extension before its existing groups. The optional setup callback configures a PKO bounty before invoking the real registration authority. Table, seat and running state remain the existing synthetic purchase inputs. The private runner bounds WAL growth and checkpoints between these cases.

The real 200-chip entry funds 175 prize, 5 bounty and 20 fee, with a 5-chip player bounty head. The real 15-chip add-on funds 15 prize and zero bounty or fee; seat and roster rise from 500 to 600 chips. Bounty escrow, bounty pool, cumulative bounty funding, immutable refund-bounty provenance and player head remain 5. A repeated add-on with a different client token returns the stored response without changing any tracked financial, seat or receipt row.

The original whole-bounty group passed on September 10. On September 13 this was expanded to heads of 5, 1.50 and 6.75. Every case checks exact entry funding, add-on preservation and replay. Each also invokes the current chip-conservation guard with insufficient supply and checks that the failed purchase rolls back all tracked balances, seats and receipts. Six groups pass; evidence `/tmp/ca-registration-funding-pg17-_sswsnkx/results.json`. The private cluster was stopped and removed.

The fixture reuses the existing registration, satellite-refund and purchase foundations. Its original source-pinned overlay preserves the tournament-scoped settlement lock and scalar seat lookup. After checking that baseline, `current-purchase.json` installs nine unmodified bodies captured September 13: purchase wrapper, money helper, fee/unit helpers and real chip-supply/conservation functions. Every captured body hash is checked before installation and against the resulting catalog. The two current purchase hashes are `607e4daf9060a1176e032016b8879808` and `7d52ab3f9a763a07ec9f4059d58c3e8a`. Read-only production checks also confirm that the inherited request (`c80d08529c03284adc51c6cb03764a55`) and two-argument registration core (`233acf6219e11af17d2c44b4b4460bc0`) still match. Structural support adds a chips denomination and an empty supply-acknowledgment table; no acknowledgment is invented to pass conservation.

This proves the tested chip entry/add-on composition, including fractional heads. It does not certify Diamond entries, a bounty obligation or payout, rebuy/re-entry after that payout, actual startup, hand commit, engine grant consumption, the entire production trigger graph or HTTP/RLS. The current wrapper's rebuy-generation branch is not exercised. Inherited auth/session and maintenance stand-ins remain explicit. The three inherited bounty-payment read shapes remain empty. No prior payout or completion marker is synthesized. No production financial operation or migration is included.
