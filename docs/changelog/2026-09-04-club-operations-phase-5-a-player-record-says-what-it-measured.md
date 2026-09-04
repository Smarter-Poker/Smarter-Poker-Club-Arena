# Club Operations Phase 5: a player record says what it measured

Phase 5 of 8 of Dan's Club Operations upgrade
(`docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`). The pages are
`/clubs/:id/members`, `/members/:userId` and `/members/:userId/statistics`,
plus the Cashier Transfer modal that Member Management opens to fund a
freshly promoted agent. The phase 5 audit in the plan doc predates a rebuild
of these pages (cursor-v2 roster, audited export, notes RPC, role RPC), so
the audit was redone against `origin/main` on 2026-09-04 and every finding
below was proved against production before it was changed. Deep Stack
Society (2a1132b9) throughout.

## What was wrong, with the numbers

**The 3-Bet percentage was not a percentage of anything.**
`ca_club_member_statistics` divided `count(three_bet)` by
`count(faced_three_bet)`. In the engine (`handFacts.ts`) `faced_three_bet`
means "we OPENED and were 3-bet", which is the denominator of fold-to-3-bet.
Over the club's five most active players the page showed 65.2%, 75.9%,
233.3%, 316.7% and 130.8%. `ca_hand_facts` has no "could have 3-bet" flag
(engine work, noted for that programme), so the honest figure available is
3-bets per hand dealt (2.4%, 2.0%, 4.5%, 4.3%, 4.0% for the same five),
labelled "3-Bet Per Hand", and Fold To 3-Bet, which the two flags measure
exactly (73.9%, 48.3%, 72.2%, 58.3%, 57.7%), is shown with its opportunity
count.

**The same number under two labels, twice.** `total_games` and
`total_hands` were both `a.hands`; `winner` was `wins`. The page drew "Total
Games", "Total Hands" and "Winner". "Club Chips" and "Player Wallet" on the
member record were the same `club_members` row read twice.

**The transfer modal could route chips to the wrong wallet.** Member
Management opens it with `recipientId` set; Confirm was enabled the moment an
amount was typed; the recipient's role, which decides `p_destination`, came
from a list that took three to four sequential reads. Unknown role fell
through to `'player_wallet'`, and `fn_club_bank_send` honours
`p_destination` (verified in its body), so "Fund Them Now" on a new agent
could credit their player wallet. The sender's role read ignored its error
and defaulted to `'member'`, which picks `fn_agent_wallet_send` over
`fn_club_bank_send` for an owner.

**Two membership gates admitted a caller with no account.** `ca_can_view_club`
and `ca_can_view_club_finances` opened with `auth.uid() IS NULL OR`. Latent
(anon holds no EXECUTE on anything that calls them) but one GRANT away from a
public roster.

**"Not found" was unreachable.** `resolveClubUUID` never returns falsy (it
hands back the slug), so the `!resolved` guards on both detail pages were
dead, a mistyped slug reached `p_club_id uuid` as 22P02 and was shown as
"The Member Ledger Did Not Respond"; a non-member userId told an owner "Your
Club Role Does Not Permit Access".

**Roster wiring.** A deep-linked financial filter was reset to All whenever
the page RPC answered before the summary RPC that carries the capabilities
(and always after a cached paint, which zeroes them). Every realtime
`CHANNEL_ERROR` scheduled a forced summary + page reload with no bound. Every
roster open advanced `member_fee_rollup`, which nothing reads (verified
against `pg_proc`: only its own refresh and backfill mention it). "0
Results" was announced to screen readers before the first page. Export
failures hid the server's reason.

**Member record wiring.** Bus events carried the route slug where every
listener filters on the uuid. "Upline Agent: None" was printed to viewers the
RPC hides the upline from. The downline list stopped at 50 with no way to
row 51. A note saved as "Bob" from a draft of "Bob " stayed "Not Saved Yet"
for ever. Range tabs had no pressed state and the previous range's figures
stayed on screen, undimmed, under a newly pressed tab.

## What changed

Migration `20260904180000_a_player_record_says_what_it_measured.sql`, one
transaction, applied and recorded:

- `ca_can_view_club`, `ca_can_view_club_finances`: internal callers named
  (`postgres`, `supabase_admin`, `service_role`); a caller with no account is
  refused. The migration asserts the old shape is gone. Verified through
  PostgREST as the real owner (true / true), anon (401), and the operations
  overview, dashboard and revenue reads still answer.
