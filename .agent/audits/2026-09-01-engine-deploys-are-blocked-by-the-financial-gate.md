# Engine deploys are blocked by the financial gate (2026-09-01)

**Status: reported, not fixed. This is a money path and the decision is Dan's.**

## What is happening

`auto-deploy-hetzner.yml` has failed its last three runs (15:25, 15:37, 15:54
UTC), all on the same step:

    Financial health-gate (zero-drift phase 5)
      FAIL  trailing 4h unexplained chip supply is -4162775.63
    [check-chip-conservation] FAILED

The gate is doing exactly its job. It refuses to ship the engine while the
books do not balance, and it should not be bypassed. There is a
`[skip-financial-gate]` commit tag; using it on a chip-supply alarm would be
precisely the wrong move.

## The consequence, which is what makes this urgent

**Nothing merged to `server/**` today is live.\*\* The running container was
built at 03:54 UTC, hours before any of it merged. Proved directly rather than
inferred:

    docker inspect club-arena-engine -> created 2026-09-01T03:54:43Z
    docker exec ... grep -rl 'noteGtoMiss' /app/dist /app/src   -> 0 matches
    docker exec ... grep -c 'beyondGtoDepthCeiling' ...          -> no match

and from the telemetry side, on a day with 715,866 decisions:

    gto_miss_no_cell      7,785 fires
    v32_defend_no_range   6,457 fires
    v31_miss_depth_*          absent
    v32_miss_depth_*          absent
    gto_skip_too_deep         absent

`noteGtoMiss` is called on the line immediately after the `gto_miss_no_cell`
counter. The first fires and the second does not, so the deployed engine
predates that change. Five merged PRs are waiting: #2464, #2467, #2470, #2474,
#2479.

## What the alarm actually is

Total chip supply is CONSERVED. Across six hours it moved from 189,865,036 to
189,863,289 - a drift of about 1,700 on 189 million, which is ordinary rake
and settlement noise.

The spike is a single pool moving, and the ledger classifying that movement as
a mint:

| Time (UTC) | member_wallets  | agent_wallets  | mint_since_prev | unexplained    |
| ---------- | --------------- | -------------- | --------------- | -------------- |
| 12:05      | 171,520,148     | 6,726,000      | 4,159,644       | 258            |
| 13:05      | 171,520,377     | 10,066,000     | 4,159,644       | +1,582,259     |
| 14:05      | **167,790,742** | **13,796,000** | 5,741,355       | **-5,743,763** |
| 15:05      | 171,520,868     | 10,066,000     | 0               | -1,530         |
| 16:05      | 171,519,367     | 10,066,000     | 0               | +371           |

At 14:05 member wallets are down 3,730,000 and agent wallets are up by the
same 3,730,000, and it reverses an hour later. Note also that `mint_since_prev`
reports the identical 4,159,644.00 at both 12:05 and 13:05 - the same movement
counted in two consecutive snapshots.

So the reading is: **agent-wallet funding is being written to the mint ledger
rather than recorded as a transfer between pools.** Nothing was created and
nothing was lost; the conservation check compares the pool delta against the
mint ledger, the mint ledger claims 5.74M was minted, the pools say nothing
was, and the difference is reported as unexplained.

I have NOT changed anything here. Per CLAUDE.md 11.5 a money path is not
probed or patched on an agent's own reading of it, and the classification of
agent funding is a design decision, not a bug I can assume.

## It self-clears, and that is also a problem

The gate sums `unexplained` over a trailing 4 hours. Modelling the window
forward:

| Gate runs at | Sees      | Verdict  |
| ------------ | --------- | -------- |
| 17:00        | 4,162,663 | FAIL     |
| 17:30        | 5,744,922 | FAIL     |
| 18:00        | 5,744,922 | FAIL     |
| 18:30        | 1,159     | **PASS** |

Once the 14:05 snapshot ages out the gate goes green on its own and today's
engine work deploys on the next run. That is convenient and it is the wrong
property: **a real chip leak would also age out of a 4-hour window.** The gate
forgets, so the only thing standing between a genuine loss and a silent
recovery is whether somebody happened to look inside the window.

## Recommended, for Dan to decide

1. **Classify agent-wallet funding as a transfer, not a mint.** That removes
   the phantom at its source. Money path, so it needs your sign-off.
2. **Make the conservation failure sticky.** A breach inside the window should
   raise a durable record that has to be cleared deliberately, rather than
   expiring after four hours. As it stands the gate can only catch a leak
   during the four hours it happens to span.
3. Until either lands, expect the engine to deploy in bursts: blocked while a
   funding run is inside the window, released afterwards.
