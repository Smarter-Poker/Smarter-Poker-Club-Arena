# 2026-08-28 — The four-table limit is an answer, not a crash

Third pass over the sit-down flow, after #1620 (the seat-first outage) and
#1633 (refusal-reason mapping). This one found the SAME dead end Dan reported,
reachable by a completely different route.

## What was wrong

`fn_enforce_four_table_limit` and `fn_enforce_booking_game_cap` both
`RAISE ... USING ERRCODE = '23514'`. `fn_take_seat_and_buy_in` caught only
`55000`, so the raise escaped the function and arrived in the browser as a raw
PostgREST error. Proven live in a rolled-back probe against production:

    BEFORE  RAW_EXCEPTION_ESCAPED sqlstate=23514
            message=FOUR TABLE LIMIT: user 6443a6ce-... is already committed to 4 games
    AFTER   STRUCTURED_RETURN: {"ok": false, "limit": 4, "reason": "table_limit_reached"}

That message matched none of the client's toast branches, so a player at their
cap tapping a fifth seat saw **"Could Not Take That Seat, Please Try Again"** —
the exact string from the original bug report, with an entirely different
cause. 29,522 of these were raised in 24 hours across 131 distinct players.

The cash path was worse than useless: its catch-all said _"Buy-in failed.
Please try again or check your balance."_ — sending a player whose balance is
perfectly fine to the cashier to look for a problem that does not exist.

## What changed

**DB** (`the_four_table_limit_is_an_answer_not_a_crash`, applied to production,
post-assertions green): the seat path converts the cap raise into
`{ok:false, reason:'table_limit_reached', limit:4}`, consistent with every
other refusal it returns. Deliberately narrow — `23514` is `check_violation`
generally, so only the four-table message is converted and a bare `RAISE`
re-raises anything else with its original sqlstate and context. Swallowing
every `23514` would hide real constraint bugs behind a friendly sentence.

**Client**: `table_limit_reached` (and the raw `FOUR TABLE LIMIT` text, so the
cash path and any older bundle are covered too) now reads
"You Are Already In Four Games, Leave One To Join Another" on the seat-first
sheet, on the cash buy-in, and in the shared `REGISTER_REASON_TEXT` table.

## What was NOT changed, deliberately

The cap itself. It is the house rule, it is enforced in a trigger under an
advisory lock so it cannot be raced, and it applies to horses exactly as it
applies to humans (HORSES ARE PLAYERS — every at-cap account on the platform
right now is a horse, correctly refused). The only thing that changed is that
the seat path answers with the rule instead of crashing on it.

Regression-checked in the same session: a player NOT at the cap still buys a
seat — `{"ok":true,"cost":50,"seat_reserved":true,"seats_taken":1}`.

---

## Follow-on in the same PR: every cash refusal names its own rule

Reading `atomic_table_buyin` end to end turned up the same failure sixteen
times over. It refuses a seat for sixteen distinct reasons — six of them
already tagged for a machine to read (`IS_TEMPLATE`, `VIP_ONLY`, `NIT_GAME`,
`TABLE_SIZE`, `NO_RATHOLE`, `TABLE_CAP_REACHED`) — and **nothing in the client
had ever read one of those tags**. Banned from the club, VIP-only table, career
VPIP under the table's floor, table full, buy-in under the minimum or over the
maximum, club treasury short: all sixteen arrived as

    "Buy-in failed. Please try again or check your balance."

Wrong in the specific way that wastes an evening — it names the one thing that
is usually not the problem and sends the player to the cashier to look for it.
A player refused for a 400 minimum tops up, tries again, and is refused
identically.

`cashBuyInRefusalText()` now lives in `src/lib/cashBuyIn.ts`, beside the range
helpers, because that file is already the single place cash buy-in truth is
kept. It carries the server's own numbers through wherever the server sent them
("The Minimum Buy In At This Table Is 400", "You Are Already At 4 Cash Tables,
The Limit Is 4") — a minimum a player cannot see is a minimum they cannot meet.

It returns `null` for anything unrecognised, so a new server refusal keeps the
generic text AND stays visible to `reportError` rather than being quietly
relabelled into a sentence that might be wrong.

`tests/unit/cashBuyInRefusalText.test.ts` pins all sixteen against the raise
texts read out of production with `pg_get_functiondef`, plus the null cases.
10 tests, green. If somebody edits a message server-side without updating the
mapper, that test fails instead of the refusal silently reverting to
"check your balance".
