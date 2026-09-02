# HANDOFF — Tournament Money Integrity + the Horses-Are-Players Law

**From:** Cowork/Claude session, 2026-08-27
**Repo:** `club-arena` (engine + SQL). One doc change also landed in `Smarter-Poker-World-Hub`.
**Status of my work: COMPLETE AND SHIPPED.** Nothing is half-applied, nothing is
uncommitted, no migration exists that has not run in production. Read
"STATE OF THE WORLD" before touching anything.

---

## 0. READ THESE FIRST, IN THIS ORDER

1. `AGENT-PLAYBOOK.md` (worktree, commit, PR, stop)
2. `CLAUDE.md` **section 10.5 — HORSES ARE PLAYERS (BINDING)**. This is a hard
   law Dan set on 2026-08-27. It is the single most important thing in this
   handoff. If you write a filter that leaves horses out of anything a human
   gets, you are writing a bug.
3. `.agent/audits/2026-08-26-tournament-rake-deep-audit.md`
4. `.agent/audits/2026-08-27-tournament-rake-pass2-attribution.md`
5. `.agent/audits/2026-08-27-tournament-money-conservation-phase3.md`
6. `.agent/audits/2026-08-27-phase3bc-sentinel-denoise-and-backpay-starvation.md`

---

## 1. STATE OF THE WORLD (verified in production, 2026-08-27 22:00 UTC)

| Measure                     | Value                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Heads-Up winners repaid     | **9,359 → 229,805.25 chips** (drain COMPLETE)                                      |
| HU events still owing       | **13** — all "no identifiable winner", alerted for a human, NOT payable by machine |
| Tournament rake settlements | **31,344**, with **0** terminal events unsettled                                   |
| Guarantee overlays funded   | **32**, from club treasuries                                                       |
| Horse VIP attribution rows  | **977** (was 0 — I had wrongly excluded horses)                                    |
| Open money alerts           | **8** (1 conservation finding, 1 per-club overlay, 6 no-winner HU)                 |

Migrations applied to prod (all self-asserting, all committed):
`20260826_tournament_rake_settlement_integrity`,
`20260827_tournament_rake_attribution_and_creation_caps`,
`20260827_guarantee_overlay_funding_and_conservation`,
`20260827_conservation_sentinel_denoise_and_selfresolve`,
`20260827_hu_backpay_head_of_line_fix`,
`20260827_horses_are_players_law`,
`guarantee_overlay_alert_dedupes_per_club`.

Merged PRs: CA #1381, #1402, #1418, #1433, #1438, #1446, #1451, #1459, #1495,
#1502. WH #809, #812.

---

## 2. THE LAW YOU MUST NOT BREAK

Dan, verbatim, twice:

> "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING! THEY MUST ALWAYS BE
> TREATED LIKE REAL LIVE PLAYERS!"

> "TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER
> NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING
> FOR THE CLUB ARENA. YES IT STILL NEEDS TO THE SAME 5 SECOND PAUSE TO REBUY.
> NOT EVERY HORSE ALWAYS REBUYS IN THE CASH GAMES, AND IF YOU DIDN'T GIVE THEM
> THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE WOULD NOTICE!"

The test is **"is it identical"**, not "is it equivalent". **Timing is part of
the treatment** — a table that pauses for one seat and not another announces
which seats are horses. There is NO "equal outcome by a different mechanism"
exemption; I proposed one and Dan rejected it.

Legitimate `is_horse` use is ONLY: (a) identification as data (badges, admin
columns), and (b) the horse's input device — HorseLogic choosing actions,
`scheduleHorseAction` submitting them **inside the same turn timer a human
gets**, the synthetic heartbeat, `autoRebuyHorse` funding. Any
`p_include_horses`-style parameter MUST default to including them.

**The ONE sanctioned asymmetry**, decided by Dan with costs on the table:
horse-only `hand_history` is pruned after 7 days while human hands are kept
forever. It is a STORAGE decision (~0.5 GB/day, ~15 GB/month to equalise), the
knob is a config row (`hand_history_retention_policy.horse_retention_days`),
and it is **Dan's to change, not yours. Do not "fix" it.**

---

## 3. OPEN WORK — pick up here

### A. 13 Heads-Up events owe ~589 chips and cannot be auto-paid

`fn_backpay_hu_winner_shortfalls` refuses them because they have no single
identifiable winner (0 or 2+ rows with `status='winner' OR position=1`). They
are alerted in `financial_alerts` (source `fn_backpay_hu_winner_shortfalls`).
**This needs a human/product decision on who gets paid — do not guess.** Ask
Dan before moving money. Query them with:

