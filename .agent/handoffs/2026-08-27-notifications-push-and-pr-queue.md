# HANDOFF — notifications, push delivery, and the stranded PR queue

**Written** 2026-08-27 ~22:00 UTC. **Author** Cowork/Claude session.
**Everything below was measured, not assumed.** Where I did not verify something,
it says so explicitly. Do not trust a claim in here that does not carry evidence.

---

## 0. READ FIRST

- `AGENT-PLAYBOOK.md` (byte-identical in all seven repos), then this repo's
  `CLAUDE.md`. Non-negotiable: **claim your own worktree**, never work in
  `~/Documents/club-arena` directly, never rebase `main`, never `--no-verify`.
- Ship via worktree -> branch -> PR. Autopilot arms squash auto-merge and
  GitHub lands it on green. **You never merge by hand.**
- Commit author MUST be `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`
  or Vercel refuses to build the commit (World Hub CHECK 15).

### Environment facts you will otherwise waste an hour rediscovering

| Thing | Reality |
|---|---|
| Sandbox `git` | **Broken** in mounted worktrees - gitdir points outside the mount. Use the host shell. |
| GitHub MCP | **Bad credentials.** Do not retry it. Use `gh` on the host. |
| Host shell | `mcp__counselors__host_terminal`. Needs `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` or `node`/`gh`/`npx` are not found. |
| Long commands | The transport kills anything over ~150s. `nohup`/`setsid` do **not** survive. `screen -dmS name script.sh` **does**. |
| npm registry | 403 from the sandbox. `node_modules` is macOS-native - symlink `~/Documents/club-arena/node_modules` into your worktree, and `rm -f node_modules` before `git add`. |
| Engine SSH | `ssh -i ~/.ssh/hetzner_deploy root@5.161.252.33` (engine.smarter.poker). Works. |
| Open Claw SSH | IP from `security find-generic-password -a smarter-poker -s openclaw-server-ip -w`. Deploy with `bash scripts/deploy-openclaw.sh` in World Hub. Works. |
| Supabase | MCP `execute_sql` / `apply_migration`, project `kuklfnapbkmacvwxktbh`. Full prod access. |
| `gh pr checks` | 403s - the PAT cannot read check runs. Poll `gh pr view N --json state` instead. |

---

## 1. THE ONE THING TO DO NEXT

**Give Club Arena a VAPID push subscription path.**

Everything else in the notifications stack is now correct and blocked on this.

**Evidence (re-run these; they are the whole argument):**

```sql
-- 2 users on the entire platform have a push subscription.
select count(distinct user_id) from push_subscriptions;

-- Of the 552 people who got a seat-open alert in 7 days, exactly 1 could
-- ever receive a push.
with r as (select distinct user_id from notifications
           where type='waitlist_seat_open' and created_at > now() - interval '7 days'),
     s as (select distinct user_id from push_subscriptions)
select (select count(*) from r) as recipients,
       (select count(*) from r join s using (user_id)) as with_push;

-- Every push skip is the same reason.
select failure_reason, count(*) from push_outbox
where status='skipped' and created_at > now() - interval '7 days' group by 1;
-- -> no_subscription | 2432
```

**Why adoption is zero:** Club Arena is a Vite SPA. The World Hub's subscribe
prompt (`GlobalNotificationPrompt`, `PushSubscriptionSync`, `PushProvider`) is
mounted in `pages/_app.js`, which the CA SPA **never loads**. CA has no VAPID
client of its own - `git grep -l "pushManager.subscribe\|enablePush" -- src`
returns nothing in club-arena.

**What to build.** Port the subscribe flow into CA, reusing World Hub's
server side unchanged:

- `GET /api/push/vapid-public-key` - already live, same origin, no auth needed.
- The subscribe POST route - check the exact name before coding;
  `src/lib/push-client.js` in World Hub is the reference implementation
  (`enablePush()`, `disablePush()`, `hasLocalSubscription()`).
