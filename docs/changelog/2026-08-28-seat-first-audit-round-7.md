# 2026-08-28 — Seat-first audit, round 7: twelve places the code answered a question it could not answer

Round 7 of the Spin sweep. Nothing here came from a bug report; it came from
reading the seat-first path end to end after the visible faults were fixed.

Every finding is the same shape. A read fails, an election returns nothing, a
value is unknown — and the code substitutes the most convenient answer and then
presents it with the confidence of a fact. A failed membership read became "not
a member". An empty table election became "here is the table". A null wallet
balance became "0". A slug compared against a UUID became "not your club".

The user-visible cost of that shape is exactly what Dan reported at the start of
this sweep: surfaces that contradict each other, and games that vanish.

---

## 1. CRITICAL — a recycled Spin tile could send a player into another club's game

**Mine, introduced in #1642.** The sibling hop that rescues a player who taps a
tile whose game has just been recycled matched the replacement on `name +
buy_in_amount + variant + status='REGISTERING'` **with no club or union scope**.

Spin names on this platform are identical by construction — every $20 spin in
every club is called the same thing. So the only thing standing between a
player and a stranger's club was arithmetic:

```
total_registering_spins    33
distinct_name_price_keys   33
clubs_running_spins         1
```

One club runs spins today, so no player has ever been mis-hopped. That is a
coincidence, not a guard, and it evaporates the day a second club opens a $20
spin. The hop now reads the ORIGIN tournament's own `club_id` and
`buy_in_amount` and scopes the search to them; if that row cannot be read, it
finds no sibling rather than guessing. Scoping by the origin's real buy-in also
fixes a quieter bug: Heads-Up SNG tiles carry buy-in plus a 5% fee, so the tile's
displayed price never matched the sibling's `buy_in_amount` column.

## 2. HIGH — a failed membership read evicted a paying member

Both membership reads (fast path and full load) discarded `error`. Supabase
resolves `{ data: null, error }` on a query-level failure, so any transient
failure read as "not a member" and redirected mid-session to `/invite/:club`.
Eviction now requires PROOF: a read that succeeded and showed no active row.
A failed read reports and leaves the player where they are.

## 3. HIGH — the post-spin result card invented a losing result

The result card ran three reads and used `.data` from each without checking
`.error`. A failed read produced "prize 0, finished nowhere, not a Spin" —
indistinguishable from a real bust-out, on the one screen a player checks to
find out what they won. All three now throw to the outer catch, which returns
an honest all-nulls result the card already knows how to render as unknown.

## 4. MEDIUM — seat-first recovery restored the price but not the format

Recovering a seat-first game on reload set `seatFirstBuyIn` and never
`tournamentFormat`. With the format left at its `?? 'mtt'` default, the D2
spin-wheel fallback (`tournamentFormat !== 'spin'`) could never fire and the
HEADS-UP overlay could take the last hand of a three-handed Spin. Recovery now
derives the format from the variant and the seat count, the same rule the
database uses.

## 5. MEDIUM — the buy-in panel offered "Join Spin" on a running game

`GameLobbyPanel` re-spelled the joinability rule by hand and had no `running`
branch, so a spin in progress whose seat count had dipped below capacity (a
bust-out closes a seat row and `fn_sync_seat_first_player_count` decrements)
showed a gold **Join Spin** — while the board row behind it correctly said
Watch. Both seat-first branches now defer to `seatFirstJoinable`, the one list
of dead states `LobbyTable` already uses.

## 6. MEDIUM — the lobby fetch and its realtime filter had drifted apart

The fetch admitted `LATE_REG` and `STARTING_SOON`; `belongsInTournamentList`
re-typed a shorter `['REGISTERING','RUNNING']` beside a comment saying it must
mirror the fetch. A tournament admitted under either extra status would be
DELETED from the board by its own next UPDATE — the row vanishes while the
player is looking at it. That is the exact shape of "every single one
disappears from the spins lobby", so it is fixed whether or not a writer sets
those statuses today. One `LOBBY_TOURNAMENT_STATUSES` array now feeds both.

## 7. MEDIUM — an election that found nothing was silently replaced

`resolveTournamentLiveTable` treats an RPC that SUCCEEDS and returns nothing
the same as an RPC outage, falling through to newest-non-closed. That is the
precise engine/client disagreement the function exists to prevent, reaching
production with no signal. It still falls through — a degraded answer beats a
dead end for the player in front of us — but it is now reported.

## 8. MEDIUM-LOW — the owner's Delete control compared a UUID against a slug

`raw.club_id === clubId` on a `/clubs/:slug` route compares a UUID against a
slug. Always false, so the Delete Table control was silently absent for every
game carrying a `club_id` — which is all of them. Now `resolvedClubId`.

## 9. MEDIUM-LOW — an unknown balance printed as a confident 0

`Your Balance {Number(accountBalance || 0)}` printed **0** for a null
(unreadable) balance, beside an enabled Buy In button. `accountBalance` is
deliberately nullable and the button already respects that; this line was the
last place still inventing a figure. It shows `—` while unknown.

## 10. LOW — a bought seat read "You Are Registered" instead of "You Are Seated"

`playerStateOf` checks `seatedIds` first precisely so a bought seat reads
SEATED, but that set held only TABLE ids while a spin row is keyed by its
TOURNAMENT id — the branch was unreachable. Every seat-holder fell through to
the registered label, the same softer word as the "Spectating" Dan rejected on
the table itself. Verified against production the same day: 41 of 41 live
seat-first seats carry a `tournament_players` row, which is why a wrong label
was the only symptom. The seat set now carries both ids.

## 11. LOW — a failed cash-out read silently dropped the re-entry minimum

The 2-hour re-entry restriction read discarded `error`, so a failure looked
exactly like "no restriction" and the minimum did not apply. Reported now.

## 12. LOW — the seat-bought toast counted from a stale closure

The buy-in callback's dependency list is deliberately narrow (it must not be
rebuilt on every roster change mid-purchase), so `seatFirstBuyIn?.seats` and
`tableState.players` were captured at build time — null and empty. The fallback
that exists for the idempotent re-seat answer therefore read 0 and said
"Waiting For More Players" with no number. Both now read refs.

---

## Verification

- `npx tsc --noEmit` — client 0 errors, server 0 errors
- `npx vitest run tests/` — **555 files, 8524 tests, all passing**
- `server: npx vitest run` — **211 files, 2308 tests, all passing**
- Production SQL confirming #1 is latent and #10 is cosmetic (queries above)
- New pins: `tests/unit/seatFirstAuditRound7.test.ts`, 15 tests, every window
  bounded by `tests/helpers/sourceWindow.ts` — no byte counts.

No migration. All twelve are client-side reads and comparisons; the database
was already correct in every case.