- `ca_club_member_statistics`: `three_bet` is per hand with
  `three_bet_basis: 'hands'` and `three_bets`; `fold_to_three_bet` with
  `faced_three_bets`; `cbet_opportunities`; `hands` / `hands_won` /
  `win_rate` (old keys kept one release); `authorized: false` carries
  `reason: not_member | restricted`. Same signature.

Client:

- `ChipTransferModal`: the named recipient is read directly (one indexed
  row) and Confirm stays disabled until it is known; an unknown recipient is
  a refusal, never a player-wallet send; the sender's role is null until read
  and a failed read closes the modal to sending and says so; the client float
  guard applies to the club bank only (an agent wallet may draw on a credit
  line the browser cannot see); the preview shows the wallet the chips land
  in; recipients are filtered to members who can receive; dialog role, labels
  and Escape.
- `PlayerStatisticsPage`: strict club resolution and a uuid check on the
  member; "3-Bet Per Hand", "Fold To 3-Bet (Of N)", "C-Bet (Of N)"; Hands,
  Hands Won, Win Rate; not-found from the server reason; pressed range tabs;
  figures dimmed while a range loads.
- `MemberManagementPage`: strict resolution and not-found; Cash Hands and
  MTT Hands; one Player Wallet row; upline gated like Last Login; Show N More
  on the downline; bus events with the uuid; notes adopt the persisted text;
  pressed range tabs; dimmed figures while loading.
- `ClubMembersPage`: capabilities reconciled only once the summary is fresh;
  realtime recovery bounded to two attempts; the dead rollup nudge removed;
  "Loading..." before the first page; export refusals surfaced.
- `ClubRosterService`: the new statistics keys, with fallbacks to the old.

## Verified

- Live, rolled back and then applied: the five players' 3-bet figures above;
  a non-member uuid answers `not_member` to the owner and `restricted` to a
  plain member; anon refused on every function.
- 6 mount cases on the modal
  (`tests/components/chip-transfer-modal-knows-both-ends.test.tsx`): the
  send goes to `agent_wallet` once the role is read; nothing is sent while
  it is unknown; a non-member is named and never sent to; a failed sender
  read closes the modal; an agent sender is routed through
  `fn_agent_wallet_send` and not refused client-side above its float.
- 27 pins in `tests/unit/aPlayerRecordSaysWhatItMeasured.test.ts`. Two pins
  in `tests/one-money-path.law.test.ts` moved to the new mechanism in the
  same commit (the optional-chained recipient role is exactly the defect).
- The ratchet lowered for `ChipTransferModal.tsx` (4 to 3 discarded reads).

## Still open after this phase

- A true 3-bet opportunity flag needs the engine to record "faced a single
  raise before acting"; until then the stat is per hand and says so.
- `member_fee_rollup` and its three maintainers are dead and can be dropped
  in a later DDL batch; not done here to keep the DDL small.
- The summary counts on a union roster use `= ANY(v_scope)` while the rows
  use `= p_club_id` (suspected disagreement on a union page; no union to
  measure it against today).
- The `postgres` role on Supabase cannot impersonate `authenticator`, so the
  no-account branch of the two gates is proven by shape and by PostgREST's
  refusal of anon, not by a psql probe.

## Verification pass (same day, after Dan's per-phase gate)

PR #2962 merged as `18fc9a062`; production `6f6aaa749` contains it. Re-reading
the diff found three more defects in the transfer modal, all fixed and pinned
in `chip-transfer-modal-knows-both-ends.test.tsx`:

- **A reused modal remembered the previous recipient.** The Agent Team console
  opens one modal instance for every agent it funds; a stale `'missing'`
  verdict or a stale pinned role from the last open would have decided the
  next send. Every per-recipient fact is reset when the modal opens.
- **The club owner with no `club_members` row fell to `'player'**, and
  therefore to `fn_agent_wallet_send`, the wrong debit for an owner.
  `fn_club_bank_role` treats `clubs.owner_id` as owner; the modal now does
  too, in both role reads.
- **The recipient-list role read still ignored its error** and handed an
  owner the downline-scoped list on a blip. It throws into the existing
  "Failed To Load Recipients" toast, and the pinned recipient is read before
  it so a sender-role failure still shows who the chips were for.