- CA already ships a service worker (`sw-bus.js`, stamped at build time).
  Confirm it handles `push` and `notificationclick` events before assuming a
  subscription will deliver anything - **I did not verify this.**
- Gate the prompt behind a real user gesture. iOS requires an installed PWA
  (`isIosStandalonePwa()` in push-client.js explains it).

**Definition of done:** a second real device appears in `push_subscriptions`,
and a seat offer produces a `push_outbox` row that reaches `status='sent'`
rather than `skipped/no_subscription`.

---

## 2. STATE OF THE NOTIFICATIONS STACK

### 2.1 What is already fixed and live

| Change | PR | Verified how |
|---|---|---|
| CA notifications page rendered natively instead of an iframe of the hub page | CA #1436 | Live chunk `NotificationsPage-DwjFCQA4-v6.js` fetched from smarter.poker contains `ca-notif__row` / `sp-notif-cache`, zero `iframe`. Prod served SHA `310f5e22`. |
| `AppLayout` header double-reservation removed at tablet+desktop; notifications full-bleed | CA #1436 | Same deploy. Header is `position: sticky` so it already occupies flow space. |
| Seat-open push repointed from dead OneSignal to `push_outbox` | CA #1497 | `docker exec club-arena-engine grep -rl push_outbox /app` -> `/app/dist/services/supabase/seats.js`. Hetzner deploy completed/success. |
| CA's OneSignal client relay made honest (warn once, return false) | CA #1499 | merged |
| Seat-open push previously silent when unconfigured - made loud | CA #1479 | merged (superseded by #1497, which removed the OneSignal path entirely) |

### 2.2 The three-layer failure, in full

**OneSignal was removed from this platform on 2026-08-19** and replaced by
self-hosted VAPID web push. `pages/api/notifications/send.js` states this in its
header and rejects OneSignal device ids outright. Three things never got the memo:

1. **The engine** (`server/src/services/supabase/seats.ts`) added a OneSignal
   POST on **2026-08-26 - a week after removal**. `ONESIGNAL_APP_ID` and
   `ONESIGNAL_REST_API_KEY` are unset in the running container
   (`printenv | grep -c` = 0 for both), and 48h of logs had zero OneSignal
   lines, so `if (osAppId && osKey && ...)` was false on every seat offer and
   the block was skipped in silence. **FIXED - #1497.**

2. **The CA edge relay** - `src/services/PushNotificationService.ts` invokes the
   `send-push-notification` Supabase edge function, which relays to
   `onesignal.com/api/v1/notifications`. **Eight call sites** believe they
   notify people and do not: CashoutService, CreditRequestService (x3),
   DisputeService (x2), SettlementService, TournamentAutoSeat (blinding-off).
   The failure is caught, logged at `console.debug`, returns false.
   **NOT fixed - issue #1498.** Made honest in #1499.

   > **DO NOT simply repoint the edge function at `push_outbox`.** It performs
   > **no authorisation on who may be notified** - it takes `userIds` from the
   > request body and pushes arbitrary title/message/url to them, and any
   > authenticated user can call it. It is inert today only because the vendor
   > is gone. Wiring it to a live transport re-opens exactly the hole World Hub
   > closed in `send.js` on 2026-07-25. Move those eight flows to server-side
   > `push_outbox` writes, then **delete** the edge function and the service.

3. **Subscription adoption is ~0** - section 1 above.

### 2.3 The consent situation (read before "fixing" it)

`send.js` enforces per-category opt-outs, but **17+ sites across both repos
insert into `notifications` directly and bypass it**:

```bash
git grep -n "from('notifications')" origin/main -- server src pages | grep -i insert
```

I considered a fail-open `BEFORE INSERT` trigger on `notifications` and
**decided against it for now**, because routing the engine through `push_outbox`
made consent structural for the path that mattered: `/api/cron/push-dispatch`
calls `loadGateContext` + `gateDecision` on **every** outbox row before
delivering (see `pages/api/cron/push-dispatch.js` ~line 244). Anything written
to `push_outbox` is opt-out-respecting by construction.

