# 2026-08-27 — findings round 2: the client still believes in the frozen wallet pool

Fresh audit of surfaces not covered in round 1 (`2026-08-26-arena-audit-and-queue-anatomy.md`):
the wallet/cashier pages and the tournament client. Two audit subagents swept;
**every BROKEN item below was then re-verified against `origin/main` (02bc7076)
by direct read** — in this repo neither comments nor agents get taken on faith.

---

## Tier 1 — money is wrong, or a player is told something false about money

### 1. Fourteen client call sites still read `public.wallets` — frozen since 2026-08-21

CLAUDE.md §11.5 is unambiguous: _"`public.wallets` is not the live chip pool. It
has been frozen since 2026-08-21 with 732,591,994.33 chips stranded in it.
Nothing reads it. If you find a money path writing to it, that path is broken."_
Fourteen client paths still read it, and one still writes:

| surface                            | site                                                                                  | consequence                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Player Wallet page — all of it** | `WalletService.ts:107` → `useWalletStore.ts:188` → `PlayerWalletPage.tsx:225,366,443` | "All Wallets Combined" and "Playable Now" are sums over a dead table                                                                        |
| **Wallet page Transfer tab**       | `fn_wallet_type_transfer` via `WalletService.ts:301`                                  | moves chips _within_ the dead pool — succeeds, moves nothing real                                                                           |
| **Tournament rebuy pre-check**     | `TournamentService.ts:1795`                                                           | throws "Insufficient chips for rebuy" off the frozen balance **before** the atomic RPC runs — a player with plenty of live chips is refused |
| **Tournament add-on pre-check**    | `TournamentService.ts:1922`                                                           | same false refusal                                                                                                                          |
| **Tournament re-entry pre-check**  | `TournamentService.ts:2042`                                                           | same false refusal                                                                                                                          |
| ChipFlowService                    | `:125,132,179,303,423`                                                                | five reads                                                                                                                                  |
| Agent chip transfer modal          | `ChipTransferModal.tsx:189`                                                           | balance shown from dead pool                                                                                                                |
| Settings page                      | `SettingsPage.tsx:303`                                                                | ditto                                                                                                                                       |
| **WRITE**: `ensureWalletsExist`    | `WalletService.ts:830`, live caller `AgentService.ts:448`                             | upserts rows into the frozen pool                                                                                                           |

**Surgical first step** (safe, high value): delete the three tournament
pre-validation reads. The atomic RPCs behind them are already authoritative and
already produce a real insufficient-funds error from the live pool; a
"better error message" computed from a dead table is a _false refusal gate_ on
three money actions. The rest (wallet page, ChipFlowService) is a real project:
pointing the client at the live pool (`club_members.chip_balance`) changes the
page's semantics from "one global wallet" to "per-club balances" and needs a
product decision about presentation.

### 2. A refused transfer reports "Transferred … Successfully"

`PlayerWalletPage.tsx:393` — `await internalTransfer(...)` then an
unconditional success message. The store's `internalTransfer` **never throws**:
it returns `false` on the mutex skip, on insufficient balance, and on any RPC
failure (`useWalletStore.ts:343-389`). The boolean is discarded, so the `catch`
is dead for every store-level failure and the player is told a refused transfer
succeeded — input cleared, `BALANCE_UPDATED` emitted. (The optimistic revert
itself is correct; only the ignored return is broken.)

### 3. The lobby card flips to "Registered" when registration was cancelled

`TournamentLobbyCard.tsx:276-278` — `await onRegister(id); setIsRegistered(true)`.
The registration hook **never rejects**: it returns early on dialog cancel
(`useTournamentRegistration.ts:138`), on the re-entrancy ref (`:103`), and
swallows failures into a toast (`:278`). All three resolve, so the card shows
"Registered" for a player who bought nothing — directly under a comment
claiming _"Only a call that actually happened and actually resolved counts."_
Fix: the hook's `onSuccess` callback, not `await`.

### 4. Unregister on TournamentPage: no double-submit guard, client-computed refund

`TournamentPage.tsx:645-691` — no in-flight flag, button never disabled: two
taps = two `fn_unregister_from_tournament` calls and two optimistic prize-pool
decrements. The refund toast prints a **client-computed** total while the
server's authoritative `refunded` amount is discarded
(`TournamentService.ts:1003` returns it; `unregisterPlayer` is `Promise<void>`).
`TournamentDetails.tsx:982` has the guard — this page is the outlier.

