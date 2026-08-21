# Handoff — BBJ popup, whole-number buy-ins, no raw server errors

**Date:** 2026-08-20
**Base commit:** `a107f7eff95a1f6740588add63ecbfd8a8a6704f` ("feat(ca): spin quick-join")
**Patch:** `.agent/handoffs/2026-08-20-bbj-popup-buyins-errors.patch` (68 files, +3525 / -778)

`origin/main` moved five times while this was being assembled, and the host picked
up four of the session's files from the working tree and pushed them itself
(`ClubHomePage.tsx`, `TournamentRankingCard.tsx`, `server/src/config/buyIn.ts`,
`TournamentRecurringService.ts`) — those are already on main and are correctly
absent from the patch. The patch is rebuilt against `a107f7ef` and applies with a
three-way merge, so a little more drift is fine.

## Why this is a handoff and not a push

I could not push. Both routes are closed from this session:

- **VM git push** — the workspace has HTTPS to github.com but **no SSH key and no
  credential helper**; `ssh -T git@github.com` returns `Permission denied (publickey)`.
  Separately, the mounted working copy cannot `unlink`, so any index-locking git
  command (`status`, `add`, `commit`) strands a `.git/index.lock` that then blocks
  git on the Mac host. Every stray lock created during this session was moved into
  `_to_delete/` — **check that folder and delete it when convenient.**
- **GitHub MCP** — the token behaves exactly like an anonymous client on this repo:
  `create_branch`, `get_file_contents` and `list_commits` all return
  `404 Not Found` for `Smarter-Poker/Smarter-Poker-Club-Arena` and for
  `Smarter-Poker-World-Hub`, while the **public** `Smarter-Poker-Diamond-Arena`
  returns 200. `search_repositories user:Smarter-Poker` lists 15 repos, all public,
  neither private repo among them. Unauthenticated `curl` reproduces the same
  pattern. **The MCP token is missing private-repo scope (or the App installation
  does not cover these two repositories).** Worth fixing — it closes the only
  self-service publish route this repo has.

## The one thing to run

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
bash .agent/handoffs/apply-and-push-2026-08-20.sh
```

That script fetches, checks out `origin/main` cleanly, applies the patch with a
three-way merge, re-runs the gates, commits with the correct author, and pushes.
It refuses to push if any gate fails.

If you would rather do it by hand:

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
git fetch origin
git checkout -B ship-bbj-popup origin/main
git apply -3 .agent/handoffs/2026-08-20-bbj-popup-buyins-errors.patch
npx tsc --noEmit && node scripts/ci/check-ui-text.mjs && npx vite build
git add -A
git -c user.name="Smarter-Poker" \
    -c user.email="254329056+Smarter-Poker@users.noreply.github.com" \
    commit -m "feat(ca): BBJ popup rebuilt, whole-number tournament buy-ins, no raw server errors in popups"
git push origin ship-bbj-popup:main
```

**Author matters.** World Hub CHECK 15 / RULE 3: a commit Vercel cannot attribute to
a GitHub user goes to BLOCKED with no build logs. Commits must be authored
`Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`.

## What is in it

### 1. Bad Beat Jackpot popup — Winner / Basic / Qualifying Hands

Tapping the BBJ in the **club lobby** or **at a table** opens one popup with three
pages, matching the reference screenshots.

- **Winner** — the pool total in the header, then the last 5 winners as rows:
  avatar, name, player number, the hand, the payout, the timestamp.
  **Tapping a winner opens HAND DETAIL**: street by street with position badges,
  action chips, amounts and a running pot; blind posts reconstructed; showdown
  with hole cards, board, made hand and each player's net; then who was paid what
  out of the jackpot.
- **Basic** — the qualifying conditions in a sentence, then one row per stakes tier
  with the BBJ **fee** and the payout split (bad beat / winner / table / total).
  Every figure is derived from `RAKE_SCHEDULE` and `getBBJPayoutPercentForBB`, so
  the table cannot drift from what the engine charges and pays. Where the fee and
  payout ladders disagree on boundaries the fee prints as a range rather than
  silently picking one.