The in-app bell rows are still unguarded. If you build the trigger: **fail
open** - suppress only on an explicit `false`, never on a missing row, and
never let a gate error silence a user (`push-enqueue.js` `checkGate` is the
house pattern: it catches and defaults to allow).

**Missing piece:** there is no waitlist/seat category in `LEGACY_PREF_COLUMN`
(World Hub `src/lib/push/push-prefs.js`), so `event: 'waitlist_seat_open'`
currently default-allows. To make seat alerts user-controllable you need:
a column on `user_notification_preferences`, an entry in `LEGACY_PREF_COLUMN`,
an entry in `PUSH_CATEGORIES` (`pages/hub/notifications.js` **and**
`pages/hub/settings.js` - keep them in sync), and the Settings UI row.

### 2.4 Dan's decision, and why it is not yet executed

Dan chose **"push only, don't persist"** for seat-open notifications.

The data behind that choice is sound:

```sql
select count(*) total,
       count(*) filter (where read) ever_read,
       round(avg(extract(epoch from (now()-created_at))/3600)::numeric,1) avg_age_h
from notifications
where type='waitlist_seat_open' and created_at > now() - interval '7 days';
-- 2344 | 7 | 49.4
```

96% of all notification volume (2,344 of 2,440), read 0.3% of the time, average
age 49 hours, every one saying "Sit Down Now To Claim It" - false within a
minute.

**DO NOT execute it until section 1 is done.** With 1 of 552 recipients
subscribed, removing the in-app row switches seat alerts off for 551 people.
Sequence: build the subscribe path -> confirm real subscriptions and
`push_outbox` rows reaching `sent` -> then drop the `notifications` insert in
`notifyWaitlistSeatOpen` (`server/src/services/supabase/seats.ts`, the
`.from('notifications').insert(...)` above the outbox write).

### 2.5 Smaller notifications items, unstarted

- **No pagination.** Feed is `?limit=50`. With 96% seat-open, older real
  notifications are unreachable. Add filter tabs (All / Unread) and load-more.
- **Cross-device read sync.** `src/pages/NotificationsPage.tsx` subscribes to
  INSERT only. Read on phone, desktop still shows unread. The hub page also
  handles DELETE and `broadcastSync('smarter_poker_notif_sync')`; CA does not
  participate.
- **Badge vs list disagree.** `/api/notifications/mark-seen` zeroes the badge on
  mount while rows stay visibly unread.
- **Cache contract.** CA and the hub page share `sp-notif-cache` in
  localStorage, 5-min TTL, `_cache_ts` on element 0, max 30 rows. Both read and
  write it. Do not change the shape in one place only.

---

## 3. THE PR QUEUE AND THE GUARDS

### 3.1 What was wrong

On 2026-08-26 a swarm opened **455 PRs** in Club Arena (320 merged, 19 closed,
116 stranded). World Hub was unaffected - 0 open PRs, healthy all week. Of 122
open PRs, 114 conflicted with main, and ~97 were **already-shipped duplicates**:
all 26 files the dead-code PR wanted deleted were already deleted; #1181's
`safeToClearSeat` guard and #1154's `one_live_seat` migration were both live on
main while their PRs sat open claiming to add them. **Zero migrations from that
cohort were stranded** - the only 5 absent from main belonged to that day's
still-active PRs.

### 3.2 The guard I built - CA #1464, merged

`.github/scripts/close-superseded-prs.sh` + `.github/workflows/close-superseded-prs.yml`,
cron `17 */6 * * *`. Closes a conflicted PR whose diff adds nothing main does not
already contain, with the evidence in the comment.

**Refusals (17 tests pin these - `tests/unit/closeSupersededPrs.test.ts`):**
anything that merges cleanly; anything under `MIN_AGE_H` (24); drafts; labels
`do-not-merge`/`hold`/`wip`/`superseded-keep`; a PR carrying a migration main
lacks; a PR whose deletions or renames main has not applied. Never deletes the
branch.

