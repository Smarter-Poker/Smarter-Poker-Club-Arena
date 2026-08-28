# HANDOFF — Club Arena: Dan's 2026-08-28 PKO bug report + platform payout repair

**Paste this whole file into a new agent chat as the opening prompt.**

You are picking up work on **Smarter Poker / Club Arena**. A previous agent
(session 2026-08-28, ~13:00–17:30 local) closed nine reported bugs and a
platform-wide payout defect. This document is the complete state of that work:
what was done, what was learned the hard way, and what is still open.

Read `AGENT-PLAYBOOK.md` and `CLAUDE.md` in `~/Documents/club-arena` at session
start. **This document does not replace them.** It records what those files do
not yet know.

---

## 0. THE ONE-PARAGRAPH VERSION

Dan reported 9 bugs from a live PKO tournament. Six needed code (all shipped
and merged: PRs #1652, #1658, #1660, #1681, #1682, #1683); three were already
fixed on `main` by other agents. One live tournament was deadlocked and was
recovered by migration. Separately, a sweep found **20,110.50 of prize money
that players had earned and never been paid** across 75 events — that has been
paid, and a bug in the reconciler itself was found and fixed in the process.
**One item is unfinished and is an ART task, not a code task** (see §5.1).

---

## 1. ENVIRONMENT — READ THIS BEFORE YOU TOUCH ANYTHING

These cost the previous agent real time. Do not rediscover them.

### 1.1 Git: the mounted repo cannot be written to

`~/Documents/club-arena` is a **shared clone** used by several agents at once,
and the sandbox mount **cannot `unlink`**. A git write command there strands a
`.git/index.lock` that then blocks git on Dan's Mac host too.

**Never run `git add` / `commit` / `push` / `checkout` against the mounted
worktree from a sandbox.**

**The working pattern that succeeds:**

```bash
# 1. token (never print it)
cd /sessions/<you>/mnt/club-arena
export GH_PAT=$(grep '^GITHUB_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')

# 2. fresh clone into sandbox-local /tmp (full permissions, no shared state)
git clone "https://x-access-token:${GH_PAT}@github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git" /tmp/ca
cd /tmp/ca && git remote set-url origin "https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git"

# 3. work, commit, push (see 1.2 and 1.3 for the two mandatory flags)
```

Always pipe output through `sed "s/${GH_PAT}/***/g"` so the token never lands
in a transcript.

### 1.2 The hooks refuse you, and `--no-verify` is the wrong answer

A pre-commit **and** a pre-push hook refuse to operate in what they detect as
the shared clone. Their own message names the sanctioned escape:

```bash
AGENT_SHARED_CLONE_OK=1 git commit ...
AGENT_SHARED_CLONE_OK=1 git push ...
```

Use that. **Do not use `--no-verify`** — it skips the other nine house rules
and the test suite, and every one of them exists because something was lost.

### 1.3 Commit author is load-bearing — Vercel BLOCKS a commit it cannot attribute

`build-safety-gate.yml` CHECK 15. A commit authored as anything else goes to
**BLOCKED** in Vercel with _no build logs at all_, so nothing else can see it.

```bash
git -c user.name="Smarter-Poker" \
    -c user.email="254329056+Smarter-Poker@users.noreply.github.com" commit ...
```

### 1.4 Credentials

- **GitHub PAT**: `~/Documents/club-arena/.env`, key `GITHUB_TOKEN`. Works.
- **The GitHub MCP server is broken** — returns `Bad credentials`. Do not waste
  time on it; use the PAT with git/HTTPS and the REST API directly.
- **SSH to GitHub from the sandbox fails** (`Host key verification failed`).
  HTTPS with the PAT works fine.
- **Supabase**: project `kuklfnapbkmacvwxktbh` (`PokerIQ-Production`). MCP works,
  including `apply_migration`.

### 1.5 The sandbox disk fills up and lies to you

~9.6G total. Two `node_modules` installs plus a clone plus test runs will hit
**ENOSPC**, and the symptom is _not_ an obvious disk error — it is a mass of
phantom failures:

> `Test Files 491 failed | 49 passed` with **`Tests 529 passed`, zero failing assertions**

Test _files_ failing with zero failing _assertions_ means the environment, not
your code. Run `df -h /`, clear `node_modules`/caches, re-run.

### 1.6 Timings, so you know what "normal" looks like

| Suite                                | Files | Tests  | Wall    |
| ------------------------------------ | ----- | ------ | ------- |
| Client `npx vitest run tests/`       | 546   | ~8,414 | ~75s    |
| Server `cd server && npx vitest run` | 209   | ~2,293 | ~55s    |
| `npx tsc --noEmit` (each side)       | —     | —      | ~30–60s |

`npm ci` works in the sandbox. Bash tool timeout caps at 600000ms — a full
client run plus a server run in one command **will** time out; split them.

### 1.7 You are not alone in this repo

Three to five agents ship here concurrently. Before writing any file:

```bash
# what is already in flight?
GET /repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls?state=open
```

`src/pages/TablePage.tsx` (~17.5k lines) is the hottest file on the platform.
The previous agent **deliberately declined** to fix bug 4c (equity placement)
because another agent had a `Dan 2026-08-28 equity smart placement` block
in flight there. Check first, then claim.

**`Agent Autopilot`** runs every ~10 min and enables squash auto-merge on open
PRs. Your PR will merge itself once checks are green. Do not merge by hand.

---

## 2. WHAT WAS SHIPPED — all merged to `main`, all green

| PR        | Bug | What it fixes                                              |
| --------- | --- | ---------------------------------------------------------- |
| **#1652** | 9   | MTT finishing-ladder deadlock                              |
| **#1658** | 4d  | Chips on the felt never abbreviated                        |
| **#1660** | 2   | All-in equity only moves after the street is seen          |
| **#1681** | 1   | A table the server moved you off no longer stays on screen |
| **#1682** | 8   | Heads-up announced without depending on one exact place    |
| **#1683** | 7a  | Final-table state survives a reconnect                     |

### 2.1 Bug 9 — the deadlock (#1652) — THE IMPORTANT ONE

`Union PKO Afternoon (PLO4)` `4f42d847` hung heads-up for over an hour: 39
entrants, places 2..38 handed out gapless and collision-free, place 39 never
used, one player at 0 chips left `status='playing'` forever. Blinds climbed
13→17, the table stopped dealing after the final hand, no champion, no payout.

**Two defects, and it takes both:**

1. **The ladder was seeded from a live `playing` count**
   (`TournamentManagerEliminations.ts`). That count excludes an entrant still
   in `registered` while `ensureLateRegSeated` catches up. The first bust was
   seeded at **38** with **39** players in, so every place after it was one too
   high. Undetectable — a uniformly-shifted ladder is gapless and
   collision-free — until the last busted player asks for a place and there is
   none. Now seeded from the count of players holding **no place yet**
   (`position IS NULL`), which is monotonic and includes `registered`.

2. **Exhaustion was a `break`.** It abandoned the player mid-sweep at 0 chips,
   still `playing` → `remainingCount` never reaches 1 → `finishTournament`
   unreachable, every 5 seconds, for the life of the process. Now the walk goes
   **up** to the lowest free place and reports a corrupt ladder, because
   stranding the whole field's money is strictly worse than one mislabelled place.

3. The taken-places read was unchecked (`takenRows || []` = "every place is
   free"). Unreadable is UNKNOWN now.

**Live proof it works:** 147 tournaments completed in the hours after deploy —
147/147 correct ladder length, 0 unplaced, 0 stuck.

### 2.2 Bug 1 — the "2 tables" (#1681)

**Not a reconnect duplicate.** The balancer moved the hero Table 1 → Table 2 at
17:30:21 (`left_at` 17:30:21.507, `joined_at` 17:30:21.777 — the **server did
it right**). But:

- `TABLE_SEATED` fired for Table 2 → second tab appeared;
- **nothing fires for the table you are moved OFF** (`TABLE_LEFT` is for a
  player-initiated leave) → Table 1's tab stayed;
- its `TablePage` stayed mounted, frozen on hand **#3299868** — a hand with
  **no `hand_history` row anywhere**, because it never completed for him.

Two tabs, both drawing the hero's last-delivered hole cards (`SeatSlot` keeps
those alive on purpose), one stopped on a hand that was never finished. Both
screenshots show the same `K Q 8 3` in both tabs — that is the tell.

Fixed in `MultiTablePage.tsx`: the seat rebuild now **prunes** (it only ever
added), and it re-runs on `WS_CONNECTED` (it only ran on mount). Pruning
preserves the watched table **by identity, not index** — a prune above
`activeIndex` would otherwise silently move the player, which §10.6 forbids.

### 2.3 Bug 8 — heads-up (#1682) — was bug 9 in a different hat

Trigger was `Number(elimData.position) === 3`. With the ladder one short, the
player who left two behind was stamped place **2** → never fired. The overlay,
the event and the emitter were all fine. Gate widened to `2..4` as a cheap
pre-filter with a one-shot guard; the **authority** is and always was the query
underneath (`status='playing'` count === 2).

### 2.4 Bug 7a — final-table background (#1683)

`TournamentManager.isFinalTable` is in-memory and the `final_table` broadcast is
**one-shot**. Anyone who reconnects never learns. The client's fallback was a
**regex on the table name** (`/\bfinal table\b/i`) — but production names it
`Union PKO Afternoon (PLO4) - Table 2`.

`tournaments.final_table_triggered` existed as a column and **nothing had ever
written it: 0 of 1,286 completed MTTs in 30 days.** The engine writes it now
(idempotent via `.eq('final_table_triggered', false)`); the client reads it.

### 2.5 Bugs 3, 4b, 4c, 5, 6 — already fixed on `main` by other agents

Verified against current `main`, not assumed:

- **3 / 4b** — the Stack/Hands/VPIP/Won bar is gone from the felt; the corner is
  a single Tournament Lobby button (#1654).
- **4c** — `.equity-overlay--above` is now the default for every seat; side
  docks only for top-cap seats where the BBJ banner owns the space.
- **5** — the countdown badge was deleted from the action pill (that was both
  the "overlay" and the "not centred" halves).
- **6** — the `+` renders the real `icon-addscreen` artwork with an SVG
  fallback (#1614).

---

## 3. MIGRATIONS APPLIED TO PRODUCTION

All three are in Supabase `kuklfnapbkmacvwxktbh`, applied via `apply_migration`.

### 3.1 `20260828_pko_4f42d847_renumber_ladder_and_rebalance`

Recovered the deadlocked tournament. Shifted places 2..38 → 3..39 (the truthful
order), repriced each place, reclaimed the 120.00 of one-tier overpay from the
eight horses who held it, and **left places 1 and 2 free so the ENGINE finished
the event through its own money path** — no prize was paid by hand.

Result: `COMPLETED`, kingfish 1st (180.00 + 122.50 bounties), bigslick mike 2nd
(120.00), 600.00 prizes against a 600.00 pool, 390.00 bounties against a 390.00
pool, 0 unplaced, 0 seats open.

> **TRAP:** `trg_tournament_place_collision` fires **per row**, so a set-based
> `position = position + 1` collides on its own intermediate state. The shift
> must be a **descending loop** (worst place first) so each destination is
> vacant when claimed.

### 3.2 `20260828_reconcile_counts_a_debit_as_a_debit`

`fn_tournament_payout_reconcile` answered "what has this player been paid" with
`SUM(wt.amount) WHERE category='prize'` and **never looked at `wt.type`**. Every
corrective debit counted as another payment. It fails both ways:

- **invents overpayments** — it reported 7 on `4f42d847`, whose ledger balances
  to the cent, and files each issue list as a **`critical` financial_alert**;
- **masks real shortfalls** (the dangerous, silent one) — a debit inflates
  `already_paid`, so a player still owed money looks paid and the top-up this
  function exists to make is never made.

Now signed off `type`, not off the sign of `amount`, because **both conventions
exist in the table**: the 2026-08-28 reprice wrote POSITIVE amounts with
`type='debit'`; the 2026-08-15 reversal wrote a NEGATIVE one. `-abs(amount)` on
debit is right for both.

### 3.3 `20260828_resolve_reconciled_payout_alerts`

Re-asked every open `fn_tournament_payout_reconcile` alert and closed only the
ones that now come back `clean`. **206 closed, 64 left open** (see §5.2).

---

## 4. THE MONEY — 20,110.50 PAID

|                                                   |                      |
| ------------------------------------------------- | -------------------- |
| Top-up payments                                   | 337 across 75 events |
| Distinct players paid                             | 223                  |
| Range                                             | $0.74 – $500.00      |
| **Owed across all 36,704 completed events (30d)** | **0.00**             |

**Root cause:** the older "finished on a failed count" defect left places
unpaid, then a backfill assigned ranks with `prize = 0`. Signature: pools paying
**exactly the 1st-place percentage** (750/2500, 300/1000 = 30%) with everyone
else's `eliminated_at` sharing one identical backfill timestamp weeks after the
event ended. One event (`Morning Grinder (PLO)`) had never paid its **winner**.

Paid via `fn_tournament_payout_reconcile(id, true)` — the sanctioned,
idempotent mechanism (key `tourney:{id}:prize:{user}:{place}:reconcile`), always
after a dry run with `p_apply => false`.

> **TRAP:** do **not** trust `fn_tournament_payout_sweep` for a full sweep. It
> filters on `t.updated_at`, and **`tournaments.updated_at` is never maintained
> by the engine** (frozen at row creation). Its `LIMIT` also truncates silently.
> Iterate candidate ids yourself and call `fn_tournament_payout_reconcile`
> directly.

---

## 5. WHAT IS STILL OPEN

### 5.1 Bug 7b — the final-table felt is visually broken **(ART TASK, NOT CODE)**

**This is the only reported bug still unfixed.** Diagnosed conclusively; not
fixed because the fix is new artwork and improvising that procedurally into
production was judged the wrong call.

`src/assets/tables/skin_final_table.png` is **the only one of the 14 skins that
paints seat positions into the rail** — gold plates plus amber jewels.

- Geometry is **correct**: 605×1000 RGBA, identical to all 13 others (verified
  by reading PNG headers; `.table-art` uses `object-fit: fill`, so a wrong
  aspect _would_ stretch — it does not).
- But the painted positions **do not match the app's 9-max seat ring**
  (`SEAT_POSITIONS_9MAX` in `src/lib/tableSeatGeometry.ts`). Overlaying the ring
  on the asset shows seats 4 and 7 straddling the top edge of the side plates,
  and painted jewels where no seat exists.
- Every seat button therefore lands on a plate edge or a jewel — exactly Dan's
  _"broken and distorted around the table where the seat buttons are"_.
- Not a regression; authored that way in #1431.

**Recommended fix:** redraw `skin_final_table.png` as a plain premium rail
(keep the blue neon + gold trim identity, drop the per-seat plates and jewels),
letting the app draw the seats as it does on every other skin. **Get Dan's
sign-off on the look before shipping.** Reproduce the evidence with:

```python
# overlay SEAT_POSITIONS_9MAX on the skin at 605x1000
seats=[(50,100),(10.5,82.5),(8,58),(8,25),(27,6),(73,6),(92,25),(92,58),(89.5,82.5)]
```

### 5.2 64 open payout alerts — need a human decision

| Issue                  | Places | Amount     | Why it is still open                                                                                                                                   |
| ---------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `overpaid`             | 60     | **862.92** | `fn_tournament_payout_reconcile` **deliberately never claws back automatically**. Needs Dan's call, same as the 120.00 decision he made on `4f42d847`. |
| `no_finisher_recorded` | 4      | **56.50**  | The place is owed to nobody identifiable. Genuinely needs a human.                                                                                     |

### 5.3 Satellites were never reconciled

`fn_tournament_payout_reconcile` **skips satellites by design** ("satellites
award seats, not cash"). **10 satellites completed in the last 30 days and have
never been checked.** An earlier crude query suggested ~**2,568.50 of apparent
overpayment** across 9 of them. That number came from comparing `prize_pool` to
`SUM(prize)`, which is the wrong comparison for a seat-award event — so **treat
it as unverified**. Someone needs to work out what "correct" even means for a
satellite and write the equivalent check.

### 5.4 `final_table_triggered` — shipped but not yet proven live

Still **0 rows ever set**. The Hetzner deploy of #1683 succeeded, and an engine
restart resets the in-memory flag so a running final table re-enters the branch
— but no MTT reached a final table in the window observed. **16 tournaments are
live now.** First thing to check:

```sql
select count(*) from tournaments where final_table_triggered;  -- expect > 0
```

If it is still 0 after an MTT has demonstrably reached one table, investigate
`Tournament.final_table_flag_write_failed` in the error reporter.

### 5.5 PR #1648 should be closed

It is a **`git stash` pair**, not authored work — `On main: wip snapshot ...` /
`index on main: 2365bceb77`, two parents, ~65 files and ~5,700 insertions of
several agents' uncommitted WIP based on a main that has since moved 70+
commits. The 6 client TS errors reported against it come from that WIP, not
from any of the six shipped PRs. A comment explaining this is already on it.

### 5.6 Worth auditing / optimising (not yet started)

- **`isProcessingEliminations` has no watchdog.** A single hung `await` in the
  5s elimination sweep leaves the flag `true` for the life of the process and
  silently disables eliminations for that tournament forever. There is no
  timeout and no alert. Not the cause of this incident, but the same class.
- **`tournaments.updated_at` is dead.** Nothing maintains it, and at least one
  production function (`fn_tournament_payout_sweep`) filters on it and is
  therefore quietly wrong. Either maintain it with a trigger or move that
  function to `ended_at`.
- **Prize-place semantics are duplicated** between `payoutMath.ts` /
  `payoutStructure.ts` (engine) and `fn_tournament_payout_reconcile` (SQL). They
  have already diverged once. Consider a single source of truth or a
  cross-checking test.
- **The seat-ring geometry is un-tested against the skin assets.** Nothing
  catches an asset whose painted furniture disagrees with `SEAT_LAYOUTS` —
  which is precisely §5.1. A guard test asserting "no skin paints seat
  positions" would have caught it at authoring time.
- **`fn_tournament_payout_reconcile` writes a `critical` alert on every issue
  list and nothing ever closes them.** §3.3 closed 206 by hand. It needs a
  self-closing mechanism or the alert table becomes noise again.

---

## 6. DIAGNOSTIC QUERIES THAT EARNED THEIR KEEP

```sql
-- Is any tournament deadlocked right now? (bug 9's signature) — expect 0
select count(*) from tournament_players tp join tournaments t on t.id=tp.tournament_id
where t.status in ('RUNNING','COMPLETING') and tp.status='playing' and coalesce(tp.chips,0)<=0;

-- Ladder health on recently completed events — expect max_pos = entrants, 0 unplaced
select count(*) filter (where max_pos = entrants) as correct, count(*) as total from (
  select t.id, count(*) entrants, max(tp.position) max_pos
  from tournaments t join tournament_players tp on tp.tournament_id=t.id
  where t.status='COMPLETED' and t.ended_at > now()-interval '1 day'
  group by t.id) a;

-- Money owed across every completed event — expect 0.00
with cand as (select id from tournaments where status='COMPLETED'
  and started_at > now()-interval '30 days' and coalesce(prize_pool,0)>0
  and coalesce(variant,'')<>'satellite')
select round(coalesce(sum((fn_tournament_payout_reconcile(id,false)->>'total_top_up')::numeric),0),2)
from cand;

-- Duplicate seats: multi-tabling is LEGAL, so the signature is same-table
-- or same-TOURNAMENT, never merely ">1 open seat". Expect 0 / 0.
with s as (select ts.user_id, ts.table_id, tb.tournament_id from table_seats ts
           join tables tb on tb.id=ts.table_id where ts.left_at is null)
select (select count(*) from (select user_id,table_id from s group by 1,2 having count(*)>1) a) as same_table,
       (select count(*) from (select user_id,tournament_id from s where tournament_id is not null
                              group by 1,2 having count(*)>1) b) as same_tournament;
```

---

## 7. THINGS THE PREVIOUS AGENT GOT WRONG — so you do not repeat them

1. **Reported "19 players holding 21 duplicate seats" as a bug. It was normal
   multi-tabling.** A player may legitimately sit at up to 4 tables
   (`MAX_TABLES`). The real signature is same-**table** or same-**tournament**
   duplicates — both were, and are, **0**.
2. **First cut of `formatTableChips` floored everything ≥ 1**, which turned a
   typed `13.37` raise into `"13"` and broke `actionpanel-bet-granularity`.
   Abbreviating and truncating are _both_ "rounded or shortened".
3. **Wrote a set-based `position + 1` update** and had it rejected by
   `trg_tournament_place_collision` (see §3.1). The migration failed atomically
   and nothing was applied — verified before retrying.
4. **Assumed the reconciler's overpayment report was real.** It was the
   reconciler's own bug (§3.2). Verify a money finding against
   `club_members.chip_balance` and the ledger before acting on it.

---

## 8. HOUSE RULES THAT BIT, IN PRIORITY ORDER

- **HORSES ARE PLAYERS** (`CLAUDE.md` §10.5). Every fix and every repayment
  above applied to horses on identical terms. Never filter `is_horse` to deny.
- **NEVER AUTO-CHANGE TABLES** (§10.6). #1681 preserves the watched table by
  identity precisely because of this.
- **ANIMATIONS MUST ALWAYS PLAY** (§10.6). #1660 adds a _delay_, never a skip.
- **NEVER PUSH A RED TEST** (§5.8). If you replace behaviour a test pins,
  update that test **in the same commit** — #1652 did this for
  `tournamentWinnerExit`'s guard.
- **Popups**: Title Case, **no em dashes**, always through the Toast layer.
- **No emoji in source.** Breaks the SWC compiler.
- **Never spend real chips to test** (§11.5). Probe money paths in a
  transaction you roll back; use `p_apply => false` dry runs.

---

## 9. YOUR FIRST FIVE MINUTES

```bash
# 1. what is in flight from other agents
#    GET /repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls?state=open

# 2. is production healthy (run the four queries in §6) — all should be 0 / clean

# 3. get a clean tree (§1.1) and confirm the six PRs are on main:
git log --oneline -60 | grep -E '#1652|#1658|#1660|#1681|#1682|#1683'

# 4. pick up §5.1 (art, needs Dan) or §5.2/§5.3 (money, needs Dan's decision)
#    or §5.6 (audit work, no decision needed — start with the
#    isProcessingEliminations watchdog, it is the same class as bug 9)
```

**Ask Dan before:** any clawback (§5.2), any change to the final-table artwork
(§5.1), and anything that moves money you cannot dry-run first.
