# Current Contracts

These contracts are preserved while later phases move enforcement and orchestration
to server-authoritative RPCs.

## Home Action Bar

- Create sets `showCreateClubModal`.
- Find sets `showFindPlayerModal`.
- Join sets `showJoinModal`.
- Keyboard shortcuts remain `C`, `F`, and `J`.

## Create Club

- UI delegates to `ClubsService.create`.
- Input includes `name`, visibility/approval defaults, and `logoPreview`.
- Service owns the four-club limit, club row, logo upload, owner membership,
  cleanup, and `CLUB_JOINED` event.
- Club identity offers ten curated placeholder crests or a protected custom upload.

## Find Player

- Search scope is currently derived from memberships, unions, friendships, and role.
- Players search friends; elevated roles also search authorized club/union members.
- Suggestions and full search query profiles in batches.
- Active cash tables and tournament registrations are resolved separately.
- Profile and table/tournament navigation remain basename-relative SPA routes.

## Join Club

- Codes are validated through the shared `clubCode` utility.
- Full invite links are recognized during paste before input truncation.
- Numeric code resolves `clubs.club_id` to the club UUID.
- Referral codes are parked through `ClubsService.rememberInviteCode`.
- Joining delegates to `ClubsService.join`, which uses `fn_join_club`.
- Approved membership opens the club; approval-required membership remains pending.

## Deep Links

- `/invite/:clubId?ref=...` owns invitation and referral attribution.
- `/clubs-list?c=...&ref=...` pre-fills the Join dialog.
- `/?create=club` opens the Create dialog after legacy route redirects.