**Dry-run result against the live queue: 25 of 118 would close, 93 kept.**
Deliberately conservative - the line filter strips only blanks and
punctuation-only lines, nothing else.

> **STATUS: it has not fired yet.** First scheduled run is the next `:17` on a
> 6-hourly boundary. **Watch the first live run.** Verify with:
> `gh run list --workflow=close-superseded-prs.yml --limit 3`
> and re-run manually in report-only mode first if you want the verdict list:
> `gh workflow run close-superseded-prs.yml -f dry_run=true -f min_age_h=24`

### 3.3 The bug class this exposed - fixed in all 7 repos

`gh pr list --json mergeStateStatus` **does not return a live value**. GitHub
computes mergeability lazily and asynchronously: a bulk listing returns
`UNKNOWN`, and even a direct `gh pr view` only *starts* the computation.

Two estate-shared guards branched on it:

- `agent-autopilot.yml` tested `$STATE = "DIRTY"` to decide **not** to refresh a
  conflicted branch. Measured: **100 of 100 open PRs took the "refreshing"
  path**, every one conflicted - `gh pr update-branch` called 100x per sweep on
  branches the API cannot fast-forward, ~4,800 doomed calls a day. The guard had
  never fired.
- `report-stuck-prs.sh` classified with a `case` ending `*) continue ;;`, so
  `UNKNOWN` **dropped the PR from the report entirely** - under-reporting
  exactly when nothing else had warmed the cache.

Fixed in CA #1465 (single ask) then CA #1471 (retry x3 with a pause, and refuse
to refresh while still unknown), propagated to all seven repos.
**Verified: all 7 now carry autopilot blob `b49e683f97`.**

> `.github/workflows/agent-autopilot.yml`, `.github/scripts/report-stuck-prs.sh`,
> `.github/scripts/queue-pr.sh`, `.github/scripts/check-token.sh`,
> `AGENT-PLAYBOOK.md` and several `scripts/*.sh` are in
> `estate-integrity.sh SHARED_FILES` and **must stay byte-identical across all
> seven repos**. Change one, change all seven in the same session, or
> estate-integrity raises a drift issue within the hour. Propagation recipe:
> `gh api -X PUT repos/Smarter-Poker/<R>/contents/<path>` with `-f branch=`,
> `-f sha=<current blob sha>`, `-f content=<base64>`, then `gh pr create`.
> The seven repos are listed in `.github/scripts/estate-integrity.sh`.

---

## 4. THE SOLVER WATCHDOG - retired, and the real problem is still open

`/cron/solver-watchdog` returned **HTTP 500 on 222 of its last 224 runs**, last
success 2026-08-18 02:12. Nine days, nothing alerted.

It never worked in its new home: it moved to `smarter-poker-workers` in Phase 2B
and its recording leg upserts `cron_health_log` - a table **no workers route has
ever successfully written to** (every one of the ~15 crons writing there is a
World Hub monolith route under `pages/api/cron/`). It fails hard on that write
by design, so it 500s hourly rather than lying. `solver_status` compounds it:
RLS enabled, **zero policies**.

**Retired** in World Hub #821: dispatcher entry commented out (not deleted) with
the exact restore conditions, `bash scripts/deploy-openclaw.sh` run, **86 jobs
registered, zero errors**, and verified - zero uncommented references on the VM,
nothing in `journalctl`, and `select max(started_at) ... '/cron/solver-watchdog'`
stayed at 18:20 while the 19:20 slot passed.

**THE STALL IT WATCHED IS REAL AND ONGOING - World Hub issue #820.**
6,633,013 v2 spots outstanding, no v2 solve since 2026-08-15 09:57, and the
backlog **grew** from 6,518,694 during the nine days the watchdog was down.
Not user-facing (`browse-solutions.js` falls back to `strategy_matrix`), which
is why it stayed invisible. The solver runs on LAN machines this codebase cannot
reach - someone has to look at the machines.

