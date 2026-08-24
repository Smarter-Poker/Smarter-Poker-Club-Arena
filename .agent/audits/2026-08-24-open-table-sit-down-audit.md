# Open-Table Sit-Down Audit — 2026-08-24 ~04:25 UTC

Scope: Dan's report "sit at an open table must work like spins: click Sit,
confirm buy-in popup, funds withdrawn, game begins — none of this works."
Method: systematic-debugging (root cause before fixes). Every claim below was
verified against production Supabase, origin/main (9ec6a44bc), and the live
production bundle. Local Mac clone was 30+ commits behind origin during this
audit — several findings were fixed by other agent sessions mid-audit and are
labelled as such.

## The chain, link by link (live verification)

1. CLICK SIT -> CONFIRMATION POPUP
   - Broken until tonight. The deployed bundle (ca_sha 567b2ab4, built 18:42Z)
     charged the wallet ON THE RAW SEAT TAP with no confirmation sheet. The
     sheet exists in commit ca6b140b0 / PR #620 (merged origin 03:42Z), synced
     to World Hub 03:53-04:09Z. Production now serves ca_sha efe633d8f which
     contains it. STATUS: fixed by another session tonight; needs cache-safe
     verification in browser.

2. FUNDS WITHDRAWN
   - Works. Verified: user kingfish debited 25.00 (category tournament_buyin,
     related_entity 6f89aaa7 "PLO4 Heads-Up 25") at 03:58:13Z the moment
     fn_take_seat_and_buy_in granted seat 2. Horses debit through the same
     ledger. NOTE: the LIVE fn_take_seat_and_buy_in reserves the seat at
     stack 0 (chips credited at start); the repo copy
     (20260821d_seat_first_spins_and_heads_up.sql) still writes
     stack = starting_chips. Repo/DB drift — update the repo copy.

3. GAME BEGINS
   - Broken twice, differently:
   a) START STALL 03:40:38 -> 04:08Z. Every seat-first game that filled in
      that window sat REGISTERING fully paid: measured 23 spins at 3/3 paid
      seats and 15 heads-ups at 2/2, stuck 20-85 minutes; kingfish's HU was
      one of them. The window matches the engine deploy churn exactly (7+
      server/** merges 03:31-04:18Z, each one an auto-deploy restart;
      PR #618 "a restart was its own outage"). Backlog flipped to RUNNING
      04:08Z when a fixed build landed.
   b) STARTED BUT NEVER DEALS — OPEN P0 AT AUDIT TIME. 53 RUNNING seat-first
      games older than 10 minutes had dealt ZERO hands. Their stacks were
      credited (the pg_cron safety net credit-stalled-seat-first-stacks works:
      verified 300/300/300 and 1500/1500) but tables sit status='waiting'
      with no ServerTableEngine dealing. Platform-wide hand production was 0
      for the 3 minutes before this audit closed (last hand 04:22:10Z).
      Diagnosis requires Hetzner journalctl; the restart storm from
      continuous server merges is the prime suspect. UNTIL DEALING IS
      CONTINUOUS, EVERY SIT-DOWN STILL DEAD-ENDS AT AN IDLE TABLE.

## Open defects found (verified present on origin/main HEAD or live DB)

P0-1  Dealing outage / started games idle (3b above). Needs engine logs.
      Also: freeze the merge queue for server/** during peak, or batch
      deploys — seven engine restarts in 45 minutes IS the outage.

P1-2  Seat-first definition mismatch. GameServer start gate treats ANY
      variant='sng' as seat-first (starts only when paid seats >= max_players,
      GameServer.ts ~2262) while fn_take_seat_and_buy_in and
      isSeatFirstFormat only permit spin OR max_players <= 2. Any SNG with
      3+ seats is a structural deadlock: players cannot buy seats
      (not_a_seat_first_game), horses are registered without seats, and the
      start gate waits for seats forever. Latent today (board only carries
      2-seat SNGs) — a landmine for 6/9-seat SNGs.

P1-3  fn_seat_horse_in_seat_first_game (live DB) selects the OLDEST table:
      ORDER BY created_at LIMIT 1, with NO status filter — closed tables
      included. Every other component (paid-seat count, recycler-follow,
      fn_sync_seat_first_player_count) uses the NEWEST non-closed table.
      With a recycled table pair, horses seat on the corpse and the game
      cannot fill.

P2-4  TournamentRecurringService.topUpWithHorses stops on first refusal
      (`else break`, origin line ~2795). One horse rejected — e.g. by the new
      four-table trigger (ERRCODE 23514) — halts filling that game for the
      whole pass even when free horses remain. Use `continue`.

P2-5  Four-table hard trigger (applied 03:42:25Z) interacts with the horse
      pool: horses measured at 4 live seats can never take another; combined
      with P2-4 this slows or stalls seat-first fills. Horse picker should
      exclude horses at >= 4 live seats.

P2-6  GameServer discovery batch queries for paid seats discard their error
      objects. A failed query silently reads paidSeats=0 fleet-wide and no
      seat-first game starts, with zero telemetry. Log the errors.

P2-7  No watchdog for "fully paid but never started". The
      played-but-registering sweep requires eliminated/winner rows, which a
      never-dealt game cannot have — the 85-minute stuck heads-up proves the
      gap. Add a sweep: REGISTERING + paid seats = max_players for > N
      minutes -> alert or force-start.

## Process findings

- Both GitHub MCP servers in this Cowork session return Bad credentials —
  this session cannot push. This file was written to the working tree only;
  next agent with working credentials should commit it.
- Local Mac clones (club-arena, World Hub) were 30+ commits behind origin.
  club-arena working tree carries uncommitted edits (TablePage, LobbyTable,
  DynamicWallet, useSpinsWallet, walletCache + tests, engineStartBudget files)
  and two untracked migration files whose CONTENT is applied to prod under
  different version stamps (the_roster_agrees_with_the_seats 22:48Z). All of
  it is exposed to the antigravity reset loop.
- pg_cron jobs exist (credit-stalled-seat-first-stacks every minute,
  union-seat-provenance-heal every 5) despite WH CLAUDE.md 11.3 banning
  pg_cron. The stack-credit job is currently the only thing funding stalled
  seat-first stacks — do not remove it before the engine-side deferral is
  fixed; do reconcile the rule.
