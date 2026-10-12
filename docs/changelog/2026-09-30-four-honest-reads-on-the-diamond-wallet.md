# Four honest reads on the diamond wallet (2026-09-30)

A deep-dive audit of the Club Arena diamond wallet found four defects. Three of
them are the same defect wearing different clothes: a read that could not
answer, answering anyway. The fourth is a column carried on two money queries
that nothing has printed since phase 6.

---

## 1. The VIP page showed a player ZERO diamonds for a read that failed

`src/pages/VIPPage.tsx` read the balance and the points with the error thrown
away:

```ts
const { data: profData } = await supabase.from('profiles').select('diamonds')...
const { data: vp } = await supabase.from('vip_points')...
```

supabase-js RESOLVES with `{ data: null, error }`; it does not throw. So an RLS
denial, a dropped link or a PGRST002 503 gave `profData === null`, and the next
line read `setDiamonds(profData?.diamonds || 0)`. The player was told they held
**zero diamonds**. Two lines further down, `current` and `lifetime` VIP points
took the same route to the same zero.

That is CLAUDE.md 10.86 rules 1 and 2, on a money surface: "I could not tell"
was folded into a confident figure, and an unreadable answer was coerced into
an empty one. A balance of 0 is not a neutral display. It is a specific,
actionable claim - it greys out every Buy button on the page and tells somebody
with a full wallet to go and top up.

The correct posture was already ten lines below, in the diamond-ledger read
added in phase 6: bind `ledgerError`, call `reportError`, and set a distinct
`'error'` state. That is now extended to both reads above it.

- `diamondBalanceState` and `vipPointsState`, each `'loading' | 'ready' |
'error'`, sit beside the existing `diamondActivityState`.
- Each read binds its error, reports it
  (`VIPPage.Diamond_balance_load_failed`, `VIPPage.Vip_points_load_failed`),
  and sets `'error'`.
- The `catch` that wraps the whole load sets both, because whatever threw, none
  of these figures was read.
- Both reset to `'loading'` on an account switch and on every refresh, so a
  previous account's verdict cannot paint the next one.
- A balance that arrives from a completed movement - the
  `DIAMOND_BALANCE_CHANGED` bus event, or the top-up modal's
  `onPurchaseComplete` - is a real read and clears an earlier "could not tell".

What the player sees in the unknown state is the word **Unavailable**, never a
number: on the big diamond count (at a size that still fits beside the two
action buttons at 375px), on the header's Current Points metric, and on the
membership plate's Points and Lifetime figures. `VIPMembershipPlate` takes an
optional `pointsState`, defaulting to `'ready'`, so no other caller changes.

The a-la-carte Buy buttons need no separate guard: they are disabled while
`diamonds < pricing.cost`, and the unknown state holds `diamonds` at 0 while
every listed feature costs more than 0.

**Pinned by:** `tests/unit/discardedErrorReadRatchet.test.ts` -
`src/pages/VIPPage.tsx` moves from a baseline of 2 to **0**, which is the
ratchet's own rule (a file that shrinks tightens its number in the same
commit). The entry is kept at 0 rather than deleted, so a reintroduction is a
diff on that line. Plus `tests/unit/VIPPageHonestReads.test.tsx`, which renders
the page with each read failing and asserts the word on screen.

## 2. A dead `description` column on two money queries, and two laws pulling apart

`useDiamondLedger` and `DiamondWalletModal` both selected `description` from
`diamond_transactions` and both mapped it onto their row shape. Nothing read
it. Phase 6 moved every wallet surface onto `player_line`:

| surface                        | what it actually prints                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `PlayerWalletPage.describeRow` | `row.counterpartyId` -> a friend's name, else `formatPopupText(row.line \|\| row.label)` |
| `DiamondWalletModal`           | `formatPopupText(tx.line \|\| label)`                                                    |
| `VIPPage`                      | `player_line`, else the kind's row label                                                 |

Proved before removing it: a repo-wide grep for `.description` shows
`useDiamondLedger.ts:166` and `DiamondWalletModal.tsx:270` as the only places
that touched the field on these paths, and both were the mapper's own
assignment. Three surfaces, zero readers. `PlayerWalletPage`'s other
`description` uses are the wallet-plate copy config, unrelated to the ledger.

Two written rules disagreed about what to do:

