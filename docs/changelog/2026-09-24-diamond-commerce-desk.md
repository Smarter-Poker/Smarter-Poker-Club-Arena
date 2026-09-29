# 2026-09-24 - the Commerce Desk: where platform staff decide diamond refunds and run the catalog

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), sections 4.4, 6.4 and 7.3. The
server doors already existed (migrations 20260922143541 and 20260924102040):
owners could ask for a refund, but no screen let staff decide one, and the
catalog lifecycle (draft, validate, publish, retire) and comparison evidence
could only be run by calling RPCs by hand. This adds that screen.

## Route and guard

- `/commerce-desk` (`src/pages/admin/CommerceDeskPage.tsx`), a shell route
  under the shared header, behind `AuthGuard` and `PlatformStaffGuard` (the
  same guard as `/engine` and `/financial-alerts`: `profiles.role` through
  `isPlatformStaffRole`, closed if the role can't be read). Every door checks
  `fn_is_platform_admin()` again, so the guard only saves staff a failed
  request. The server doors are what actually block non-staff.
- Linked only in the hamburger's Platform Operations group, which only
  platform staff see (`src/config/clubArenaNavigation.ts`).
- It is an internal tool, so it has no painted chassis (Dan 2026-09-14). It
  follows the copy and colour rules: Title Case, no em dashes, no hover
  state, schema inks, whole diamonds.

## What staff can do

- **Refund Queue.** Filter by Requested, Approved, Owed, Refunded, Declined,
  Failed or All, oldest first. Each request shows:
  - the club or union, the payer's poker handle, the purchase line, the
    reason and the owner's details;
  - under the refund policy version: the basis, the policy amount, what the
    line paid, what was refundable at request, unused whole days, and the
    right's dates, whether it started, its state and whether it was
    sponsored.

  Approve takes an optional whole-diamond amount up to what is refundable, and
  asks for confirmation first. Decline needs a note of at least 5 characters.
  Staff can't decide a request they made or paid for: the desk says so, and
  the server refuses it too. An owed or failed request shows the wallet's
  reason in words.

- **Catalog.** Checkout and Catalog Visible switches. `settings_set` always
  leaves admission enforcement unchanged: switching it on is a separately
  recorded staff event. Each product shows:
  - its price in effect and Supported toggle. Marking a product unsupported
    also withdraws its open quotes, and the toast says how many.
  - its full version history from `fn_ca_commerce_price_versions`, newest
    first: status (a published version reads In Effect, Scheduled, Retiring
    or Ended), price, dates, who drafted and published it, comparison
    verified and price authority.
  - the one step each status allows: a draft is Validated, a validated
    version is Published now or at a later time, a published version is
    Retired now or later. A draft or validated version can also be
    Withdrawn.

  Draft New Price only offers price rules that validation will accept.

- **Comparison Evidence.** Record what a competitor charges (source, https
  link, observed price and what it buys, date, conversion note, and the
  version it supports). Every piece of evidence from
  `fn_ca_commerce_comparison_list` is listed per product with who recorded
  and who verified it. An unverified row has a Verify action against a
  validated or published version. The staff member who recorded it sees the
  refusal sentence instead, and the server refuses them too.

Every refusal code these doors can return has Title Case copy in
`DESK_REFUSAL_COPY` (`src/services/CommerceDeskService.ts`).
`tests/unit/commerceDeskService.test.ts` reads the migrations and checks this
in both directions: each code has copy, and there is no copy for a code no
door returns. It also takes the latest definition of every function across
the four commerce migrations and replays the grants in order. It pins every
RPC name and `p_` key the service sends, and every field the desk reads from
the two staff reads.

## Admission copy (20260924102056)

Once staff enforce admission, the admission doors refuse a new action with a
finished Title Case sentence from `fn_ca_commerce_admission_message`. Each
surface this client ships shows that sentence exactly as the server wrote it:

- **Joining a club** (`JoinClubModal`, `InvitePage` through
  `ClubJoinService`, door `fn_join_club`): the raised sentence is the thrown
  message the modal and the invite page print. An invite that meets a full
  club leaves the member pending; nothing is refused there.
- **An agent adds a player** (`PlayerInviteModal` through
  `AgentService.attachPlayerToAgent`, door `fn_agent_attach_player`): the
  answer carries `code: 'operating_access_required'` and the sentence in
  `error`, which the modal prints.
- **Member approval** (`fn_review_join_request`): the same shape. The only
  client call of this door is in `ClubDetailPage.tsx`, which nothing imports
  (`tests/unit/orphanModuleRatchet.test.ts`), so it ships to nobody; the
  shape is pinned for whichever client calls the door.
- **Tournament creation** (`fn_create_tournament`): `error:
'operating_access_required'` with `message`. `tournamentCreateErrorMessage`
  takes the server message for that code, and `TOURNAMENT_CREATE_ERRORS`
  holds the same sentence for an answer without one.
- **Recurring schedules** (`fn_upsert_tournament_schedule`): the same shape,
  handled the same way in `TournamentScheduleService`.
- **Cash game creation** (`fn_cash_game_create`): a RAISE with HINT
  `operating_access_required`. `cashGameCreateRefusalText` passes the sentence
  through unchanged, and `cashGamesVocabulary` has a LIVE_REFUSALS row for the
  open-table and insurance sentences.

`tests/unit/commerceDeskAdmissionCopy.test.ts` reads every sentence out of the
migration and checks each surface shows it verbatim.

## Admission tab

The fourth tab prints `fn_ca_commerce_admission_report`: whether enforcement
is off, scheduled or on; the decisions, would-refuse and refused totals for
the last 7, 30 or 90 days; each door in words ("Player Joins A Club That
Admits Automatically") with its counts; and the clubs a would-refuse fell on,
by name, with the reasons in words. Staff read what enforcement would do
before anyone switches it on. `tests/unit/commerceDeskAdmissionReport.test.tsx`
renders it from the migration's JSON shape.