- **Qualifying Hands** — the minimum losing hand for every game we spread, drawn as
  real cards. Ranks come from `BBJ_QUALIFYING_HANDS`. PLO6 and Short Deck render as
  "not available" rather than being hidden, so a player of those games learns why
  there is no banner.

**Bug fixed along the way:** tapping the BBJ in the lobby called
`navigate('/clubs/:id/bbj')`, so `showBBJInfo` had no way to ever become true and
the popup was unreachable from the lobby entirely.

**Three honesty notes baked into HAND DETAIL**, because `hand_history` does not
store these and inventing them would be fiction:

1. Only the post-settlement stack is stored, so the right-hand column is the
   **running pot**, labelled as such — not a stack curve.
2. Blind posts go into the pot but never into the action log, so the two `post`
   rows are synthesised from `small_blind` / `big_blind` and the derived blind
   seats. Without them the running pot is short by exactly the blinds.
3. Mucked hole cards are deliberately never persisted, so a player who did not
   show gets no cards, never a guess.

### 2. Server side — already applied to production

Applied via Supabase MCP `apply_migration` as `bbj_winner_hand_detail`; the file is
in the patch as `supabase/migrations/20260820_bbj_winner_hand_detail.sql` with a
ROLLBACK section.

- `fn_bbj_recent_hits` gained `bad_beat_user_id`, `bad_beat_player_number`,
  `bad_beat_avatar_url`, `small_blind`, `big_blind`. Return type changed, so it was
  dropped and recreated (Tier 3).
- **New** `fn_bbj_hand_detail(payout_id)` returns the whole hand behind a hit.
  It has to be `SECURITY DEFINER`: `hand_history` RLS only lets a player read hands
  they were dealt into, and a public jackpot board must be readable by everyone.
  The exposure is deliberately narrow — it is keyed by a `bbj_payouts` id, so the
  only reachable hands are hands that actually hit the jackpot, and it returns only
  the hole cards `hand_history` already stores (showdown-revealed). `anon` has no
  execute; asserted in the migration.

Both verified against real production rows before the client was written.

### 3. Whole-number buy-ins for SNG and every tournament

The earlier pass fixed the two generators but never touched `fn_create_tournament`,
the only path a club owner's browser creates a tournament through. It read `buyIn`
as the prize half and added 10% **on top**, so a 15 / 25 / 75 buy-in produced a
16.50 / 27.50 / 82.50 total — non-integer, which the new DB CHECK **refused**.
Tournament creation was broken at those prices.

- `fn_create_tournament` rewritten: `buyIn` is the whole-number **total**,
  fee = `round(total * 0.1)` cut out of it, prize = the remainder. Non-integer
  buy-in or bounty is **refused**, not silently rounded. Applied to production.
- `splitBuyIn` (client and server) rounds the fee and takes the prize as the
  remainder, so both parts are integers and sum exactly to the total.
- Every creation input is `step={1} min={1} inputMode="numeric"` with a
  digits-only change handler, plus an `isWholeBuyIn` backstop at submit.
- Display: buy-in, fee, rebuy, add-on and bounty render whole everywhere
  (lobby cards, details, register button, table modals, spins).
- `getTournamentFeeRatio` was `fee / prize_half`, reporting 11.1% instead of 10%.
- Register/unregister toasts and `notifyWalletChange` reported only the prize half
  while the server debited prize + fee.

**Left decimal on purpose:** cash-game blinds and stakes; prize payouts (a
percentage of a whole pool is legitimately fractional — 33% of 180 is 59.4);
~9.8k historical tournament rows, which are settled financial history and are
rounded at render only, never rewritten.

**Note the price change:** a tournament created at "20" now costs the player 20,
not 22. That is the intended reading of "the buy-in is the number you type", but
it is a ~9% price drop on every newly created game — flag it if that is not what
you meant.

### 4. Raw server errors never reach a player

New `src/utils/safeErrorMessage.ts` — an **allowlist**, not a blocklist. Text is
assumed unsafe and reaches a player only if it proves it is plain English: 4-160
chars, 2-26 words, restricted character set, and clear of ~20 technical-marker
patterns (camelCase identifiers, UUIDs, `PGRST*`, SQLSTATE, stack frames, source
filenames, `violates`, `cannot read propert…`, `[object Object]`, and plumbing
nouns like supabase / postgres / rpc / jwt / constraint / relation). Nine known
failure shapes get a specific friendly line instead: funds, duplicate, rate limit,
permission, session, timeout, network, not-found, server.

