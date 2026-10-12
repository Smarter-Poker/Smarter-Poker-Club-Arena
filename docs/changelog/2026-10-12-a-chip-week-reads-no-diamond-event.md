# A Chip Week Reads No Diamond Event (2026-10-12)

## What Happened

The chip week ending 2026-10-12 07:00 UTC is the first that held Diamond Arena tournaments. `fn_settle_tournament_rake` gives a Diamond event a `tournament_rake_settlements` row (destination `diamond_house`, no union) and pays the fee to the Diamond house; it never writes a chip `accounting_tournament_fee_recognitions` row, because no chip moved and no chip rakeback or commission is owed on it. 95 such rows exist (54,739 Diamonds of fees since 2026-10-07).

`fn_accounting_tournament_week_quality` gathers every event settled in the week, and its last survivors clause keeps an event of unknown scope (no union, no recognition, a positive bank amount, no chip rake record) for every club and every union. So each Diamond event answered `tournament_terminal_recognition_missing` to every chip club's week:

- Deep Stack Society's weekly accounting failed (critical `weekly_club_accounting`, 09:23 and 10:25 UTC, incident 74faa844), naming Friday Five-Card Bounty (0125a93a), a Diamond event.
- SHARK CLUB's period recompute for the week was refused 1,446 times on the same event.
- The rakeback settler could not certify the closed week and held its watermark (settler lag incidents c4f239d1 and f7258367).

## Fix

Migration `20261012113542_a_chip_week_reads_no_diamond_event`: the week's candidates leave out Diamond Arena events, by the same definition as `fn_poker_diamond_tournament` (platform club, asset diamonds, no union). Every chip event is read exactly as before. The Diamond book settles Diamond events; nothing in the chip week is owed on them, so no player or club is short or long.

## Proof

- Rolled-back trial against production: the body installs with its preimage pinned.
- Live: both Diamond events named by the refusals (0125a93a and 1f159c52) are now excluded by the patched reader; `accounting_recompute_split_parts` holds no cached verdict from before the fix.

Law: `tests/a-chip-week-reads-no-diamond-event.law.test.ts`.