To restore monitoring: give the workers service a client that can write
`cron_health_log` (service_role bypasses RLS; the one policy there is
admin-only), add a policy to `solver_status`, re-add the dispatcher line,
redeploy Open Claw. **Do not re-add it before that.**

Also seen and **not** investigated: `/cron/ledger-reconcile` (money-critical)
failed once at 2026-08-27 08:00 with HTTP 500, 80/84 success overall.

---

## 5. THE BUG CLASS TO KEEP HUNTING

Every defect this session was the same shape: **something that looks wired,
reports success, and does nothing.**

1. A guard whose selector can never match (`mergeStateStatus == DIRTY`).
2. An exit code masked by a pipe (`merge-tree | grep CONFLICT` - my own first
   draft had this; read exit codes, never grep output).
3. A feature that no-ops when an env var is unset, silently (the OneSignal
   blocks).
4. An integration pointing at a decommissioned vendor.
5. A watcher sharing a failure domain with what it watches.
6. A report whose catch-all `continue` drops the rows that matter.

**Searches that paid off:**

```bash
git grep -nE "(gh |git |npx |node )[^|\n]*\|[[:space:]]*grep -q" -- .github scripts
git grep -n "continue-on-error: true" -- .github/workflows
git grep -lni "onesignal" -- src pages server supabase
git grep -ohn "import.meta.env.VITE_[A-Z0-9_]*" -- src
```

**Already cleared, do not redo:** World Hub has 23 OneSignal mentions and
**zero live calls** - its migration was clean. CA's three undefined Vite vars
(`VITE_GAME_SERVER_URL`, `VITE_MEDIA_BASE`, `VITE_RIVE_RIGS`) all have
documented fallbacks; the engine URL is present in the production bundle. The
two `continue-on-error` steps in World Hub's `supabase-invariants.yml` are
deliberate with a documented exit condition.

---

## 6. VERIFICATION STANDARD

`AGENT-PLAYBOOK.md` RULE 1 and RULE 8. Do not say "fixed" without:

```bash
npx tsc --noEmit                       # and in server/ too if you touched it
npx vitest run tests/                  # 458 files / ~7,300 tests, ~14s
NODE_ENV=production npm run build
```

Then prove it in production. For CA client code: the merged bundle syncs via
`build-for-world-hub.yml` to World Hub, then Vercel. Confirm
`curl -s https://smarter.poker/api/health | grep version` matches, and fetch the
actual asset and grep it. For engine code: `auto-deploy-hetzner.yml` fires on
`server/**`; confirm with
`ssh -i ~/.ssh/hetzner_deploy root@5.161.252.33 'docker exec club-arena-engine sh -c "grep -rl <marker> /app"'`.

**Never trust a green PR as proof the user's problem is solved.**

---

## 7. OPEN ITEMS, RANKED

1. **CA VAPID subscribe path** (section 1) - unblocks everything else.
2. **Watch the first `close-superseded-prs` run** (3.2) - it has never fired
   live. 122 PRs still open.
3. **Issue #1498** - move 8 CA flows to server-side `push_outbox`, then delete
   the unauthorised edge function and `PushNotificationService.ts`.
4. **Issue #820** - solver v2 stall, needs someone at the LAN machines.
5. Seat-open push-only cutover (2.4) - only after 1.
6. Notifications pagination / filters, cross-device read sync, badge-vs-list (2.5).
7. `waitlist_seat_open` preference category (2.3) so users can control 96% of
   their notifications.
8. `/cron/ledger-reconcile` single 500 (section 4).
9. Consent trigger on `notifications` (2.3) - only if you decide the in-app bell
   needs it; fail open.

**Do not** re-add the solver watchdog, re-point the edge function at a live
transport, or drop the seat-open in-app row, without reading the sections above.
Each looks like an obvious win and each is a trap.
