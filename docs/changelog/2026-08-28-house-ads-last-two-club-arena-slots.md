# House Ads: the last two Club Arena slots get inventory

**2026-08-28.** `empty_state` and `session_summary` were declared in Phase 1 and
had never carried a single row. The CHECK constraint permitted them, the
resolver served them, and nothing had ever named either. A slot with no
placements renders nothing, which from outside is indistinguishable from a slot
nobody ever built.

Four of five slots now carry inventory:

| slot                  | placements | state                    |
| --------------------- | ---------- | ------------------------ |
| `lobby_strip`         | 6          | live since Phase 1       |
| `hub_promotions`      | 6          | live since earlier today |
| `empty_state`         | 3          | **new**                  |
| `session_summary`     | 3          | **new**                  |
| `table_between_hands` | 0          | deliberately unwired     |

---

## Where they appear, and where they deliberately do not

**`empty_state` renders in one of the lobby's four empty views.** The other
three each carry a remedy — "Show All Games" — and an advert placed beside a fix
competes with the fix. The justification for this slot is that it fills space
that is genuinely dead; a filtered-out list is not dead space, it is a list one
tap away. So the card appears only where the club has nothing running at all and
the player has nothing to tap.

**`session_summary` sits inside the Session Complete card**, under the numbers
and above the actions, so it never comes between a player and Done.

## Which campaigns, and why

The player looking at an empty club needs an answer to "so where do I go
instead", which rules out anything pointing back into the lobby they are already
staring at:

```
tournaments_daily  /tournaments              a board that is running now
bbj_running        /clubs/{clubId}/jackpot   the jackpot is live whether or not tables are
referral_invite    /invite                   nobody here to play with, so bring somebody
```

`spins_jackpot` is deliberately absent: Spins live in this club's own lobby,
which is the empty thing being looked at.

Session Complete gets destinations that need no club, because that host lives at
the app root, survives the `navigate()` off the table, and therefore calls the
resolver with NULL. Since `20260828034000` the resolver **drops** a destination
carrying an unresolvable `{clubId}` rather than serving a broken link, so every
placement here names its own path explicitly.

## The one judgement call on the page

**`diamonds_store` is not placed on `session_summary`.** Roughly half the
players seeing that card have just lost, and it is the only house campaign that
asks somebody to spend money. The moment immediately after a loss is the moment
not to ask.

That is a decision about people, not a mechanic, so it should be Dan's and not a
side effect of placing everything everywhere. It is one `INSERT` if he wants it.
A test pins its absence so the reasoning has to be met head-on rather than
quietly reversed.

## An assertion that fired, and was right to

The first version of this migration asserted through `fn_resolve_ads` that all
three `session_summary` placements resolve with no club. It got 2 of 3 and
aborted the whole migration.

The data was fine. The probe was wrong: a migration runs as `postgres`, so
`auth.uid()` is NULL, and a NULL user can never match the `non_vip` audience
that `vip_upsell` carries. Nothing half-applied, which is the entire point of
putting assertions in these files.

The assertion now asks the question actually worth asking — _does any
destination on this surface need a club it will never be given_ — against the
placements themselves rather than through the resolver's audience logic.

## Verification

```
npx tsc --noEmit                clean
npx vitest run tests/           503 files, 0 failures
ad_placement by slot            lobby_strip 6 · hub_promotions 6 · empty_state 3 · session_summary 3
```

Seven new source-pinned tests, including one that fails if `HouseAdCard` ever
starts deciding eligibility for itself, and one that fails if the card is
rendered in an empty view that already offers the player a fix.

## Still unwired, on purpose

`table_between_hands`. An advert near the felt competes with the game itself: it
must never overlap action controls, never appear mid-hand and never delay a
deal. An unused declared slot costs nothing, and this one is Dan's call.
