# 2026-10-18 - A club in the union plays only the union's games

Dan, verbatim: "YES, ANYTIME A CLUB 'JOINS THE UNION' THEY ONLY PLAY MIDWAY
UNION CASH GAMES, TOURNAMENTS, SPINS AND SIT N GO'S."

## The defect

Deep Stack Society joined Midway Union on 2026-10-12 and owns no tables of its
own, but the horse controller still listed it as its own host
(`server/src/services/StableHand.ts`, `WALLETS_FOR_HOST` / `hostForWallet`). A
sit is legal only when the wallet's host is the table's host, so none of its
416 horses could sit at any of the union's 94 cash tables, and its club card
read 0 CASH. Union tournaments were unaffected because entry uses
`fn_ca_entry_scope_ok`, which already reads the union.

## The fix

Deep Stack Society's wallet is a Midway Union wallet, like Club JAQK's and Shark
Club's. Midway Union is the only host (`STABLE_HAND_HOSTS`, the floor snapshot
loop). This matches `fn_assign_horse_stake_bands`, whose host for a member is
already `coalesce(clubs.union_id, clubs.id)`. Occupancy caps are per host and
scale from the live body count, so they follow on their own. T10 and T31 in
`StableHand.test.ts` were rewritten in the same commit to pin the new rule.
