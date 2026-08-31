# HANDOFF — Club Arena agent credit + promotion lifecycle programme

**Written:** 2026-08-31, ~12:35 UTC
**Author:** Cowork Claude (agent identity `Smarter-Poker`)
**Status:** Phase 1 of 7 complete and pushed; Phase 2 of 7 not started; **Phase 2 draft migration was LOST — see §15.1**

---

## 1. Executive Continuation Brief

### What is being built

Club Arena is a Vite + React 19 + TypeScript poker SPA that ships inside the
smarter.poker Next.js app. It has clubs, unions, an agent hierarchy, a chip
economy with several wallets, a server-authoritative poker engine on Hetzner,
and Supabase (Postgres) for data, auth and realtime.

This programme is a **seven-phase repair of the player promotion system and the
agent credit economy that hangs off it**, commissioned by Dan across six
instructions in one session.

### The business objective

When a club promotes a player to co-owner, admin, super agent, agent or sub
agent, the promotion must:

1. grant the access that role is supposed to carry;
2. assign the **rakeback / commission percentages** at the moment of promotion;
3. assign **prepaid or a credit line, and how much**;
4. track and make **payable** the balances that follow;
5. and chips must flow **main bank → agent wallet → agents and players**.

### Current phase

**Phase 1 of 7 is complete, applied to production, and pushed.** PR **#2155**.
Phase 2 of 7 has not been started, and the migration I had drafted for it no
longer exists on disk (§15.1).

### Major work completed

