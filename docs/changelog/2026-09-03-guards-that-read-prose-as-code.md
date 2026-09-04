# Two guards read prose as code, and agents paid for it in `--no-verify`

**2026-09-03**, from two agents reporting the same shape of problem on the same
day. Neither guard was wrong about its rule. Both were wrong about what they
were looking at.

## 1. `check-ui-text` flagged test titles

The rule is "no em dashes in anything **a player can read**", and the script
already ignores source comments for exactly that reason - they never reach a
player. It was flagging

    it('the pot raise is 4.5bb — not 3.5', ...)

because the walker skipped `__tests__` while this repo keeps its suites in
`tests/`, and nothing excluded `*.test.ts`.

An agent then hits a pre-push failure on three test TITLES with a rule about
player-facing copy quoted at them. The obvious way out is `--no-verify`, which
skips the **other eight checks in the same hook, including the secret scan**. A
guard that cries wolf does not merely waste a minute; it teaches people to walk
around the guards that are right.

Test files are excluded now, by directory and by `*.test.*` / `*.spec.*` name.
Nothing is lost: a string a player actually reads has to exist in `src/` or
`server/`, both still fully scanned, and a test can only ASSERT such a string -
which is checked at its source. Verified both ways: an em dash in
`src/` is still caught; the same character in a test title is not.

## 2. CHECK 18 read a retirement notice as a live money route

`check-frozen-aware-money-routes.mjs` tested `MONEY_RE` against the raw file, so
a route whose **comment** merely named a table counted as writing it. A
retirement notice saying "this used to write `chip_balance`; it no longer
touches money" failed as a new, freeze-unaware money route.

That one is corrosive rather than annoying: the fastest way to satisfy it is to
delete the explanation, so the codebase loses the record of _why_ a route was
retired in order to quiet a check that misread it.

Comments are now blanked before either question is asked - both "does this move
money" and "is it freeze-aware", so a comment can neither accuse a route nor
excuse one. String literals are preserved, because `supabase.rpc('fn_credit_and_log')`
is a real call whose name lives in a string, and blanking is done to spaces so
reported line numbers still match.

Verified on five cases: a retirement notice in a block comment (ignored), the
same in a line comment (ignored), a real `.rpc()` call (still caught), a real
`.from('table_seats')` write (still caught), and a URL containing `//` inside a
string (not eaten). Against the live routes the count moves 29 -> 27, and both
routes that drop out - `distribute-promo.js`, `promo-wallet.js` - matched only
on the words `chip_balance` / `chip_treasury` inside comments. Both are in
BASELINE, so no route loses enforcement.

## What this exposed, reported separately

Removing the accident showed that those two routes were only ever counted
because of their comments. Their real RPCs - `mint_club_promo`,
`transfer_promo_club_to_agent` - are not in `MONEY_RE` at all.

Sweeping every RPC the club-arena routes call turned up **sixteen money-shaped
names the pattern misses**, including `fn_debit_chips`,
`fn_approve_cashout_atomic`, `mint_club_chips` and `orb1_buyin_transaction`.
That is a separate and larger finding than the false positive, and it is being
handled in its own change rather than smuggled in here.