**It is wired into the Toast provider's error path**, so all ~200
`toast.error(e?.message || …)` call sites became safe without editing any of them,
and no caller can bypass it. `BusToastBridge` goes through the same door.
`InAppAlerts` (a second, hand-rolled popup layer) sanitizes too, and a codemod
fixed 70 inline error banners that rendered `err.message` straight into JSX.
The **real** error still goes to Sentry via `reportError`, deduped at 30s per
distinct original so a retry loop cannot spam it. Under `import.meta.env.DEV`
the sanitizer passes text through untouched.

| Player used to see                                                      | Player now sees                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `PGRST116`                                                              | We Could Not Find That. Please Refresh And Try Again.         |
| `duplicate key value violates unique constraint "clubs_name_lower_idx"` | That Already Exists. Please Try Something Different.          |
| `TypeError: Failed to fetch`                                            | Connection Problem. Please Check Your Internet And Try Again. |
| `JWT expired`                                                           | Your Session Expired. Please Sign In Again.                   |
| `new row violates row-level security policy for table "table_seats"`    | You Do Not Have Permission To Do That.                        |
| `Cannot read properties of undefined (reading 'chips')`                 | Something Went Wrong. Please Try Again.                       |
| `Table is full. Please pick another seat.`                              | unchanged — it passes the allowlist                           |

### 5. Upstream em dashes that were failing CI on main

`scripts/ci/check-ui-text.mjs` was **red on main** — three files used an em dash as
an empty-value placeholder: `TournamentRankingCard.tsx` (already pushed by the host),
`RealTimeResultPanel.tsx` (6 occurrences) and `GameRulesModal.tsx` (2). All changed
to a plain hyphen; the last two via the gate's own `--fix`. The gate now passes.

Worth knowing: this keeps recurring because `'—'` is the natural thing to type for
"no value". If it keeps landing, a lint rule on the character in `.tsx` would end it
permanently.

## Verification

All of it on a clean checkout of `origin/main` with only this patch applied:

- `npx tsc --noEmit` — exits 0
- `npx vite build` (production) — succeeds, 2239 modules
- `node scripts/ci/check-ui-text.mjs` — OK, no em dashes
- `npx vitest run tests/unit tests/utils tests/components tests/hooks tests/config`
  — **11 failures, an identical set to the 11 that already fail on unpatched
  `origin/main`.** Zero regressions, run side by side against a pristine baseline
  checkout. (Those 11 are pre-existing: club-level examples, preset-avatar counts,
  and one order-dependent CashierClubSwitcher test that passes in isolation on both
  trees.)
- Both new RPCs executed against production rows and their JSON inspected.
- No emoji added on any changed line. No `.single()` in any changed file.

Two tests were updated because they pinned the **old** behaviour, not because they
broke:

- `tests/rebuy-addon-quote-the-real-price.test.tsx` expected `you need 110.00`;
  whole chips render `110`. The assertion's point (the line must name the TOTAL the
  server charges, not the base) is unchanged, and it now also asserts no `110.00`
  is rendered anywhere.
- `tests/unit/TournamentFromTableConfig.test.ts` expected a `3.3` fee on a 33
  buy-in. It now pins the rule instead: fee and buy-in are integers across a range
  of buy-ins, and the buy-in comes back as the number that was typed.

## Not done

- **`MIGRATION-CHANGELOG.md` was not updated.** The working copy was 29 commits
  behind and mid-divergence, and editing a doc everyone appends to would have
  guaranteed a conflict. Add an entry when this lands.
- The working copy at `~/Documents/Smarter-Poker-Club-Arena` still holds other
  agents' uncommitted work (a `CashierTradePage`, lobby quick-preference rows, a
  double-board engine flag). **None of it is in this patch** — the patch was rebuilt
  file by file on current `origin/main` and everything not belonging to this session
  was reverted. That other work still needs its own owner.
