# A pre-money mystery rebuy retires its old head snapshot

Follow-up to `2026-10-24-mystery-bounty-rebuys-before-the-money.md`.

## What was measured

The first two mystery events after 20261024075911 was installed were the
Union Mystery Bounty (PLO5) events at 2026-10-24 20:30 UTC (d8a59939 and
5b5ca8e1). They had 17 window busts and zero rebuys. Postgres logged 160
refusals in 20 minutes:
`Pre-money mystery rebuy found a live bounty head`.

## Root cause

My earlier fix assumed a pre-money mystery entry carries no head. It does.
Every entry gets `current_bounty = bounty_amount` at registration
(`trg_seed_bounty_head`), and a pre-money bust leaves it there. Both events
show every entry, playing and eliminated, at 10.00. The "live head" refusal
therefore fired on the normal state, every time.

The local replay I wrote for 075911 seeded `current_bounty = 0`. It encoded
the same wrong assumption, so it passed.

## Fix

Migration `20261024204950_a_pre_money_mystery_rebuy_retires_its_old_head_snapshot`
replaces that refusal with the paid mystery path's own exact retirement,
taken from the same function:

- lock the entry row;
- accept a snapshot of 0 or exactly the event `bounty_amount`;
- set it to 0 once;
- refuse anything else.

`process_tournament_rebuy` already requires the new generation's
`current_bounty` to equal exactly the head this purchase funds, which is only
right when it starts from zero.

## Why this moves no money

On a mystery event `current_bounty` is a snapshot, not a balance. The money is
in `tournaments.bounty_pool`:

- mystery payout is paid from chests;
- the residual is `bounty_pool` minus what the obligation ledger paid;
- the paid-mystery rebuy path already zeroes the same snapshot.

So the old head's money stays in the pool as residual, exactly as for an
ordinary pre-money mystery elimination. The rebuy adds its own new head to
the pool.

Every mystery entry in the last three days holds 0 or `bounty_amount`, and
every one of those events is chests-only (regular pool 0%).

## Proof

- **Local replay of the live body** (md5 `b254f96b...`). Before the patch,
  head 10 was refused, head 0 passed and head 7 was refused. After it, head 10
  was retired to 0 with the bystander untouched, head 0 passed, and head 7 was
  refused with "old head changed". A re-run of the migration is a no-op.
- **Production compile.** The patched body compiled on production as a
  `pg_temp` copy inside a self-aborting DO block (`PROBE_OK`). Nothing was
  committed.

## Damage already done

None to settle. Each refused purchase rolled back whole, and each player was
eliminated through the normal door with the normal place.

Pinned by `tests/a-pre-money-mystery-rebuy-retires-its-old-head-snapshot.law.test.ts`.
