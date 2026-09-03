# 2026-08-26 — table/engine audit, and what is actually blocking the queue

## Shipped (7 PRs)

- **#1277** a dropped socket must not buy time, and must not spend a time bank.
  Supersedes #1009, which reset the turn clock to a fresh 30s — a repeatable
  stall exploit. The real defect was narrower: an offline player's use-it-or-
  lose-it time bank was auto-activated and spent on a decision they could not
  make. Also removed `DisconnectProtectionService` + `ConnectionHUD` (never
  initialised, always rendered null), the server `AutoRebuyService` (a `return;`
  in a permanent 30s interval), an orphan settings panel promising "5D per
  activation" that debited nothing, a third settings store with no consumers,
  a localStorage key collision that silently reset the settings page on every
  tab return, and an Auto Top Up that had been dead on every decimal-stakes
  table because a regex on a _display string_ captured `"0"`.
- **#1283** two ways a seat exit lost chips (a stranded legacy-key branch; an
  unscoped `left_at` write that vacated every seat a player held while
  crediting one), and a manual time bank that could freeze a hand because
  `performAction` returns false rather than throwing.
- **#1315** deleted `ensureHorseWallet` — zero call sites and a bare INSERT into
  the frozen `public.wallets` pool, i.e. a dead function containing a live mint.
  Plus a dropped async rejection and a popup bypassing the house Title Case rule.
- **#1318** an ARMED-but-unspent time bank was never released, so it was
  redeemed on a later turn the player never armed it for. Time-bank uses are
  purchasable, so this quietly consumed something people pay for.
- **#1331 / #1355** the C/W hotkey computed check-legality against state absent
  from its dependency array, and was correct only because an unrelated
  re-subscribe fired on every engine snapshot — so memoising those handlers,
  the obvious performance fix, would have started routing intended CHECKS into
  CALLS. Also an optimistic-rollback closure that captured its undo state inside
  an impure `setTableState` updater, and the last duplicated legality derivation.
- **#1009** closed as superseded.

Server suite 1778 → 1904 tests. Every PR gated on client tsc + server tsc + the
full server suite before it was allowed to commit.

## Deliberately NOT changed

- **The insurance/RIT window does not pause the time bank.** The only available
  API is use-it-or-lose-it, so "fixing" it would charge a player a bank use
  because an insurance offer happened. The expiry callback already returns early
  when the seat is not current. Documented, not converted into a new way to
  spend someone's money.
- **`autoPostBlinds`** — still a toggle with no consumer, but `server/src/types.ts`
  carries the field with no logic behind it. Wire-vs-remove is a product call.
- **Publishing `availableActions` in the snapshot.** The engine computes the
  authoritative legal-action set and never broadcasts it; the client re-derives
  it. This session cut that from six independent derivations to one helper plus
  one site (`TablePage.tsx:15256`, the JSX feeding ActionPanel). That last one
  belongs in the PR that switches the panel over — with real gameplay testing,
  because it decides which buttons a player may press for money.

## Queue anatomy — the finding that changes priorities

119 open PRs, 108 conflicting, 117 of them opened in a single day. 323 commits
landed on `main` in 24 hours. 302 remote branches, 182 with no open PR.

A local three-way merge of every conflicting head against `main` ranked what
actually collides:

| conflicts | file                                              |
| --------- | ------------------------------------------------- |
| **18**    | **MIGRATION-CHANGELOG.md**                        |
| 16        | src/pages/ClubHomePage.tsx                        |
| 9         | src/pages/TablePage.tsx                           |
| 7         | server/src/services/TournamentRecurringService.ts |
| 7         | server/src/GameServer.ts                          |
| 7         | scripts/agent-workspace.sh                        |
| 5         | AGENT-PLAYBOOK.md                                 |

TablePage is only **third**. The largest single conflict generator in the
repository is a documentation file nothing executes, because every agent was
instructed to append to the same last line of it. That is what this PR fixes.

Also worth noting: `scripts/ci/supabase-schema-manifest.json` and
`supabase-columns-manifest.json` appear 8 and 6 times. They are generated
artifacts that are committed, so every schema change regenerates them and every
concurrent schema change collides. Generating them in CI instead of committing
them would remove another ~14 conflicts. Not done here because it touches the
CI gate.

## Patterns worth carrying forward

1. **Features that render as a switch and do nothing.** Six removed this
   session — offline protection was a sessionStorage flag and a toast.
2. **Code that is correct only because of a side effect somewhere else.** The
   more dangerous kind: it looks fine, tests fine, and breaks the moment
   somebody improves it. The C/W hotkey was exactly this.
3. **Comments go stale faster than code.** Three findings existed only because a
   comment described behaviour that had changed underneath it, and one actively
   asserted a clock drift could not happen when it demonstrably does. A
   confidently wrong comment costs more than a missing one — it stops the next
   person looking.