```sql
select t.id, t.name, public.fn_tournament_conservation_delta(t.id) as owed
from tournaments t where t.status='COMPLETED' and coalesce(t.variant,'')='sng'
  and coalesce(t.max_players,0)<=2 and coalesce(t.guaranteed_prize,0)=0
  and t.ended_at between '2026-08-01' and '2026-08-28'
  and public.fn_tournament_conservation_delta(t.id) > 0.01;
```

### B. One genuine conservation finding still open

`financial_alerts` source `fn_tournament_money_conservation`, 1 unresolved row.
Every other flagged event was explained (freerolls are club-funded, pre-fix
pool inflation is accounted). This one is real and unexplained. Start there.

### C. Club treasury negative from guarantee overlays — WATCH, don't panic

One club (Midway Union) sits negative. This is **cash-flow timing**, not
insolvency: guarantees are funded daily from club treasury, union rake returns
to clubs at the **weekly 90% rakeback close**. Measured: 4,841 chips of overlay
vs 9,888 chips of rake in the same 24h. **Escalate only if a negative survives
a weekly close** — that condition is written into the alert's own context.

### D. Silent default worth fixing (small, safe)

`TournamentManagerEliminations.ts` ~line 530: if `payout_structure` JSON fails
to parse it silently sets `payouts = []`, which makes `payoutCount = 0` and
**disables hand-for-hand bubble protection with no log and no alert**. Bounded
consequence, but it is the "failed read reads as empty" pattern this codebase
has been burned by repeatedly. Report the parse failure instead of defaulting.

---

## 4. TRAPS THAT COST ME REAL TIME — DO NOT REPEAT

1. **A migration assertion that greps its own comment.** Twice I wrote
   `IF pg_get_functiondef(...) LIKE '%<banned pattern>%' THEN RAISE` and the
   _explanatory comment_ containing that pattern tripped it. Assert on the
   executable form, or word the comment so it cannot match.
2. **Prettier rewrites your code on commit.** A guard test pinning
   `async drainHands(maxWaitMs = 8000)` passed locally and failed in CI because
   prettier wrapped the signature across three lines. Assert the CONTRACT, not
   whitespace. (CLAUDE.md §11 warns about this; I walked into it anyway.)
3. **"It ran once" is not "it runs".** My HU back-pay ran at boot and never
   again, because I gated it on a 60-second window opened by a _different_
   sweep's timer. Give periodic jobs **their own clock**, and verify with **two
   independent passes at different times with no restart between them**.
4. **A self-draining repair needs a second measurement.** My back-pay starved
   silently — 95 of every 100 selected rows owed nothing, never got a credit,
   and permanently blocked an oldest-first queue. Every pass reported success.
   Only _repaid vs remaining_ caught it. Always filter the debt in the QUERY.
5. **Deploys coalesce.** `auto-deploy-hetzner` skips a restart if the engine is
   <20 min old. A 14–19 second run shipped NOTHING. Check run duration, and
   verify engine changes via a DB-visible behavioural change — never
   `/health` (CDN-cached).
6. **The GitHub MCP is dead** (`Bad credentials`). Use `gh` on the host via
   `mcp__counselors__host_terminal` with
   `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"`. WH pushes take
   > 2 min through the pre-push hooks — run them with `nohup ... &` and poll.

---

## 5. HOW TO SHIP (this estate, exactly)

```bash
cd ~/Documents/club-arena
git worktree add -B fix/<slug> ~/Documents/.agent-trees/club-arena/<name> origin/main
cd ~/Documents/.agent-trees/club-arena/<name>
ln -sfn ~/Documents/club-arena/node_modules node_modules
ln -sfn ~/Documents/club-arena/server/node_modules server/node_modules
# work, then:
cd server && npx tsc --noEmit && cd .. && npx tsc --noEmit
npx vitest run tests/unit/<your tests>
git add -A && git -c user.name=Smarter-Poker \
  -c user.email=254329056+Smarter-Poker@users.noreply.github.com commit -m "..."
git push -u origin HEAD && gh pr create --fill
# STOP. Autopilot squash-merges when checks are green. You never merge.
```

SQL goes to prod via the **Supabase MCP `apply_migration`** (never
`execute_sql` for DDL), AND the identical file is committed under
`supabase/migrations/`. If CI says "A MIGRATION IN THIS BRANCH DECLARES
SOMETHING THE LIVE SCHEMA DOES NOT HAVE", regenerate
`scripts/ci/supabase-schema-manifest.json` in the same PR.

**Never spend real chips to test a money path** (CLAUDE.md §11.5). Probe inside
a transaction you ROLL BACK; what you want is the error message.

---

## 6. VERIFY BEFORE YOU CLAIM ANYTHING

Do not say "fixed" or "deployed" without output. For money work the only proof
is a DB-visible change: rows credited, backlog shrinking across two separate
reads, `rake_unsettled = 0`, alerts closing. `/health` is cache-frozen and
proves nothing.
