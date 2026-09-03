# 2026-09-02 — The card said his real name

> "THE ONE THING THAT SHOULD BE STICHED ON THE CLUB CARD, IS THE 'REAL NAME'
> SHOULD NEVER BE DISPLAYED, IT SHOULD ALWAYS BE USING THE 'POKER ALIAS'
> KingFish instead of the real name here..."

He had already said this once, on 2026-08-23, and it is quoted at the top of
`src/utils/playerDisplayName.ts`:

> "IM DAN BEKAVAC ON SOCIAL AND KINGFISH IN THE CLUB ARENA. NOTHING ELSE."

The resolver that enforces it was written that day. The club card never called
it.

## What was actually wrong

Three separate faults, any one of which was enough on its own:

```
ClubHomePage      pokerAlias={currentUser?.display_name || currentUser?.username}
useUserStore      UserProfile has no `alias` field; loadProfile never selects it
playerDisplayName arena branch falls through to display_name
```

The card asked for `display_name` first. Dan's row:

| column       | value       |
| ------------ | ----------- |
| alias        | KingFish    |
| username     | kingfish    |
| display_name | Dan Bekavac |
| full_name    | Dan Bekavac |

So it printed his legal name while the alias sat one column away — and even if
the card had asked for the alias it would have got nothing, because the store
never loaded that column.

**This is not one account.** Measured against production:

- `display_name` is an exact copy of `full_name` on **264 of 1,308 profiles**.
- `use_real_name` is true for **0** of them. Nobody opted in.
- 250 of those 264 **already have an alias set** that the card ignored.

## Why `username` was not the fix either

The obvious patch — reorder to `username || display_name` — is also wrong:

- **137 usernames are exactly the profile's `full_name`** (case-insensitive).
- 231 usernames contain a space.

By contrast `alias` matches `full_name` on **zero** rows and contains a space on
zero rows. `alias` is the poker handle; `username` is a login credential that
many players filled in with their name.

## The fix

`playerDisplayName(currentUser, 'arena')` — the house resolver, unchanged in
shape: `alias → username → display_name (only if it is not the real name) →
'Player'`.

1. **`useUserStore`** now selects `PLAYER_NAME_COLUMNS` instead of a
   hand-written list, and carries the six name fields on `UserProfile`. Using
   the constant rather than re-typing the columns is the point: a screen
   resolving a name from a store missing one of them degrades silently to the
   wrong answer, which is exactly what happened here.

   All eight columns were verified `granted_to_authenticated` against the live
   schema **before** being added. That check is not ceremony — the comment
   already sitting on that select records that `select('*')` 403'd the whole
   statement over ungranted columns, and the store then silently never
   populated.

2. **`ClubHomePage`** uses the resolver for the card, and for the invite share
   text — the same leak pointed further out, since that string goes to the OS
   share sheet and on into WhatsApp, SMS, or wherever the invite is forwarded.

3. **`playerDisplayName`'s arena branch** no longer falls through to a
   `display_name` that IS the real name. Its own header has always promised "a
   real name is NEVER shown here, whatever the profile says"; the code
   disagreed, and the code is what players saw.

   The legacy fallback itself stays. It is deliberate, it is pinned in
   `playerDisplayName.test.ts` ("it may still be the only thing present on a
   legacy row, so it stays as a last resort"), and both pinned cases carry no
   real name — so both stay green. It is skipped only in the one case it was
   never meant to cover. `social` is untouched: that is the surface where a real
   name may appear, if the player asked for it.

4. The dev showcase seeded `pokerAlias="Dan Bekavac"`. That page is what the
   next person copies from.

## Pins

`tests/unit/lobbyTournamentBoardDesign.test.ts` contained
`expect(page).toContain("currentUser?.display_name || currentUser?.username ||
'Player'")` — a pin **on the defect**. It now guards the rule: the card resolves
through `playerDisplayName`, and never reaches for `display_name` itself.

`tests/unit/lobbyMobileControls.test.tsx` renders the card with Dan's real row
shape and asserts the alias appears and the surname appears nowhere in the DOM —
because what is being guarded is what a player sees.

`tests/unit/playerDisplayName.test.ts` gains the arena-fallback case, including
case-insensitivity and a real name assembled from `first_name`/`last_name`
rather than `full_name`.

## Verification

- `npx tsc --noEmit` — exit 0
- `npx vitest run` — **856 files, 11,717 tests, all passing**
- `npm run build` — exit 0

## Still open — for Dan, not for an agent to decide

`display_name` is printed by roughly thirty other call sites, each with its own
`a || b` chain. Some are clearly player-facing and carry the same leak: club
chat, the friends list, online-friends, player notes, the BBJ ticker, and the
agent invite and distribution panels. Others are **staff** surfaces —
`AuditLog`, `StatsExport`, `TableOperationsPanel`, the agent commission
dashboard — where an operator identifying a real person may well be the point.

Converting the player-facing ones is mechanical. Deciding whether an admin audit
log should stop showing legal names is a policy call about your own operators,
so it is written down here rather than made quietly inside a refactor.