- `docs/laws.d/the-route-and-the-client-agree.md` (phase 8, 2026-09-29): a
  column "selected but never read is dead weight on a money query".
- `tests/the-ledger-speaks-to-the-player.law.test.ts:105-108` (phase 6,
  2026-09-20): the literal `description` must stay in both selects.

The phase-6 pin was right when it was written. `player_line` had just landed
beside the old copy, and keeping the old column asked-for was how the law
showed it was PRESENT but no longer printed. Nine days later that had become
the opposite of a guard.

CLAUDE.md 10.8: apply the later rule, do not invent a third. So:

- `description` is dropped from both selects, both row types and both mappers;
- the **phase-6 law is repointed in the same commit**, not weakened. It used to
  require `description` on the select; it now requires its ABSENCE, from the
  select AND from the mapper (`\b(tx|row|entry|t)\.description\b`), which is a
  stricter statement than "present but unprinted". Everything the law has
  always protected - that a player reads `player_line` and never an operator's
  audit note - is unchanged and still asserted;
- the phase-8 law's `LEDGER_READS` lists move with them.

**Why phase 8's own check could not catch this, and why it is NOT "fixed".**
`keysReadFrom()` regex-matches `tx.<key>` anywhere in the file, so the mapper
counts as a reader. The obvious repair - ignore a `<key>: ...<row>.<key>...`
assignment - is wrong here and would fail loudly on correct code the first time
it ran: on these surfaces EVERY selected column is touched exactly once, in the
mapper, and nowhere else in the file. `tx.id`, `tx.amount`, `tx.created_at` and
`tx.metadata` are indistinguishable from `tx.description` under that narrowing,
and all four are genuinely printed - by a different file, off the mapped shape.
Telling them apart means following the mapped row's type into its consumers,
which is a different check and not a regex. Narrowing it would turn a law with
three honest outcomes into one that fails on correct code, which is 10.86 in
the other direction. The reasoning is written above `keysReadFrom` so the next
person does not re-derive it, and the mapper-assignment case is pinned where it
can be stated exactly: in the phase-6 law, by name, for these three files.

## 3. The VIP activity list could print a bare snake_case kind

`(entry.player_line) || kind || 'Diamonds Earned'` would have rendered
`arena_deposit` to a player. Every other surface falls back to
`diamondTxLabel(kind)`, which says "Diamond Arena Buy-In".

Latent, not live: 400 of the most recent production rows all carry a good
`player_line`, so the fallback is unreachable on current data. Fixed anyway,
because "unreachable on today's rows" is a statement about the data, not about
the code. The fallback is now `diamondTxLabel(kind)`, identical to
`PlayerWalletPage` and `DiamondWalletModal`. The direction-based
`'Diamonds Earned' / 'Diamonds Spent'` tail is gone because it was already
unreachable: `diamondTxLabel` never returns blank - an unknown kind is Title
Cased and an empty one reads "Diamond Movement".

## 4. Dead code in DiamondService carrying the same trap

`DiamondService.getTransactions` did `if (error || !data) return [];` - an
unreadable answer became "this player has no transactions" - and it had **zero
callers** anywhere in the repo. (The one `getTransactions` mock in the suite is
`WalletService`'s, a different module; `useWalletStore` calls
`DiamondService.getBalance` and `WalletService.getTransactionHistory`.)

It was worse than an idle landmine. It read the CHIP ledger: six
`wallet_transactions` categories, five of them rejected outright by
`wallet_transactions_category_check`, and the sixth (`mint`) recording chips
minted into a treasury. `DiamondWalletModal` removed precisely this query from
the wallet on those grounds, with the note still in the file - a mint row put a
five-figure chip movement on a diamond statement. This was the same query,
still loaded, waiting for a caller.

Deleted, together with the `DiamondTransaction` interface that existed only to
be its return type and that nothing imports.

---

## What was deliberately left alone

- **`vipPoints.monthly` and `vipPoints.activeStreak` are always 0.** Nothing
  writes them; they are initial state that reaches the screen. Real, and
  outside these four defects, so the unknown state covers only `current` and
  `lifetime`, the two figures the `vip_points` read actually owns.
- **`keysReadFrom` is not narrowed** - see defect 2.
- **No migration, no DDL, no database write, no server change.** The production
  reads in this work were read-only, to confirm defect 3 is latent.
