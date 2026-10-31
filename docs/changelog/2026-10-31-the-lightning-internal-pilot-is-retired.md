# The Lightning Internal Pilot is retired

Owner, 2026-10-31: "REMOVE THE LIGHTNING INTERNAL PILOT, AND ANY AND ALL TRACES OF IT IF ITS NO LONGER NEEDED FOR ANYTHING." Lightning went live in Midway Union on 2026-10-24 and the pilot was shut down that day, but club 95087 still showed in the lobby of everyone who belonged to it (146 members).

Nothing still needed it. Every game was dormant, every table closed, every tournament finished, the assignment inactive, no chip had moved since 2026-10-25, every rakeback period was paid and both settlement periods were closed. Only its Diamond Spin wheel and four Diamond games were still switched on.

Migration `20261031184340` settles and retires it in one transaction:

- switches the wheel and the four Diamond games off;
- returns every member wallet (192 wallets, 20,585.66 chips: 191 horses and the KingFish account's 50.00) to the club's main bank, one keyed `club_bank_claim` leg each;
- retires the BBJ (1,405.12), Spin (205.72), bank and promo stores to the Mint through `chip_retirement`; the whole estate was exactly the 100,000 opening grant, so the Mint ends where it started;
- retires the club through `fn_retire_settled_club_core_20260906` as its owner, the platform identity, which rechecks every balance and obligation, flips `lifecycle_status` to `retired`, hides it, writes the audit trail and the identity events. `ClubsService.getUserMemberships` already filters retired clubs out of the lobby, so the card disappears for every member. Records are retained, as for every retired club.

Probed on production in self-aborting transactions before submission: every ledger check passed, 100,000.00 retired by the ledger, the retirement door returned success, about 7 to 11 seconds holding locks only on the pilot's own rows.

The pilot's code, tooling, workflows and its database objects are removed in the follow-up change.