---

## Tier 2 — idempotency: keys minted per call, not per intent

The dangerous shape: server commits, response is lost, user retries, second
debit. A key minted fresh _inside_ the call protects nothing. Four sites, each
with a correct reference implementation sitting nearby:

- `CashierPage.tsx:1452` — `p_op_id: newOpId()` inline on `fn_agent_wallet_send`,
  under a 30-line comment claiming this exact defect was fixed.
- `CashierPage.tsx:2299` — distribute-promo passes no `idempotencyKey`;
  `clubArenaApi.ts:36-43` documents this precise failure mode as why the option exists.
- `CashierPage.tsx:1595,1660` — cashout omits the optional `opId`
  (`CashoutService.ts:51`: _"it just cannot protect a retry it never sees"_).
  `CashoutRequestModal.tsx:377` does it right for the same action.
- `WalletCashierModal.tsx:973,1010` — claimBack/reverse inline keys, in the same
  file whose `doSend` (`:855-927`) is the reference pattern.

Plus: `WalletService.ts:300-309` wraps `fn_wallet_type_transfer` in
`retryAsync` with **no key at all** — a network-layer reject after a committed
first attempt moves the money twice. And `CashierPage.tsx:1637`
`processHighValueCashout` has no in-flight guard (the non-modal path stamps
`lastActionRef`; the confirm-modal path skips it).

---

## Tier 3 — UI truth and waste

- **Failed tournament query renders as "No Tournaments Found"** + a Create
  button (`TournamentLobbyPage.tsx:511,847`) — an RLS/network failure presented
  as fact. `TournamentPage.tsx:1437` has the three-state pattern to copy.
- **The lobby mystery-bounty chest is permanently dead** —
  `lobbyChestQueue.enqueue` has **zero** call sites; its only caller was deleted
  (`TournamentPage.tsx:116,1741`). The comment claims lobby viewers "see the
  same event"; they see nothing.
- **TournamentPage re-renders once per second** (fresh object literals in a 1s
  interval, `:977-1011`) and its detail-tables effect **tears down every 15s**
  (depends on the `selectedTournament` object identity, `:1016` — the same bug
  fixed two effects earlier at `:723`, keyed on `.id`).
- Level chip falls back to a hardcoded 10 minutes (`TournamentService.ts:1496`)
  instead of going through `blindLevelMinutes`, the helper that exists for
  exactly this.
- Dead: `LegacyCreateTournamentModal` (~170 lines, never rendered),
  `EliminationOverlay`/`tableService` imports, `isRegisteringMtt` destructured
  and unused while the Register button has no busy state, an unreachable
  `result.success` else-branch in `RebuyModal.tsx:49`, payout figures at
  `TournamentPage.tsx:1580,1700` computed as raw `prize_pool * pct / 100` with
  no rounding helper.
- `DepositWithdrawModal` is honestly inert, but the seam it leaves sends
  **client-computed fees and caps** (`:371,:394,:500`) — whoever restores the
  endpoint must recompute server-side; the header already carrying a key will
  make it look done when it is not.

**Verified clean** (so nobody re-audits them): `CashierTradePage.tsx:1236-1266`,
`WalletCashierModal.doSend`, `CashoutRequestModal.tsx:334-380` — these are the
reference implementations the broken sites should copy.

---

## Carryover from round 1, still open

The `availableActions` snapshot pipe (one derivation left, by design, at the
ActionPanel render site — wants its own PR with gameplay testing); the 1 Hz
time-bank tick re-rendering TablePage; `check-migrations-applied` still has no
live-schema fallback (fail-closed, needs someone who can exercise the gate);
the ClubHomePage 600-899 loader extraction; the branch-deletion decision
(106 proven deadwood + 14 sentry relics, list in `_agent_tmp/branch-analysis.tsv`).

## Recommended order

1. Delete the three frozen-pool pre-checks in TournamentService (small, pure win).
2. Honour `internalTransfer`'s boolean + wire the lobby card to `onSuccess` (small).
3. The idempotency sweep: five sites, each copying its in-file reference pattern.
4. Decide the Player Wallet page's future (product call: per-club balances).
5. The rest per round 1.