- **Pre-programme (PR #2132, MERGED 2026-08-31 11:32 UTC):** the promotion audit
  — `co_owner` made real across 24 DB functions and 18 RLS policies, the
  promotion made to collect rakeback rates, staff barred from earning rakeback,
  and nine client wiring defects fixed.
- **Phase 1 (PR #2155, OPEN):** the credit invoice generator was billing the
  **unused portion** of a credit line as if it were debt — 224 invoices,
  18,047,771 chips, against an estate-wide `credit_used` of `0.00`. Fixed,
  voided, and five consequential client defects fixed with it.

### The immediate unfinished objective

**Phase 2: make the credit line real.** Undo my own staff agent-wallet block,
have the promotion assign prepaid-or-credit and the amount, make
`fn_agent_wallet_send` draw against the line, and have the claim-back repay it.

### The most important thing to understand

> **`agents.credit_used` is `0.00` for every agent on the platform and always
> has been. The credit line has never been drawable.** Phase 1 fixed the
> _biller_ first, deliberately, so that when Phase 2 makes credit actually move,
> the invoice raised against it is already correct.

### First action

Go to §22. It is an executable checklist.

---

## 2. User Requirements And Working Preferences

### Dan's instructions this session, verbatim

1. > "YOU NEED TO DO A DEEP DIVE AND AUDIT OF THE PLAYER PROMOTION SYSTEM, WHERE YOU 'PROMOTE' A PLAYER TO CO OWNER, ADMIN, SUPER AGENT, AGENT OR SUB AGENT. AUDIT THE CLUB LEVEL ACCESS THAT CAN BE GRANTED AND IS GRANTED FOR EACH ROLE, MAKE SURE THAT 'RAKE BACK PERCENTAGES' ARE ASSIGNED WHEN CREATING THEM (CO-OWNERS AND ADMINS GET NO RAKE BACK) AND CHECK EVERYTHING FOR CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE."

2. > "WHEN A AGENT IS PROMOTED TO A PLAYER, THEY ALSO NEED TO BE ASSIGNED 'PRE PAID' OR CREDIT LINE, (AND IF SO, THEN HOW MUCH) AND BALANCES BE TRACKED AND PAYABLE ACCORDINGLY... OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS, THAT WAS A MISTAKE. CHIPS MUST FLOW FROM THE MAIN BANK TO THE AGENT WALLET TO SEND OUT TO AGENTS AND PLAYERS."

   **Interpretation applied** (next agent must know this, and may re-put it to
   Dan): the phrase "WHEN A AGENT IS PROMOTED TO A PLAYER" was read as _when a
   player is promoted to an agent_ — prepaid/credit-limit are properties of
   `agents`, and the sentence sits in the same breath as the rakeback
   requirement, which is collected at promotion. **UNVERIFIED with Dan.**

3. > "NOW TAKE EVERY SINGLE THING YOU JUST SAID NEEDED TO BE DONE AND BREAK THIS DOWN INTO PHASES AND LET ME KNOW IN THE SUMMARY PHASE 1 OF X IS DONE, WITH THE SUMMARY, FOLLOWED BY READY TO START PHASE 2 OF X. GO AHEAD AND FULLY BUILD ALL OF THESE ONE PHASE AT A TIME, AND MAKE SURE THEY ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING SUCCESS. YOU DECIDE THE BUILD ORDER."

4. > "MAKE SURE EVERYTHING FROM THE PREVIOUS PHASE WAS 100% COMPLETED, FINISHED EVERY STEP AND IT WAS PUSHED AND PUBLISHED, CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE AND FIX ANY ISSUES BEFORE MOVING ONTO PHASE 2 OF 7"

### Reporting format Dan requires — NON-NEGOTIABLE

```
PHASE N OF 7 IS DONE
<summary of what changed and how it was verified>
READY TO START PHASE N+1 OF 7
```

### Working rules that bind every agent (`CLAUDE.md` §10)

1. One step at a time. Finish and verify before the next.
2. Do it right, not fast. No band-aids.
3. However long it takes. Scope honestly.
4. Verify on real hardware. "It compiles" is not verification.
5. **No emoji in code. Never call AI players "bots" — they are horses.**
6. **Mobile-first. 375px first, then scale up.**
7. Never ask permission for obvious work. Just do it.
8. When corrected, change course immediately. Do not defend the rejected path.
9. Write it down in your OWN changelog file: `docs/changelog/YYYY-MM-DD-<slug>.md`.
   **Never append to `MIGRATION-CHANGELOG.md`** — frozen history, and the single
   biggest source of merge conflict in the repo.

### Locked laws

| Law                                       | Where             | Effect here                                                                                                            |
| ----------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **HORSES ARE PLAYERS**                    | `CLAUDE.md` §10.5 | Never use `is_horse` to exclude a horse from a payout, stat, rule or report. Any `p_include_horses` defaults **true**. |
| **ANIMATIONS MUST ALWAYS PLAY**           | §10.6             | Untouched; do not weaken a pin in `tests/animations-always-play.law.test.ts`.                                          |
| **NEVER AUTO-CHANGE TABLES**              | §10.6             | Untouched.                                                                                                             |
| **POPUPS**                                | §5.7              | Toasts are Title Case; **em dashes forbidden**.                                                                        |
| **NEVER PUSH A RED TEST**                 | §5.8              | A red test stops the World Hub sync for everyone.                                                                      |
| **NEVER SPEND REAL CHIPS TO TEST A RULE** | §11.5             | **Every money probe runs in a transaction that is ROLLED BACK.** Both phases complied.                                 |
| **Never rebase `main` locally**           | §12               | Use `scripts/git-unstick.sh`.                                                                                          |

### Style Dan has corrected agents on

- Title Case in user-facing copy (`check-title-case.mjs`). **Its `--fix`
  capitalises "Co" to "CO"** — write "This Role Earns No Rakeback", not
  "Co Owners And Admins…".
- No em dashes in UI text (`check-ui-text`).

### Explicitly rejected by Dan

- **Blocking owners and co-owners from holding agent wallets.** Dan: _"OWNERS AND
  CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS, THAT WAS A MISTAKE."_ My error in
  PR #2132, **still live in production** — §16 D-01.
- **"Equal outcome by a different mechanism"** as a defence for treating horses
  differently (§10.5).

### Open decision Dan has NOT answered

> **Should re-promoting a previously demoted agent inherit their old commission
> and credit line, or be forced to choose fresh?** I said I would default to
> **forcing a fresh choice**. No reply. See §19 B-01.

---

## 3. Project And Repository Identity

```text
Project Name:            Club Arena (Smarter Poker)
Repository Root:         /Users/smarter.poker/Documents/.agent-trees/club-arena/claude-compliance   [CONFIRMED git rev-parse --show-toplevel]
Canonical Clone:         /Users/smarter.poker/Documents/club-arena                                   [CONFIRMED git rev-parse --git-common-dir]
Current Working Dir:     /Users/smarter.poker/Documents/.agent-trees/club-arena/claude-compliance   [CONFIRMED pwd]
Git Repository:          git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git                   [CONFIRMED git remote -v]
Current Branch:          agent/cowork-claude-roles/credit-and-lifecycle                              [CONFIRMED]
Remote Names:            origin (fetch + push, SSH)                                                  [CONFIRMED]
Primary Framework:       Vite + React 19 + TypeScript, React Router v7                               [CONFIRMED CLAUDE.md §8]
Package Manager:         npm                                                                         [CONFIRMED]
Runtime:                 Node via nvm (host node 26.3.0 observed)                                     [CONFIRMED]
Database:                Supabase Postgres, project ref kuklfnapbkmacvwxktbh                          [CONFIRMED — migrations applied]
Hosting:                 Vercel project `hub-vanguard`, published via the World Hub repo             [CONFIRMED CLAUDE.md §1.2]
Engine:                  Hetzner VPS, server/src, auto-deploys on push to server/**                   [CONFIRMED CLAUDE.md §11]
External Services:       GitHub Actions (CI + Autopilot), Sentry, Vercel                              [CONFIRMED]
```

**This is a git worktree, not a clone.** Never work in the canonical clone
directly (`AGENT-PLAYBOOK.md` §1b).

---

## 4. Repository Map

Only paths relevant to continuation (~5,500 tracked files in total).

```
claude-compliance/                     ← YOUR WORKTREE
├── AGENT-PLAYBOOK.md                  READ FIRST. Byte-identical in all 7 repos.
├── CLAUDE.md                          Repo law. §5, §10, §10.5, §10.6, §11.5, §12.
├── .agents/rules/
│   ├── 00-anti-regression-workflow.md
│   └── 01-mandatory-verification-pass.md
├── .agent/                            audits, architecture, workflows
├── docs/
│   ├── HANDOFF_CURRENT_STATE.md       ← THIS FILE
│   └── changelog/
│       ├── 2026-08-31-promotion-system-audit.md                  (PR #2132, merged)
│       └── 2026-08-31-phase1-invoice-bills-what-was-borrowed.md  (PR #2155)
├── src/
│   ├── types/clubRoles.ts             ★ THE seven-role definition. Mirror of the DB.
│   ├── services/
│   │   ├── CreditService.ts           ★ MODIFIED Ph1. InvoiceStatus, OWED_INVOICE_STATUSES,
│   │   │                                mapInvoice, checkSuspension, reinstateAgent.
│   │   ├── MembershipService.ts       ★ MODIFIED Ph0. updateRole → RPC.
│   │   ├── ChipFlowService.ts         ⚠ Ph3 TARGET. clubToAgent/clubToPlayer/agentToPlayer
│   │   │                                are peer-to-peer player-wallet moves. WRONG ACCOUNTS.
│   │   ├── FinancialCronService.ts    Calls fn_generate_all_credit_invoices (:223)
│   │   │                                and checkSuspension→suspendAgent (:261,:266).
│   │   ├── AgentService.ts            fn_create_agent / fn_admin_update_agent callers.
│   │   ├── CommissionService.ts       fn_admin_update_agent caller.
│   │   ├── ClubMessagingPermissions.ts ★ MODIFIED Ph0 (role mapping).
│   │   └── FinancialExportService.ts  Exports credit_invoices (:335).
│   ├── components/
│   │   ├── agent/
│   │   │   ├── AgentInvoicesPanel.tsx ★ MODIFIED Ph1. Rendered by AgentPortalPage:493.
│   │   │   └── ChipTransferModal.tsx  ⚠ Ph3 TARGET. Rendered by AgentManagementPage:1473.
│   │   ├── admin/ClubMemberManagement.tsx  ★ MODIFIED Ph0.
│   │   ├── club/RoleBadge.tsx         Canonical role colour + label, all seven.
│   │   └── wallet/walletRows.ts       CLUB_BANK_ROLES = owner, co_owner, admin, super_agent.
│   ├── pages/
│   │   ├── MemberManagementPage.tsx   ★ THE PROMOTE SCREEN. RoleSection ~line 655+.
│   │   │                                Ph2 adds prepaid/credit fields here.
│   │   ├── MemberManagementPage.css   ★ MODIFIED Ph0 (.mm-roles__rates).
│   │   ├── AgentPortalPage.tsx        Renders AgentInvoicesPanel.
│   │   ├── AgentManagementPage.tsx    Renders ChipTransferModal; create-agent flow.
│   │   ├── CashierPage.tsx            CORRECT money path reference (fn_agent_wallet_send).
│   │   └── ClubDetailPage / ClubsPage / ClubHomePage / ClubSettingsPage /
│   │       ClubFinancialsPage / AgentDashboardPage.tsx   ★ ALL MODIFIED Ph0 (co_owner parity).
│   ├── hooks/index.ts                 ★ MODIFIED Ph0 (useClubMembership booleans).
│   └── components/wallet/WalletCashierModal.tsx  CORRECT money path reference.
├── server/src/handlers/admin.ts       ★ MODIFIED Ph0. The engine's ONLY club-role gate.
├── scripts/ci/
│   ├── check-migrations-applied.mjs   CHECK 17. Failed Ph1; see §15.2.
│   ├── supabase-schema-manifest.json  { tables[], functions[] }
│   ├── supabase-columns-manifest.json ★ MODIFIED Ph1. { columns: { table: [cols] } }
│   ├── check-phantom-columns.mjs
│   ├── check-required-columns.mjs
│   └── check-title-case.mjs           --fix turns "Co" into "CO". Beware.
├── supabase/migrations/               ~1,006 files
│   ├── 20260822_club_roles_rpcs.sql                             Original role RPCs + guard fn
│   ├── 20260831235996_co_owner_counts_as_club_staff.sql         (Ph0, merged)
│   ├── 20260831235997_promotion_assigns_rakeback_and_staff_earn_none.sql (Ph0, merged)
│   └── 20260901000001_an_invoice_bills_what_was_borrowed.sql    ★ Ph1, applied + pushed
└── tests/
    ├── promotion-assigns-the-rate.law.test.ts         (Ph0, 27 pins)
    ├── an-invoice-bills-what-was-borrowed.law.test.ts (Ph1, 22 pins)
    ├── unit/clubRoles.test.ts                         Mirror-vs-DB grant matrix
    ├── cashier-ui-role-scoping.test.ts                ⚠ PINS the correct money path
    ├── shipped-invariants.test.ts                     Pins RPC names incl. these
    └── unit/lobbyUnionCreateControls.test.ts          ★ MODIFIED Ph0 (pin moved)
```

**★ = modified by this programme. ⚠ = a later phase must change it.**

### `20260831235998` is TAKEN

Another agent's `20260831235998_stats_v2_reads_bounded_rollup.sql` landed on
`main` via _Daily update (#2150)_. **The next free filename is
`20260901000002_`.** `20260901000001` is mine.

---

## 5. Applicable Instructions And Constraints

| File                                                                  | Scope                          | Must know                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT-PLAYBOOK.md`                                                   | All 7 repos                    | RULE 1 verification pass (paste command output); claim your own worktree; branch → push → PR → **stop**; never `--no-verify`; never `gh pr merge --admin`; `gh` is sanctioned, the GitHub MCP is not |
| `CLAUDE.md`                                                           | This repo                      | §1 deploy path; §5 code safety; §10 working rules; §10.5 horses; §10.6 animations; §11.5 money probes roll back; §12 never rebase main                                                               |
| `.agents/rules/01-mandatory-verification-pass.md`                     | This repo                      | The A–E structure used in §14                                                                                                                                                                        |
| `.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md` | This repo                      | **Wins over `CLAUDE.md` where they conflict. NOT re-read this session.** `UNVERIFIED`                                                                                                                |
| `MIGRATION-LAW.md`, `MASTER-MIGRATION-DOCUMENT.md`                    | Server-authoritative migration | Not touched by this programme                                                                                                                                                                        |

### Known conflicts in the instructions

- `CLAUDE.md` §1.1.5 is titled "prepared, not yet active"; §1.2.5 says it **is**
  active, verified against the live API. **§1.2.5 is correct.**
- `.husky/pre-push` check 0 claims rulesets are disabled. **Stale — they are
  active.**

### GateGuard (ECC hook) — operational note

`pre:edit-write:gateguard-fact-force` blocks the **first** Write/Edit to each new
path per session until you state, in the same turn: importers, affected symbols,
data fields, and the user's verbatim instruction. Restating and retrying the
identical call succeeds. It cost roughly 20 extra tool calls this session. It is
not a repo guard; do not disable it casually.

---

## 6. Complete Discovery Record

### 6.1 The seven club roles

`src/types/clubRoles.ts` is the client definition; it mirrors
`fn_club_grantable_roles` in Postgres, which is the rule.

| Role        | `ROLE_RANK` (client) | `fn_club_role_rank` (DB) | `fn_role_rank` (DB, after Ph0) |
| ----------- | -------------------- | ------------------------ | ------------------------------ |
| owner       | 100                  | 100                      | 7                              |
| co_owner    | 90                   | 90                       | 6                              |
| admin       | 80                   | 80                       | 5                              |
| super_agent | 60                   | 60                       | 4                              |
| agent       | 40                   | 40                       | 3                              |
| sub_agent   | 20                   | 20                       | 2                              |
| player      | 0                    | 0                        | 1                              |

**Two rank functions exist on different scales** — `fn_club_role_rank` (0–100,
used by `fn_club_set_member_role`) and `fn_role_rank` (0–7, used by
`fn_has_club_role`). Only ordering matters; both are now correct. Debt, not bug.

Grant matrix (`fn_club_grantable_roles`, authoritative):

- Nobody edits their own title (`actor = target` → `{}`).
- `owner` is never grantable here, and an `owner` target is never demotable here.
- **owner / platform admin** → co_owner, admin, super_agent, agent, sub_agent, player.
- **co_owner / admin** → admin and below, never at or above their own rank.
- **super_agent** → agent or player, **only inside their downline**.
- **agent** → sub_agent or player, **only inside their downline**.
- sub_agent and player grant nothing.

### 6.2 Role write path — locked

`club_members.role` may only change through **`fn_club_set_member_role`**.
`trg_club_members_role_guard` (BEFORE UPDATE, FOR EACH ROW, no WHEN clause)
calls `fn_club_members_role_guard()`, which raises `42501` unless
`app.club_role_change = 'on'` — set only by that RPC — or `current_user` is
`postgres` / `supabase_admin` / `service_role`.

**Consequence:** any SECURITY DEFINER function owned by `postgres` is exempt by
design. That is how `fn_create_agent` and `fn_admin_update_agent` wrote roles
behind the matrix's back; Phase 0 routed both through the RPC.

> **I initially reported this trigger as "never armed" and nearly shipped a
> false headline.** A truncated `string_agg` in my own inspection query hid it.
> **List triggers one row per trigger, never as an aggregate.**

### 6.3 Chip pools — five, measured 2026-08-31 ~12:30 UTC

| Pool           | Column                                      | Chips          |
| -------------- | ------------------------------------------- | -------------- |
| Member wallets | `club_members.chip_balance`                 | 160,946,929.21 |
| On the felt    | `table_seats.stack` where `left_at IS NULL` | 4,022,217.28   |
| Agent wallets  | `agents.agent_wallet_balance`               | 6,726,000.0000 |
| Club banks     | `clubs.chip_treasury`                       | 2,428,399.18   |
| Promo wallets  | `agents.promo_wallet_balance`               | 0.0000         |

`fn_club_chip_circulation()` counts **only the first two** — blind to 9.15M
chips. `reconcile_ledger_nightly` never looks at `credit_used`.
`public.wallets` is a **dead pool**, frozen since 2026-08-21 with
732,591,994.33 chips stranded; nothing reads it (`CLAUDE.md` §11.5).

### 6.4 Money paths — there are FOUR, one correct

**CORRECT (the Cashier) — already implements Dan's rule:**

- `fn_club_bank_send(club, to_user, amount, destination, reason, op_id)`
  - Caller must be `owner|co_owner|admin|super_agent`.
  - `destination ∈ {agent_wallet, promo_wallet, player_wallet}`.
  - Debits `clubs.chip_treasury`; credits `agents.agent_wallet_balance` (via
    `fn_ensure_agent_row`) or `club_members.chip_balance`.
  - Recipient of an agent/promo send must be
    `owner|co_owner|admin|super_agent|agent|sub_agent` —
    _"Only Staff Or Agents Hold An Agent Wallet"_. **Staff already qualify.**
  - Idempotent on `op_id`; 7-day reversal; writes `chip_transactions`.
- `fn_agent_wallet_send` → `..._phase2_core_20260831` → `..._core_20260830`
  - Spends **only** the caller's `agents.agent_wallet_balance`.
  - Forces `destination = agent_wallet` when the recipient is staff or an agent.
  - Downline check via `fn_club_cashier_can_transact`.
  - 10-minute clawback; `fn_agent_wallet_claim_back` returns chips to the
    sender's agent wallet.
- Already on this path: `CashierPage.tsx`, `WalletCashierModal.tsx`, the Trade
  grid (`fn_cashier_batch_transfer`).

**WRONG (Phase 3 target):**

- `ChipTransferModal.tsx` → `ChipFlowService.clubToAgent / clubToPlayer /
agentToPlayer` → `atomic_chip_transfer`. All three move chips peer-to-peer
  between two users' **player** wallets. `clubToAgent` debits the _owner's
  personal_ wallet, not `clubs.chip_treasury`. No idempotency key, no downline
  check, no ledger row. `CashierPage.tsx:1430-1455` documents this exact bug —
  the Cashier was fixed, the modal was left behind.

**DEAD:**

- `transfer_chips_agent_to_player(agent, player, club, amount)` — **zero
  callers**, debits `club_members.chip_balance` (pre-cashier model), and is the
  **only place the correct credit-drawdown logic exists.** Phase 2 ports its
  rule; Phase 3 or 7 drops the function.

**Dan's binding rule, 2026-08-25** (quoted inside `CashierPage.tsx`):

> "Any chips sent or claimed back transact from the Agent Wallet."

### 6.5 Agent economics

`public.agents` — one row per (club, user). It is **both** the commission
profile **and the agent wallet**.

| Column                                      | Meaning                         | Constraint                                        |
| ------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| `role`                                      | super_agent / agent / sub_agent | CHECK: those three only                           |
| `status`                                    | active / suspended / frozen     |                                                   |
| `commission_rate`                           | numeric fraction                | CHECK 0 ≤ x ≤ 0.70                                |
| `player_rakeback_rate`                      | numeric fraction                | CHECK 0 ≤ x ≤ 0.50                                |
| `credit_limit`, `credit_used`               | the line and the debt           | CHECK `credit_used <= credit_limit OR is_prepaid` |
| `is_prepaid`                                | prepaid vs credit               | default **false**                                 |
| `agent_wallet_balance` / `business_balance` | THE wallet (duplicated)         | synced by `trg_sync_agent_wallets`                |
| `player_wallet_balance` / `player_balance`  | duplicated                      | same trigger                                      |
| `promo_wallet_balance` / `promo_balance`    | duplicated                      | same trigger                                      |
| `pending_commission`                        | accrued, **never paid out**     | 26,859.87 estate-wide                             |
| `parent_agent_id`                           | the agent tree                  | FK → agents.id                                    |

Triggers on `agents`: `guard_agent_wallet_direct_update` (blocks
authenticated/anon writes to money columns), `trg_agents_commission_bounds`
(union policy band on `commission_rate`), `trg_sync_agent_wallets`,
`trg_agents_staff_earn_no_rakeback` (Ph0).

**Rakeback resolution** — `fn_player_rakeback_rate(user, club, volume)`:

1. the player's own deal, `club_members.player_rakeback_pct`; else
2. their agent's `agents.player_rakeback_rate` (joined on `status='active'`); else
3. a legacy volume ladder (0.05 → 0.30).
   Then capped at `upline commission − 0.10`.

**Two trees exist** — `club_members.agent_id` (user→user) and
`agents.parent_agent_id` (row→row). Measured clean: 0 disagreements, 0 orphaned
uplines in the agents tree, 0 suspended parents. But **11 `club_members` rows
point at an `agent_id` whose role is no longer an agent tier.**

### 6.6 Credit invoicing (Phase 1 subject)

`credit_invoices(id, agent_id, period_start, period_end, debt_owed,
amount_paid, amount_remaining, status, due_date, created_at, paid_at,
void_reason)`. Status CHECK now
`pending|partial|paid|overdue|disputed|void`. Unique `(agent_id, period_end)`.
One RLS policy `credit_invoices_select_own`. **No views.** Only four functions
touch it: `fn_generate_all_credit_invoices`, `fn_generate_credit_invoice`,
`fn_apply_credit_payment`, `fn_pay_credit_invoice_from_wallet`.

**Nothing ever sets `status='overdue'`** — invoices sit at `pending` past due.
The two functions matching `'overdue'` belong to the _union_ invoice table
(`ca_club_union_invoices`), a different system. Pre-existing gap.

### 6.7 Technical debt found, not yet addressed

- `MembershipService.ts` declares a **second, fictional role vocabulary**
  (`platform_admin`, `union_lead`, `club_owner`, `club_admin`, `member`,
  `guest`) with `ROLE_HIERARCHY`, `ROLE_DISPLAY_NAMES` and a `canPerformAction`
  matrix. `club_members_role_check` has never accepted any of those names.
  `updateRole` was fixed in Ph0; **the rest of the file still lies.**
- `src/types/club.types.ts:138` and `src/lib/constants.ts:182` each declare a
  third and fourth `MemberRole`. `ClubsService.ts` imports one.
- `useClubMembership` (`src/hooks/index.ts`) has **zero callers**.
- `src/components/club/MemberList.tsx` is **never imported**.
- Six wallet columns for three wallets, synced by trigger.
- `agents.role` CHECK cannot express a staff wallet-holder, so
  `fn_ensure_agent_row` writes `'super_agent'` for any non-agent — the data lies
  about who holds the wallet.
- `fn_ensure_agent_row` **invents a commission** (the union minimum) — the same
  "a rate nobody chose" class of bug Ph0 removed from the promotion path.

---

## 7. Work Completed During This Chat

### Workstream A — Promotion audit (PR #2132, **MERGED** 2026-08-31 11:32 UTC)

**A1. `co_owner` made real.** `20260831235996_co_owner_counts_as_club_staff.sql`.
Before: `fn_role_rank('co_owner') = 0` — **below a player's 1** — and
`is_club_admin`, `fn_is_club_admin_uid`, `ca_can_view_club_finances`,
`fn_actor_can_manage_club_treasury`, `fn_can_create_games`,
`fn_can_message_in_club`, `fn_register_for_tournament` and 18 club-scoped RLS
policies all said no.
Method: **24 functions and 18 policies rewritten by regular expression**
(`'owner'(\s*,\s*)'admin'` → insert `'co_owner'`) so each body is byte-identical
apart from the added role, with the outcome asserted inside the migration. Added
`fn_club_is_staff(club, user)`.
Verified post-apply: 24 functions aware, **0** policies still blind.

**A2. Promotion assigns rakeback.**
`20260831235997_promotion_assigns_rakeback_and_staff_earn_none.sql`.
`fn_club_set_member_role` gained `p_commission_rate`, `p_player_rakeback_rate`;
refuses an agent-role promotion with no rate (`needs_rates: true`); validates
bounds, rakeback ≤ commission, both ≤ upline; applies on **both** INSERT and
UPDATE. The 4-arg overload was dropped to avoid ambiguity.

**A3. Staff earn no rakeback.** `trg_club_members_staff_earn_no_rakeback` and
`trg_agents_staff_earn_no_rakeback` zero the rate columns for co_owner/admin
whatever writes them. The agents **row** is never suspended or deleted (it is
the wallet). Backfill: 0 rows. **Owner deliberately not covered.**

**A4. Client wiring, nine defects.** `MembershipService.updateRole` → the RPC (it
had been throwing for nine days behind "Failed to promote member");
`ClubDetailPage` demote `'member'` → `'player'`; `ClubMemberManagement` direct
write → RPC; `getEligibleForPromotion` `['member','guest']` → `['player']` (the
picker was always empty); `server/src/handlers/admin.ts` both role lists gained
`co_owner`; `ClubMessagingPermissions` mapped 3 of 7 roles → all 7;
`ChipTransferModal` `senderRole === 'owner'` → `isClubStaff`; `hooks/index.ts`
booleans; badge/label maps across six pages.

**A5.** `tests/promotion-assigns-the-rate.law.test.ts` — 27 pins. One existing
pin moved to the new mechanism in the same commit
(`tests/unit/lobbyUnionCreateControls.test.ts`), per `CLAUDE.md` §5.8.

### Workstream B — Phase 1 (PR #2155, **OPEN**)

**B1. `20260901000001_an_invoice_bills_what_was_borrowed.sql`** — applied,
verified, pushed.

`fn_generate_all_credit_invoices` computed
`v_debt := credit_limit - agent_wallet_balance` — the **unused portion of the
line**. Measured before the fix:

|                                   |                        |
| --------------------------------- | ---------------------- |
| Invoices raised                   | 224                    |
| Chips billed                      | 18,047,771             |
| `agents.credit_used`, estate-wide | **0.00**               |
| Overdue                           | 184, oldest 2026-07-21 |
| Payments ever made                | 0                      |

One agent with a 500,000 line who had never borrowed carried **twelve** invoices
of 500,000. Another, thirty at 150,000.

Second defect found while fixing the first: **`fn_apply_credit_payment` never
touched `agents.credit_used`** — an agent could have paid in full and still owed
every chip.

Changes: batch bills `credit_used` and skips agents who owe nothing;
`fn_generate_credit_invoice` reads the debt from the agents row rather than
trusting the caller, refuses a bill > `credit_used`, refuses a prepaid agent;
`fn_apply_credit_payment` decrements `credit_used` in the same transaction and
clamps to what is outstanding; `credit_invoices` gained `void` + `void_reason`;
both payment paths refuse a void invoice — the wallet path **before** the
deduct; **all 224 phantom invoices voided** (every one had `amount_paid = 0`).

**B2. Client half — five defects found in the completion sweep** (`94d97bbbc3`):

| Defect                                                  | Effect                                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InvoiceStatus` union lacked `'void'`                   | Every screen keyed on it fell to its default branch                                                                                                                                    |
| `STATUS_COLORS` lacked `void`                           | Voided invoices rendered in the unknown-state grey                                                                                                                                     |
| `mapInvoice`: `inv.amount_remaining \|\| inv.debt_owed` | **`0` is falsy** — a settled or voided invoice reported its whole original debt as due and drew a **"Pay now" button on 224 cancelled bills**                                          |
| `checkSuspension`: `status !== 'paid'`                  | **A void invoice counts as overdue debt.** `FinancialCronService.ts:261` calls it and then `suspendAgent` — the cron would have suspended every credit agent for 18M chips nobody owed |
| `reinstateAgent`: identical filter                      | An agent suspended over a cancelled invoice could **never be let back in**                                                                                                             |

Fix: one exported definition, `OWED_INVOICE_STATUSES = {pending, partial,
overdue}`, in `CreditService`, imported by `AgentInvoicesPanel`.

**B3.** `scripts/ci/supabase-columns-manifest.json` (`2f213e4c23`) — added
`credit_invoices.void_reason`. See §15.2.
**B4.** `tests/an-invoice-bills-what-was-borrowed.law.test.ts` — 22 pins.
**B5.** `docs/changelog/2026-08-31-phase1-invoice-bills-what-was-borrowed.md`.

---

## 8. Visual And Product Decisions

**No visual design work occurred. No reference images were supplied, generated,
approved or rejected. No mockups exist.**

The only UI surface changed is functional:

| Surface                      | File                                          | Behaviour                                                                                                                                                                                                                                     | Locked?       |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Promote screen — rate fields | `MemberManagementPage.tsx` `RoleSection`      | Two number inputs (Commission 0–70, Player Rakeback 0–50) shown only when the chosen role `isAgentRole`. **Neither pre-filled** — a pre-filled rate is a rate nobody chose. Client validates bounds and rakeback ≤ commission before the RPC. | Locked by Ph0 |
| Promote screen — staff note  | same                                          | "This Role Earns No Rakeback. Any Rate This Member Carries Is Set To Zero." when `isClubStaff(confirmRole)`. **Wording forced by the title-case fixer**, which turns "Co Owners" into "CO Owners".                                            | Locked        |
| Rate panel styling           | `MemberManagementPage.css` `.mm-roles__rates` | Mobile-first: single column, full-width fields, 375px first.                                                                                                                                                                                  | Locked        |
| Invoice status colour        | `AgentInvoicesPanel.tsx`                      | `void: '#718096'` grey — settled history, not an unknown state.                                                                                                                                                                               | Ph1           |
| Pay Now button               | `AgentInvoicesPanel.tsx:143`                  | `OWED_INVOICE_STATUSES.has(status) && amountRemaining > 0`.                                                                                                                                                                                   | Ph1           |

**Phase 2 must add prepaid/credit inputs to the same `RoleSection` block,
matching the existing `.mm-roles__rates` treatment.**

**Never opened in a browser.** None of the above has been visually verified at
any viewport.

---

## 9. Functional And Architectural Decisions

| Decision                                                           | Status                                          |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| Seven club roles; `clubRoles.ts` mirrors `fn_club_grantable_roles` | **Implemented**                                 |
| `co_owner` counts as staff everywhere                              | **Implemented** (24 fns, 18 policies)           |
| Role changes only via `fn_club_set_member_role`                    | **Implemented**                                 |
| Promotion assigns commission + rakeback, refuses without           | **Implemented**                                 |
| Rakeback ≤ commission; both ≤ upline                               | **Implemented** (new rows only)                 |
| Co-owners and admins earn no rakeback                              | **Implemented** (two triggers)                  |
| Owner NOT covered by the no-rakeback rule                          | **Decided — Dan's call, deliberately left**     |
| Demotion refuses while a downline reports to the member            | **Implemented**                                 |
| Invoice bills `credit_used`                                        | **Implemented** (Ph1)                           |
| Paying an invoice clears the debt                                  | **Implemented** (Ph1)                           |
| Void invoices unpayable                                            | **Implemented** (Ph1)                           |
| Owners/co-owners hold agent wallets                                | **Specified only — BLOCK STILL LIVE, §16 D-01** |
| Promotion assigns prepaid/credit + amount                          | **Designed only — draft lost, §15.1**           |
| Credit line spendable in `fn_agent_wallet_send`                    | **Designed only — draft lost**                  |
| Claim-back repays credit proportionally                            | **Designed only — draft lost**                  |
| `ChipTransferModal` on the cashier RPCs                            | **Not started** (Ph3)                           |
| Drop `transfer_chips_agent_to_player`                              | **Not started**                                 |
| Demotion settles wallet/credit/commission                          | **Not started** (Ph4)                           |
| Repair 11 orphaned uplines                                         | **Not started** (Ph4)                           |
| Ownership handover / promote to owner                              | **Not started** (Ph5)                           |
| Notify the person whose role changed                               | **Not started** (Ph5)                           |
| Fund the new agent at promotion                                    | **Not started** (Ph5)                           |
| Circulation counts all five pools                                  | **Not started** (Ph6)                           |
| `pending_commission` payout                                        | **Not started** (Ph6)                           |
| Effective-dated rates                                              | **Not started** (Ph7)                           |
| `agents.role` honesty                                              | **Not started** (Ph7)                           |
| Re-promotion inherits old deal?                                    | **BLOCKED on Dan, §19 B-01**                    |

Untouched systems: tournaments, spins, Sit & Go, bomb pots, RIT, insurance,
straddles, VPIP, anti-rathole, BBJ, hand histories, replays, lobby filtering,
table auto-spawning, realtime subscriptions.

---

## 10. Exact Current State

All verified 2026-08-31 ~12:30 UTC.

```text
Branch:            agent/cowork-claude-roles/credit-and-lifecycle
Tracking:          origin/agent/cowork-claude-roles/credit-and-lifecycle
git status:        CLEAN (nothing staged, unstaged, or untracked)
Unpushed commits:  NONE
Commits ahead of origin/main: 3
  2f213e4c23  chore(ci): the columns manifest learns credit_invoices.void_reason
  94d97bbbc3  fix(credit): the client knows what a void invoice is, and will not suspend anyone over one
  964469f0b2  fix(credit): an invoice bills what was borrowed, and paying it clears the debt
Commit identity:   Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>   ✓
--no-verify used:  NO, at any point
```

**PR #2155** — OPEN, `mergeStateStatus: BLOCKED` (checks not all reported).
**PR #2132** — MERGED 2026-08-31T11:32:20Z.

CI on `2f213e4c23`, last successful read before the API rate-limited:

| Job                                                        | Result                          |
| ---------------------------------------------------------- | ------------------------------- |
| What changed                                               | success                         |
| Stub Gate                                                  | success                         |
| **TypeScript Check** (contains CHECK 17, which had failed) | **success**                     |
| Production Build                                           | success                         |
| Client Unit Tests (vitest)                                 | in_progress                     |
| CSS Beat E2E                                               | in_progress                     |
| Server Engine                                              | skipped (no `server/**` change) |

`UNKNOWN, NEXT AGENT MUST INSPECT` — whether the last two passed and whether
Autopilot merged. GitHub API returned **HTTP 403 rate-limit** at 12:29 UTC.

Production DB: migration applied; 224 invoices void; 0 live; 0 over-billing;
`void_reason` present; status CHECK includes `void`; `fn_apply_credit_payment`
contains `credit_used`; `fn_generate_all_credit_invoices` no longer mentions
`credit_limit`.

Processes: one Vite dev server from **another agent's** worktree
(`antigravity-fix-login`); ~340 node processes; **7 concurrent vitest runs from
other agents** were saturating the machine.

**Other agents are active in this repo right now** — see §15.3.

---

## 11. Changed-File Ledger

### Phase 1 — on `agent/cowork-claude-roles/credit-and-lifecycle` (PR #2155)

| File                                                                        | Status   | Purpose                       | What Changed                                                                                                                        | Verified                                              | Committed                    |
| --------------------------------------------------------------------------- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| `supabase/migrations/20260901000001_an_invoice_bills_what_was_borrowed.sql` | Added    | Phase 1 migration             | 4 functions replaced; `void_reason` column; status CHECK extended; 224 invoices voided; self-asserting verify block                 | Applied to prod; assertions passed; rolled-back probe | ✓ `964469f0b2`               |
| `tests/an-invoice-bills-what-was-borrowed.law.test.ts`                      | Added    | 22 pins                       | Batch / entry-point / payment / void / client pins                                                                                  | 22/22 pass                                            | ✓ `964469f0b2`, `94d97bbbc3` |
| `docs/changelog/2026-08-31-phase1-invoice-bills-what-was-borrowed.md`       | Added    | Changelog (`CLAUDE.md` §10.9) | 86 lines                                                                                                                            | n/a                                                   | ✓ `964469f0b2`               |
| `src/services/CreditService.ts`                                             | Modified | Invoice types + suspension    | `InvoiceStatus` + `'void'`; `OWED_INVOICE_STATUSES` exported; `mapInvoice` `??`; `checkSuspension` and `reinstateAgent` use the set | tsc clean; pinned                                     | ✓ `94d97bbbc3`               |
| `src/components/agent/AgentInvoicesPanel.tsx`                               | Modified | Invoice UI                    | `void` colour; imports `OWED_INVOICE_STATUSES`; `canPay` gates on status                                                            | tsc clean; pinned                                     | ✓ `94d97bbbc3`               |
| `scripts/ci/supabase-columns-manifest.json`                                 | Modified | CI schema snapshot            | `credit_invoices` gains `void_reason` (2-line diff)                                                                                 | CHECK 17 reproduced locally, passes                   | ✓ `2f213e4c23`               |

### Phase 0 — merged in PR #2132

`supabase/migrations/20260831235996_*.sql`, `20260831235997_*.sql`;
`src/services/{MembershipService,ClubMessagingPermissions}.ts`;
`src/pages/{ClubDetailPage,MemberManagementPage,MemberManagementPage.css,
AgentDashboardPage,ClubSettingsPage,ClubFinancialsPage,ClubHomePage,ClubsPage}`;
`src/components/{admin/ClubMemberManagement,agent/ChipTransferModal}.tsx`;
`src/hooks/index.ts`; `server/src/handlers/admin.ts`;
`tests/promotion-assigns-the-rate.law.test.ts`;
`tests/unit/lobbyUnionCreateControls.test.ts`;
`docs/changelog/2026-08-31-promotion-system-audit.md`. All ✓ merged.

### Other-agent work — DO NOT TOUCH

- `cowork-claude-wallets` — another agent, branch
  `claude/phase3-final-alert-sweep`. I reset it back to _their_ tip after
  accidentally committing onto it (§15.3). **Leave it alone.**
- `cowork-claude-table` — **17 dirty files** at last check, another agent.
- `backup/roles-audit-2026-08-31` — a safety branch I created holding the Phase 0
  commit. Harmless; deletable now that #2132 is merged.

---

## 12. Asset Ledger

**No visual assets were created, uploaded, approved or rejected in this
session.** No images, icons, frames, logos or mockups are involved.

| Asset | Path | Purpose | Approved | Implemented | Tracked |
| ----- | ---- | ------- | -------- | ----------- | ------- |
| —     | —    | none    | —        | —           | —       |

The only "assets" are documents, all tracked in git: two changelogs, three
migrations, two test files, and this handoff. **Nothing relevant lives in
temporary storage** except the lost draft in §15.1, which is unrecoverable.

---

## 13. Commands And Tools Used

All from `/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-compliance`
unless noted, via `mcp__counselors__host_terminal` (runs on the Mac).

| Command                                                                      | Purpose                                                            | Result                                                                                        | Changed files         | Rerun?                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------- |
| `export PATH="/opt/homebrew/bin:$PATH"; source ~/.nvm/nvm.sh`                | `gh`/`node`/`npx` are **not** on the default PATH                  | required prefix                                                                               | no                    | **every call**                     |
| `git worktree add -b <branch> <path> origin/main`                            | Claim a worktree                                                   | ok                                                                                            | yes                   | as needed                          |
| `git checkout -B agent/cowork-claude-roles/credit-and-lifecycle origin/main` | Start Phase 1 branch                                               | ok                                                                                            | yes                   | **destroyed the Ph2 draft, §15.1** |
| `npx tsc --noEmit` (root and `server/`)                                      | Type check                                                         | **both clean**                                                                                | no                    | before every commit                |
| `npx vitest run tests/<file>`                                                | Targeted tests                                                     | pass                                                                                          | no                    | yes                                |
| `npx vitest run tests/`                                                      | Full client suite                                                  | **killed by host timeout ×3**; last clean full run 720 files / 10,132 tests on an earlier sha | no                    | when the machine is quiet          |
| `node scripts/ci/check-migrations-applied.mjs origin/main`                   | Reproduce CHECK 17                                                 | `0 unapplied object(s)`                                                                       | no                    | **after every migration**          |
| `node scripts/ci/check-phantom-columns.mjs`                                  | Phantom columns                                                    | 0 phantom                                                                                     | no                    | yes                                |
| `node scripts/ci/check-required-columns.mjs`                                 | Insert payloads                                                    | 96 ok, 11 unjudgeable                                                                         | no                    | yes                                |
| `node scripts/ci/check-title-case.mjs [--fix]`                               | Page copy                                                          | ok                                                                                            | `--fix` yes           | before push                        |
| `git add -A && git commit -m "…"`                                            | Commit (husky runs prettier + eslint)                              | ok                                                                                            | reformats             | yes                                |
| `nohup git push origin HEAD:<branch> > /tmp/x.log 2>&1 &` then `sleep 50`    | Push; the pre-push hook runs related tests and outlives a 55s call | ok                                                                                            | no                    | yes                                |
| `gh pr create --body-file /tmp/body.md`                                      | Open PR                                                            | Autopilot had already opened it                                                               | no                    | prefer `gh pr edit`                |
| `gh run list` / `gh api …/jobs`                                              | CI status                                                          | **HTTP 403 rate limit at 12:29 UTC**                                                          | no                    | later                              |
| Supabase MCP `apply_migration`                                               | Apply to prod                                                      | success                                                                                       | prod schema           | once per migration                 |
| Supabase MCP `execute_sql`                                                   | Read-only audit + rolled-back probes                               | see §14                                                                                       | no (probes roll back) | yes                                |

**`gh pr create --body "$(cat <<'BODY' … BODY)"` fails** on apostrophes in the
outer shell. Write the body to `/tmp/*.md` and use `--body-file`.

---

## 14. Verification And Test Results

| Verification                           | Command / Method                                           | Result                                        | Phase                  | Follow-up                                                               |
| -------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| Client type check                      | `npx tsc --noEmit`                                         | **PASS**                                      | Ph0, Ph1, Ph1-sweep    | —                                                                       |
| Server type check                      | `cd server && npx tsc --noEmit`                            | **PASS**                                      | Ph0, Ph1, Ph1-sweep    | —                                                                       |
| Full client suite                      | `npx vitest run tests/`                                    | **PASS — 720 files, 10,132 tests**            | Ph1 (sha `964469f0b2`) | **NOT re-run after `94d97bbbc3` + `2f213e4c23`**                        |
| Full server suite                      | `cd server && npx vitest run`                              | **PASS — 269 files, 3,051 tests**             | Ph1                    | Unchanged since                                                         |
| Targeted suite after client fixes      | `npx vitest run` on 6 files                                | **PASS — 131 tests**                          | Ph1-sweep              | —                                                                       |
| Phase 1 pins                           | `npx vitest run tests/an-invoice-*`                        | **PASS — 22/22**                              | Ph1-sweep              | —                                                                       |
| Pre-push hook                          | on push                                                    | **PASS — 6 files, 50 tests** + 9 house checks | Ph1-sweep              | —                                                                       |
| CHECK 17                               | `node scripts/ci/check-migrations-applied.mjs origin/main` | **FAIL then PASS**                            | Ph1                    | Root cause §15.2                                                        |
| Phantom columns                        | `node scripts/ci/check-phantom-columns.mjs`                | **PASS — 0**                                  | Ph1-sweep              | —                                                                       |
| Required columns                       | `node scripts/ci/check-required-columns.mjs`               | **PASS — 96 checked**                         | Ph1-sweep              | —                                                                       |
| Title case / nav / UI text             | pre-push                                                   | **PASS**                                      | Ph1                    | —                                                                       |
| Migration self-assertions              | inside `apply_migration`                                   | **PASS**                                      | Ph0 ×3, Ph1            | —                                                                       |
| **Rolled-back production probe — Ph0** | `DO $probe$ … RAISE EXCEPTION`                             | **PASS ×6**                                   | Ph0                    | —                                                                       |
| **Rolled-back production probe — Ph1** | same                                                       | **PASS ×5**                                   | Ph1                    | —                                                                       |
| CI — TypeScript Check                  | GitHub Actions                                             | **success** on `2f213e4c23`                   | Ph1                    | —                                                                       |
| CI — Production Build                  | GitHub Actions                                             | **success**                                   | Ph1                    | —                                                                       |
| CI — Client Unit Tests                 | GitHub Actions                                             | **in_progress** at last read                  | Ph1                    | `UNKNOWN, NEXT AGENT MUST INSPECT`                                      |
| CI — CSS Beat E2E                      | GitHub Actions                                             | **in_progress**                               | Ph1                    | `UNKNOWN, NEXT AGENT MUST INSPECT`                                      |
| Deployment verification                | `curl smarter.poker/hub/club-arena/build-info.json`        | **NOT RUN**                                   | —                      | After #2155 merges                                                      |
| Browser / manual UI                    | —                                                          | **NEVER RUN**                                 | —                      | The promote screen's rate fields have never been exercised in a browser |
| Responsive 375px                       | —                                                          | **NEVER RUN**                                 | —                      | `.mm-roles__rates` never viewed                                         |
| Accessibility                          | —                                                          | **NEVER RUN**                                 | —                      | —                                                                       |
| Rollback of any migration              | —                                                          | **NEVER TESTED**                              | —                      | Documented, not exercised                                               |

### Probe detail — Phase 0 (rolled back)

```
no_rates          → "a commission rate and a player rakeback rate must be chosen…"
staff_with_rate   → "co owners and admins receive no rakeback…"
rake > commission → "the player rakeback rate cannot exceed the commission rate…"
valid             → success; stored comm=0.4200 rake=0.1100 role=agent status=active
admin promotion   → player_rakeback_pct 0.2500 → 0.0000
direct write 0.40 → 0.0000 (trigger)
```

### Probe detail — Phase 1 (rolled back)

```
1 no debt          → "this agent has drawn no credit, so there is nothing to invoice"
2 draw 500, bill   → success, debt_owed 500
3 pay 200          → applied 200, credit_used 500.00 → 300.00
4 overpay 1000     → clamped to 300, credit_used → 0.00
5 pay void invoice → "that invoice was voided and is not payable"
```

### Explicitly NOT tested

Browser/manual anything; responsive; accessibility; visual regression; the
credit **drawdown** path (does not exist yet); `pending_commission` payout;
rollback; load/performance; the Hetzner engine (no `server/**` change in Ph1).

---

## 15. Setbacks, Failed Approaches, And Lessons

### 15.1 — **THE PHASE 2 DRAFT MIGRATION WAS DESTROYED**

I wrote a complete Phase 2 migration to
`supabase/migrations/20260831235998_a_credit_line_is_spendable_and_staff_hold_agent_wallets.sql`
in this worktree. It was **never committed**. I then ran
`git checkout -B agent/cowork-claude-roles/credit-and-lifecycle origin/main`,
and `origin/main` had meanwhile gained **another agent's file at that exact
path** (`20260831235998_stats_v2_reads_bounded_rollup.sql`, via _Daily update
#2150_). The checkout materialised theirs over mine.

Verified gone: not on disk in any worktree, not in `git log --all`, not in any
stash, not in `refs/wip`. **Unrecoverable.**

**Its full design is preserved in §21 Phase 2.** Rewrite as `20260901000002_…`.

**Lessons:** commit a draft migration the moment it is written, even
half-finished, on your own branch; never assume a `2026…` filename is yours —
several agents mint them the same day; `git checkout -B` silently overwrites an
untracked file whose path exists in the target ref.

### 15.2 — I claimed Phase 1 was done while CI was red

I reported "PHASE 1 OF 7 IS DONE" from a green **local** run. CI's
`TypeScript Check` had already failed **CHECK 17**: the migration declared
`credit_invoices.void_reason`, which existed in production but not in
`scripts/ci/supabase-columns-manifest.json`, the checked-in schema snapshot.
The pre-push hook only runs tests related to what you touched, so it never saw
it. Dan's next instruction caught it.

**Lesson: `apply_migration` is only half the job. Any `ADD COLUMN` must also be
reflected in `scripts/ci/supabase-columns-manifest.json` in the same PR.**
Reproduce CI locally with
`node scripts/ci/check-migrations-applied.mjs origin/main` — **the argument
matters**; with none it compares against `HEAD~1` and reports nothing.

### 15.3 — Another agent switched branches under me mid-session

While I worked in `cowork-claude-wallets`, another agent moved that worktree
through `claude/phase3-verify-sweep-timeouts` → `phase3-handshake` →
`phase3-final-alert-sweep`. My untracked migration vanished once and had to be
rewritten from context, and my commit landed on **their** branch. Recovery:
cherry-picked my commit onto a fresh worktree, then `git reset --hard` their
branch back to their own tip (their tree was clean; nothing of theirs lost).

**Lesson: verify `git rev-parse --abbrev-ref HEAD` immediately before every
commit. Prefer a worktree nobody else is in.** `claude-compliance` had been idle
7 days, which is why I moved here.

### 15.4 — A false headline I caught before shipping

The first draft of `20260831235997` claimed `trg_club_members_role_guard` "was
never armed" and that any club admin could write `role='owner'` through
PostgREST. **Wrong.** A truncated `string_agg` in my own trigger-listing query
had hidden it. Corrected before apply; the migration header records both the
claim and the correction.

**Lesson: never list triggers/policies with `string_agg` — the transport
truncates. One row per object.**

### 15.5 — Migration deadlocks against Supabase Realtime

`DROP/CREATE TRIGGER` on `club_members` **deadlocked twice** against
`realtime.subscription` (relation 16907 vs 17541), then hit a lock timeout.
`club_members` is realtime-published and hot.

**Fix that worked:** one table per transaction, never two table locks in one
migration, `SET LOCAL lock_timeout` (5s → 25s), and retry. The `agents` half
applied first time; `club_members` needed 25s and a third attempt.

### 15.6 — "Must not appear" test pins matched my own comments

Three times a `not.toMatch` pin failed because the comment _explaining_ the bug
contained the forbidden string. Solution: a `codeOnly()` helper that strips
`/* */` blocks and lines starting with `//`, `*` or `--`. **Both law tests carry
it. Reuse it.**

### 15.7 — Host terminal drops long calls; other agents saturate the machine

`mcp__counselors__host_terminal` closes at roughly 50–60s and **kills the child
process**. `nohup … &` + `sleep 50` in the _same_ call works; `setsid` +
`disown` polled from a _later_ call did **not** survive. With 7 other vitest
runs going, a full suite could not complete locally. Targeted runs + the
pre-push hook + CI is the workable combination.

### 15.8 — Title-case fixer mangles "Co"

`check-title-case.mjs --fix` rewrites "Co Owners" to "CO Owners". Reworded to
"This Role Earns No Rakeback." Avoid the two-letter word rather than fight it.

### 15.9 — Tool friction worth knowing

GateGuard blocks the first Write/Edit per new path (§5) — restate the four facts
and retry the identical call. `gh pr create` with a heredoc body breaks on
apostrophes. The GitHub Actions API rate-limited at 12:29 UTC. The **sandbox**
(`mcp__workspace__bash`) is Linux and **cannot run the macOS-built
`node_modules`** — use it for reads and greps only; builds and tests must go
through the host terminal.

---

## 16. Known Defects And Architectural Holes

| Priority      | Defect                                                                                                                 | Evidence                                                                                                                              | Impact                                                                                                                              | Recommended fix                                                                                         | Status         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------- |
| **P0 (D-01)** | `fn_create_agent` and `fn_admin_update_agent` still refuse a staff agent wallet — **the mistake Dan explicitly named** | Live: both contain `earns no rakeback`                                                                                                | An owner or co-owner cannot be given an agent wallet through the agent panel                                                        | Remove the refusal; never sync a _staff_ member's club role when minting their wallet                   | **LIVE — Ph2** |
| **P0**        | Credit line is not drawable                                                                                            | `fn_agent_wallet_send_core_20260830` has no `credit_used`/`is_prepaid`; estate `credit_used = 0.00`                                   | 47 agents hold 7.67M of credit they cannot use                                                                                      | Port the rule from `transfer_chips_agent_to_player`                                                     | **Ph2**        |
| **P0**        | Promotion never assigns prepaid/credit                                                                                 | `fn_club_set_member_role` is the 6-arg version; hardcodes `credit_limit, 0`                                                           | Every promoted agent lands "not prepaid, zero line" — cannot send a chip. **3 agents are in that state now**                        | Add `p_is_prepaid`, `p_credit_limit`; require for agent roles                                           | **Ph2**        |
| **P1**        | `ChipTransferModal` is a 4th money path on the wrong accounts                                                          | `ChipTransferModal.tsx:312,321,330`; documented at `CashierPage.tsx:1430-1455`                                                        | Chips move between personal player wallets; club bank and agent wallets untouched; no idempotency, no downline check, no ledger row | Rewire to `fn_club_bank_send` / `fn_agent_wallet_send`; delete the three dead `ChipFlowService` methods | **Ph3**        |
| **P1**        | Claim-back would not repay a credit-funded send                                                                        | `fn_agent_wallet_claim_back_phase2_core_20260831` has no `credit_used`                                                                | Agent would hold returned chips **and** the debt                                                                                    | Repay proportionally to the claimed fraction                                                            | **Ph2**        |
| **P1**        | Demotion strands money                                                                                                 | `fn_club_set_member_role` suspends the agents row with no balance/debt/commission check                                               | 6.73M sits in agent wallets; the role gate then blocks spending it                                                                  | Refuse, or sweep to club bank + settle, as an explicit choice                                           | **Ph4**        |
| **P1**        | 11 members have an orphaned upline                                                                                     | measured                                                                                                                              | Rakeback falls through to the volume ladder; commission attribution unclear                                                         | Reassign or detach — a decision, not a silent rewrite                                                   | **Ph4**        |
| **P1**        | `pending_commission` never pays out                                                                                    | 26,859.87 accrued; no function moves it                                                                                               | Agents have earned money they cannot receive                                                                                        | Build the payout, or document why it accrues                                                            | **Ph6**        |
| **P1**        | Reconciliation blind to 9.15M chips + all credit                                                                       | `fn_club_chip_circulation` counts 2 of 5 pools; `reconcile_ledger_nightly` ignores `credit_used`                                      | Once credit moves, borrowed chips are unwatched                                                                                     | Extend both                                                                                             | **Ph6**        |
| **P2**        | A rate change reprices history                                                                                         | `fn_rakeback_recompute_periods` → `fn_player_rakeback_rate` returns the **current** rate; **7 settlement periods open**               | Changing a rate today re-prices last week's unsettled hands                                                                         | Effective-dated rate history                                                                            | **Ph7**        |
| **P2**        | Existing rows violate the new caps                                                                                     | 7 credit limits, 1 commission, 1 rakeback exceed their upline                                                                         | New rules bind forward only                                                                                                         | Report, then decide                                                                                     | **Ph4**        |
| **P2**        | Nobody is told their role changed                                                                                      | `MEMBER_ROLE_CHANGED` is a browser-local bus event only                                                                               | A demoted member discovers it when a button vanishes                                                                                | Notification row                                                                                        | **Ph5**        |
| **P2**        | No path to promote to owner / hand over a club                                                                         | `fn_club_set_member_role` excludes `owner`; `transfer_club_ownership`'s only caller is `AdminDashboardPage.tsx:1886` (platform admin) | A club owner cannot hand over their club                                                                                            | Owner-initiated handover, or document as deliberate                                                     | **Ph5**        |
| **P2**        | `transfer_chips_agent_to_player` is dead but callable                                                                  | 0 callers; debits the wrong account                                                                                                   | A loaded gun                                                                                                                        | Drop it                                                                                                 | **Ph3/7**      |
| **P3**        | Nothing ever sets `status='overdue'`                                                                                   | no function writes it for `credit_invoices`                                                                                           | Overdue invoices look pending                                                                                                       | A dunning job                                                                                           | Backlog        |
| **P3**        | `agents.role` cannot express a staff wallet-holder                                                                     | CHECK allows 3 tiers; `fn_ensure_agent_row` writes `'super_agent'`                                                                    | The data lies                                                                                                                       | Relax the CHECK, or add `holder_kind`                                                                   | **Ph7**        |
| **P3**        | `fn_ensure_agent_row` invents a commission                                                                             | union minimum                                                                                                                         | Same class Ph0 removed                                                                                                              | Mint at 0                                                                                               | **Ph7**        |
| **P3**        | Four competing `MemberRole` vocabularies                                                                               | `MembershipService.ts:31`, `club.types.ts:138`, `lib/constants.ts:182` vs `clubRoles.ts`                                              | Confusion; dead permission matrices                                                                                                 | Collapse onto `ClubRole`                                                                                | **Ph7**        |
| **P3**        | Six wallet columns for three wallets                                                                                   | `trg_sync_agent_wallets`                                                                                                              | Reconciliation hazard                                                                                                               | Collapse                                                                                                | **Ph7**        |
| **P4**        | Dead code                                                                                                              | `MemberList.tsx` unimported; `useClubMembership` uncalled                                                                             | Noise                                                                                                                               | Delete                                                                                                  | Backlog        |

---

## 17. Security, Secrets, And Credentials

**No secret value is printed here, and none was printed in the session.**

| Name                                                 | Where configured                                                                 | Used by                   | Available?                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`                          | CI repo secret; `.env.local` in the **canonical clone only**; Supabase dashboard | Engine, CI schema tools   | Not in this worktree; the Supabase MCP handled all DB access                                                        |
| `SUPABASE_URL`                                       | same                                                                             | schema manifest generator | same                                                                                                                |
| `GH_PAT`                                             | repo secret                                                                      | legacy fallback           | Local `gh` is authenticated; **lacks `Checks: Read`**, so `gh pr checks` 403s — use `gh run list` / `gh api …/jobs` |
| `AUTOPILOT_APP_ID` + `AUTOPILOT_APP_PRIVATE_KEY`     | all 7 repos                                                                      | merge/publish credential  | Assumed live (Autopilot opened PRs)                                                                                 |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` | repo secrets                                                                     | deploy                    | untouched                                                                                                           |
| `HETZNER_SSH_PRIVATE_KEY`, `HETZNER_HOST`            | repo secrets                                                                     | engine deploy             | untouched                                                                                                           |
| `SENTRY_AUTH_TOKEN/ORG/PROJECT`                      | `~/Documents/club-arena/.env`                                                    | build                     | untouched                                                                                                           |

Supabase project **`kuklfnapbkmacvwxktbh`** is smarter.poker.
**`ydsaqnnuwyvtyxgvrnys` is PepNationLab — never cross them.**

**No credential was exposed.** No secret appears in any file created this
session. `.env*` files exist only in the canonical clone, not in this worktree.

To regenerate the schema manifests the next agent needs `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` exported (they live in
`~/Documents/club-arena/.env.local`). **Phase 1 did not need them** — the 2-line
manifest edit was made by hand from a read-only `information_schema.columns`
query, which is accurate and lower-risk.

---

## 18. Database, Migration, And Seed Status

**Provider:** Supabase Postgres, project `kuklfnapbkmacvwxktbh`.

### Applied this session — all to PRODUCTION; no staging exists

| Migration                                                       | Applied                                       | Committed | PR           |
| --------------------------------------------------------------- | --------------------------------------------- | --------- | ------------ |
| `20260831235996_co_owner_counts_as_club_staff`                  | ✓                                             | ✓         | #2132 merged |
| `20260831235997_promotion_assigns_rakeback_and_staff_earn_none` | ✓ (split into 3 transactions on apply, §15.5) | ✓         | #2132 merged |
| `20260901000001_an_invoice_bills_what_was_borrowed`             | ✓                                             | ✓         | #2155 open   |

**The Phase 0 file and what was applied differ in transaction shape** — the repo
file is one script; production received it as three (agents half, club_members
half, functions) because of the realtime deadlock. Semantics identical; recorded
in the file header.

### Schema changes

- `credit_invoices.void_reason text` — **added**, nullable, no default.
- `credit_invoices_status_check` — replaced; now includes `'void'`.
- No new tables, indexes or RLS policies.
- Triggers added (Ph0): `trg_club_members_staff_earn_no_rakeback`,
  `trg_agents_staff_earn_no_rakeback`.
- Signature change (Ph0): `fn_club_set_member_role` 4-arg **dropped**, 6-arg
  created. **Phase 2 must drop the 6-arg and create the 8-arg** — two overloads
  would make the PostgREST call ambiguous.

### Data written

- Ph0 backfills: **0 rows** (no co_owners or admins exist).
- Ph1: **224 `credit_invoices` rows** → `status='void'`, `amount_remaining=0`,
  with `void_reason`. Every one had `amount_paid = 0`; **no payment was unwound
  and no chip moved.**

### Rollback

Documented in each migration header. **Never exercised.** The Ph1 rollback is
safe (voided rows keep `debt_owed`, `period_*`, `due_date`; setting status back
to `pending` restores them). **Do not** roll back the `credit_used` decrement
without also reverting the billing formula.

### Seeds

**No seed script was written or run.** No seed data created. Existing seeds
untouched.

### Backup

**No database backup was taken before any migration.** Supabase PITR is assumed.
`UNVERIFIED` — confirm PITR is on before Phase 2, the first phase that changes
how money _moves_.

### Local vs remote

There is **no local database**. All work is against production. That is why
`CLAUDE.md` §11.5 requires every money-path probe to run inside a rolled-back
transaction. **Both probes complied.**

---

## 19. Current Blockers And Decision Points

### B-01 — Re-promotion inherits the old deal? **REQUIRES DAN**

If an agent is demoted to player and later re-promoted, their `agents` row still
holds the old commission, rakeback and credit line. My Phase 0 design made rates
**optional when a row already exists**, so the old deal is silently restored.

- **Option A — force a fresh choice** (my stated default). Honest; a stale deal
  cannot survive a renegotiation. Costs one extra form fill.
- **Option B — inherit, and display what is being inherited.** Convenient; risks
  reinstating terms nobody re-agreed.

**Consequence of guessing wrong: money.** This is a commercial term, not a
technical one. **Do not implement Phase 2 without an answer.** If Dan is
unavailable, implement A (the refusing direction) and flag it in the PR.

### B-02 — Should `owner` also earn no rakeback? **REQUIRES DAN**

Dan named co-owners and admins. **One live owner holds an active agents row at
0.30 / 0.20.** Nothing was changed. Leave until Dan rules.

### B-03 — Is `credit_limit` a spend cap or a debt cap? **TECHNICAL; ASK IF UNSURE**

Phase 2 assumes: an agent may go short on their wallet up to
`credit_limit − credit_used`, and the shortfall becomes `credit_used`. That
matches `transfer_chips_agent_to_player` and the table CHECK. **Recorded as an
assumption, not a confirmed requirement.**

### B-04 — CI verdict on PR #2155 unknown

GitHub API rate-limited at 12:29 UTC. **Blocks Phase 2 start** — §22 step 3.

### B-05 — The 11 orphaned uplines and 9 out-of-band rows need a decision

Who earns from those 11 members? Do the 7 over-limit agents keep their limits?
**Report to Dan in Phase 4 rather than silently rewriting.**

---

## 20. Remaining Work

### Critical

1. Confirm PR #2155 merged and green.
2. **Rewrite the lost Phase 2 migration** as `20260901000002_…` (§21 Ph2).
3. Remove the staff agent-wallet block (Dan's named mistake, still live).
4. Promotion assigns prepaid/credit + amount.
5. Make the credit line drawable; claim-back repays it.
6. Resolve B-01 with Dan.

### High priority

7. Rewire `ChipTransferModal` to the cashier RPCs; delete the 3 dead
   `ChipFlowService` methods; drop `transfer_chips_agent_to_player`.
8. Demotion settles wallet, credit and commission.
9. Repair the 11 orphaned uplines.
10. Report the 9 out-of-band rate/limit rows.
11. Extend circulation + reconciliation to all five pools and to `credit_used`.
12. `pending_commission` payout, or a documented reason it accrues.

### Medium

13. Notify on role change. 14. Ownership handover. 15. Fund the new agent at
    promotion. 16. Effective-dated rates. 17. **Browser + 375px verification of the
    promote screen — never done.**

### Low

18. `agents.role` honesty. 19. `fn_ensure_agent_row` stops inventing a rate.
19. Collapse the four `MemberRole` vocabularies. 21. Collapse the six wallet
    columns. 22. A dunning job for `overdue`. 23. Delete dead code.

### Optional

24. A credit ageing report. 25. Rollback rehearsal on a Supabase branch.
25. Delete `backup/roles-audit-2026-08-31`.

---

## 21. Prioritized Next-Phase Execution Plan

### Phase 0 — Recover and verify current state (~10 min)

**Objective:** know the truth before changing anything.
**Steps:** the §22 checklist.
**Completion:** you can state PR #2155's status, your branch, and that the tree
is clean.
**Risk:** other agents are active — confirm your branch before every commit.

---

### Phase 1 of 7 — Stop the wrong bills ✅ **COMPLETE**

Applied, pushed, PR #2155. Only the merge needs confirming.

---

### Phase 2 of 7 — The credit line becomes real ← **START HERE**

**Prerequisite:** B-01 answered.
**Inspect first:**
`supabase/migrations/20260831235997_promotion_assigns_rakeback_and_staff_earn_none.sql`
(the current `fn_club_set_member_role` body), and the live definitions of
`fn_create_agent`, `fn_admin_update_agent`,
`fn_agent_wallet_send_core_20260830`,
`fn_agent_wallet_claim_back_phase2_core_20260831`, and
`transfer_chips_agent_to_player` (the credit rule to port).

**Write `supabase/migrations/20260901000002_a_credit_line_is_spendable_and_staff_hold_agent_wallets.sql`:**

1. **`fn_create_agent`** — remove
   `IF v_member_role IN ('owner','co_owner','admin') THEN RETURN … 'earns no rakeback'`.
   Add: prepaid ⇒ `credit_limit` must be 0; not prepaid ⇒ limit > 0; limit ≤
   parent's. **Only call `fn_club_set_member_role` when the target is NOT staff**
   — an owner given a wallet is not an owner demoted to `'agent'`, and
   `fn_club_grantable_roles` would refuse it anyway.
2. **`fn_admin_update_agent`** — relax the staff-rate refusal to match.
3. **`fn_club_set_member_role`** — `DROP FUNCTION … (uuid,uuid,text,uuid,numeric,numeric)`
   then create with `p_is_prepaid boolean DEFAULT NULL, p_credit_limit numeric
DEFAULT NULL`. For agent roles: `COALESCE(param, existing agents row)`; if
   still NULL → `{success:false, needs_funding:true}`. Validate limit ≥ 0,
   prepaid ⇒ 0, credit ⇒ > 0, ≤ upline. Apply on INSERT **and** UPDATE. Include
   in the `audit_trail` after-state. Re-`GRANT EXECUTE` on the 8-arg signature.
4. **`fn_agent_wallet_send_core_20260830`** — when
   `agent_wallet_balance < amount`: if `is_prepaid` refuse (keep the existing
   message); else if `credit_used + shortfall > credit_limit` refuse naming both
   numbers; else debit the wallet by `amount − shortfall`, add `shortfall` to
   `credit_used`, and record `credit_drawn`, `credit_used_after`, `credit_limit`
   in the `chip_transactions` metadata and the return value (**including the
   replay branch**).
5. **`fn_agent_wallet_claim_back_phase2_core_20260831`** — repay `credit_used`
   in proportion to the claimed fraction of a send whose metadata carries
   `credit_drawn`; only the remainder becomes float.

**Client:**

- `MemberManagementPage.tsx` `RoleSection` — add a prepaid/credit control and a
  limit input beside the existing rate fields, same `.mm-roles__rates`
  treatment, nothing pre-filled, mobile-first.
- `MembershipService.updateRole` — pass the two new params through.

**Tests:** extend `tests/promotion-assigns-the-rate.law.test.ts` or add
`tests/a-credit-line-is-spendable.law.test.ts`. Reuse `codeOnly()`.

**Probe (rolled back, §11.5):** prepaid agent short → refused; credit agent
short within the line → succeeds, `credit_used` rises by the shortfall exactly;
over the line → refused; claim-back → `credit_used` falls proportionally; staff
member → agent wallet created and **club role unchanged**.

**Completion:** all of the above green; `tsc` clean; targeted tests pass; the
migration self-asserts; `node scripts/ci/check-migrations-applied.mjs origin/main`
passes; **`supabase-columns-manifest.json` updated if any column is added**.

**Risks:** `fn_agent_wallet_send` is a live money path — the highest-risk change
in the programme. `trg_agents_commission_bounds` fires BEFORE UPDATE OF
`commission_rate` and can raise on a union policy band. Two
`fn_club_set_member_role` overloads would break every caller.

**Checkpoint:** commit
`fix(credit): a credit line is spendable, and staff hold agent wallets`.

---

### Phase 3 of 7 — One money path

Rewire `ChipTransferModal` to `fn_club_bank_send` / `fn_agent_wallet_send` (copy
the pattern from `CashierPage.tsx:1450` and `WalletCashierModal.tsx`); every
send carries a **uuid** `p_op_id`. Delete `ChipFlowService.clubToAgent`,
`clubToPlayer`, `agentToPlayer`. `DROP FUNCTION transfer_chips_agent_to_player`.
**Read `tests/cashier-ui-role-scoping.test.ts` first — it already pins the
correct path and shows the shape.** Extend it to cover the modal.
**Risk:** this is the surface Dan uses to move chips; verify in a browser.

### Phase 4 of 7 — Demotion closes the books

`fn_club_set_member_role` refuses to demote out of an agent role while
`agent_wallet_balance > 0`, `credit_used > 0` or `pending_commission > 0`,
naming each. Add an explicit settle path. Repair the 11 orphaned uplines. Report
the 9 out-of-band rows to Dan. **Do not auto-rewrite terms.**

### Phase 5 of 7 — The ladder is complete, and people are told

Owner-initiated `transfer_club_ownership` (or document the platform-admin-only
path as deliberate). A notification on role change. "Fund them now?" after an
agent promotion. **Popup law: Title Case, no em dashes.**

### Phase 6 of 7 — Money is watched

`fn_club_chip_circulation` counts all five pools. `reconcile_ledger_nightly`
files a **critical** row when `credit_used` moves without an invoice, and when
pools drift. `pending_commission` payout (26,859.87 owed), or a documented
reason. **Risk:** touching reconciliation can mask a real drift — add checks,
never relax one.

### Phase 7 of 7 — Rates have a date, the data stops lying

Effective-dated rate history so `fn_rakeback_recompute_periods` prices a hand at
the rate in force **when it was dealt** — 7 settlement periods are open. Relax
`agents_role_check` or add `holder_kind`. `fn_ensure_agent_row` mints at 0.
Collapse the four `MemberRole` vocabularies and the six wallet columns.
**Risk:** the largest schema change in the programme; do it last, alone.

---

## 22. Exact First Actions For The Next Agent

```text
 1. cd /Users/smarter.poker/Documents/.agent-trees/club-arena/claude-compliance
    export PATH="/opt/homebrew/bin:$PATH"; source ~/.nvm/nvm.sh
    # Every host-terminal call needs that PATH line. gh/node/npx are not on the default PATH.

 2. Read, in this order:
      AGENT-PLAYBOOK.md
      CLAUDE.md            (10.5 horses, 10.6 animations, 11.5 money probes, 12 rebase)
      docs/HANDOFF_CURRENT_STATE.md   (this file)
      .agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md   (I did NOT read it)

 3. Confirm where things stand:
      git rev-parse --abbrev-ref HEAD     # expect agent/cowork-claude-roles/credit-and-lifecycle
      git status --porcelain              # expect empty
      git log --oneline origin/main..HEAD # expect 3 commits, or 0 if #2155 merged
      gh pr view 2155 --json state,mergeStateStatus,mergedAt
      # If BLOCKED, read the failing job:
      gh run list --repo Smarter-Poker/Smarter-Poker-Club-Arena \
        --branch agent/cowork-claude-roles/credit-and-lifecycle --limit 5 \
        --json name,status,conclusion,headSha
      # gh pr checks 403s - the local PAT has no Checks:Read. Use gh run list / gh api .../jobs.

 4. If #2155 has merged, start Phase 2 on a fresh branch off origin/main:
      git checkout -B agent/<your-name>/credit-line-spendable origin/main
      git config user.name  "Smarter-Poker"
      git config user.email "254329056+Smarter-Poker@users.noreply.github.com"
      cp -c -R ~/Documents/club-arena/node_modules ./node_modules            # if missing
      cp -c -R ~/Documents/club-arena/server/node_modules server/node_modules

 5. Ask Dan blocker B-01 (re-promotion inherits the old deal?) BEFORE writing
    Phase 2. If unavailable, implement "force a fresh choice" and flag it.

 6. Verify the Phase 2 starting state against production (read-only):
      fn_club_set_member_role must still be the 6-arg version
      fn_create_agent / fn_admin_update_agent must still contain "earns no rakeback"
      fn_agent_wallet_send_core_20260830 must NOT contain credit_used

 7. DO NOT TOUCH:
      the cowork-claude-wallets worktree (another agent, claude/phase3-final-alert-sweep)
      the cowork-claude-table worktree (17 dirty files, another agent)
      any migration named 20260831235998* (another agent's)
      MIGRATION-CHANGELOG.md (frozen)

 8. Resume at: Section 21, Phase 2 of 7. The design is written out there in full
    because the draft migration was destroyed (Section 15.1).
```

---

## 23. Acceptance Criteria

### Phase 2 is done when

- [ ] `fn_create_agent` mints an agents row for an owner or co-owner **and leaves
      their club role unchanged** (proved by a rolled-back probe).
- [ ] `fn_club_set_member_role` has exactly **one** signature, the 8-arg one, and
      refuses an agent promotion with no funding choice (`needs_funding: true`).
- [ ] Prepaid ⇒ limit 0; credit ⇒ limit > 0; limit ≤ upline. All three refused
      with a message naming the numbers.
- [ ] A credit agent whose wallet is short **completes** a send; `credit_used`
      rises by **exactly** the shortfall; the metadata carries `credit_drawn`.
- [ ] A prepaid agent whose wallet is short is still refused.
- [ ] A claim-back on a credit-funded send reduces `credit_used` proportionally.
- [ ] The promote screen collects prepaid/credit and the amount, nothing
      pre-filled, checked at **375px**.
- [ ] Every probe ran **inside a rolled-back transaction**; no production chip
      moved.
- [ ] `npx tsc --noEmit` clean, client and server.
- [ ] New law test green; no existing pin weakened. If a pin was replaced, it
      moved to the new mechanism **in the same commit**.
- [ ] `node scripts/ci/check-migrations-applied.mjs origin/main` passes, and any
      new column is in `supabase-columns-manifest.json` **in the same PR**.
- [ ] `git status` clean, nothing unpushed, PR open, **CI green** — not "local
      green".
- [ ] Changelog at `docs/changelog/YYYY-MM-DD-<slug>.md`.

### The programme is done when

- [ ] All 7 phases complete under the same bar.
- [ ] Exactly **one** money path; `ChipFlowService` hierarchy methods and
      `transfer_chips_agent_to_player` deleted.
- [ ] Chips flow **bank → agent wallet → agents and players** on every surface.
- [ ] No agent can be demoted leaving chips, debt or commission stranded.
- [ ] Reconciliation sees all five pools and `credit_used`.
- [ ] `pending_commission` is payable or documented.
- [ ] The 11 orphaned uplines and 9 out-of-band rows resolved **by decision**.
- [ ] Production verified:
      `curl -s https://smarter.poker/hub/club-arena/build-info.json` serves a
      commit containing the work.

---

## 24. Recommended Commit Strategy

| #   | Message                                                                 | Contents                                                                                                     | Tests first                                                   |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 1   | `fix(credit): a credit line is spendable, and staff hold agent wallets` | `20260901000002_*.sql`, `MemberManagementPage.tsx` + `.css`, `MembershipService.ts`, new law test            | tsc ×2; new test; targeted suite; rolled-back probe; CHECK 17 |
| 2   | `fix(cashier): the chip transfer modal spends from the agent wallet`    | `ChipTransferModal.tsx`, `ChipFlowService.ts` deletions, migration dropping `transfer_chips_agent_to_player` | `cashier-ui-role-scoping.test.ts` extended; browser check     |
| 3   | `fix(roles): a demotion settles the money before it suspends the row`   | `fn_club_set_member_role`, client refusal messaging                                                          | probe: refuse with balance / debt / commission                |
| 4   | `fix(agents): repair the eleven orphaned uplines`                       | data migration + report                                                                                      | before/after counts                                           |
| 5   | `feat(roles): a role change tells the person it happened`               | notification                                                                                                 | —                                                             |
| 6   | `feat(clubs): an owner can hand over their club`                        | handover path                                                                                                | permission probe                                              |
| 7   | `fix(money): circulation counts every pool, reconciliation sees credit` | `fn_club_chip_circulation`, `reconcile_ledger_nightly`                                                       | totals reconcile                                              |
| 8   | `feat(agents): pending commission is payable`                           | payout path                                                                                                  | rolled-back probe                                             |
| 9   | `refactor(rates): a rate applies from the day it was agreed`            | effective dating                                                                                             | settlement replay                                             |

**Never mix a migration with an unrelated client change. One phase, one PR.**

---

## 25. Final Continuation Summary

**Stopping point.** Phase 1 of 7 is complete: applied to production, committed
in three commits on `agent/cowork-claude-roles/credit-and-lifecycle`, pushed, and
open as PR #2155. The working tree is clean and nothing is unpushed. Four of six
required CI checks were green at last read — including the one that had failed —
with Client Unit Tests and CSS Beat E2E still running when the GitHub API
rate-limited.

**Work on first.** Confirm #2155's CI verdict, then Phase 2 of 7 — the credit
line becomes real. **Its migration must be rewritten from §21; the draft was
destroyed and is unrecoverable (§15.1).**

**Most important locked requirements.** Chips flow main bank → agent wallet →
agents and players. Owners and co-owners **can and should** hold agent wallets —
my block on that is still live and is the first thing Phase 2 removes. Co-owners
and admins earn **no rakeback**. Every promotion assigns rates **and**
prepaid-or-credit. Every money-path probe runs inside a transaction that is
rolled back. Horses are players. Report as "PHASE N OF 7 IS DONE… READY TO START
PHASE N+1 OF 7".

**Greatest technical risk.** `fn_agent_wallet_send_core_20260830` is a live money
path holding 6.73M chips. Phase 2 changes how it debits. Get the probe right
before the apply.

**Greatest visual risk.** The promote screen's rate fields have **never been
opened in a browser** and never checked at 375px. Phase 2 adds two more controls
to the same block. Verify visually before claiming it done.

**Greatest data-integrity risk.** The moment credit becomes drawable,
`credit_used` starts moving and **nothing watches it** —
`reconcile_ledger_nightly` does not look at it and `fn_club_chip_circulation`
sees 2 of 5 pools. Phase 6 closes that. If Phase 2 ships long before Phase 6,
borrowed chips are unwatched in the interval; consider pulling the reconciliation
check forward.

**Still requires Dan.** B-01 re-promotion inheritance (blocks Phase 2); B-02
whether owners also earn no rakeback; B-05 the 11 orphaned uplines and 9
out-of-band rate rows.

**How to continue without restarting discovery.** Everything learned is in §6
(architecture, the four money paths, the five chip pools, agent economics, the
role write path) and §16 (every defect with its evidence and its phase). §21
carries the full Phase 2 design that the lost migration contained, written out
statement by statement, so it can be rewritten without re-deriving it. §15 lists
every setback so they are not repeated — in particular: commit draft migrations
immediately, update the columns manifest whenever you add a column, never list
triggers with `string_agg`, one table lock per migration, and confirm your branch
before every commit because other agents move worktrees underneath you. Read
§22, run the six commands there, and start at §21 Phase 2.
