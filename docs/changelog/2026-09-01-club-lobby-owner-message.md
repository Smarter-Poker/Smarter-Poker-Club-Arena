# The club's message leads the lobby rail, and an owner can write it

Dan, verbatim:

> on desktop in the club arena, the 'welcome to club jaqk' thats on the bottom
> of the wallets should be at the top above the club card, and that should be
> the 'custom clickable message' for the club owners to put the days message, or
> something custom

Three separate things, and all three are in this change.

## 1. It moved

The strip was the last child of `.lobby-top__wallet`, printed as a plain `<p>`
after `<DynamicWallet>`. On a desktop rail that put it under Club Bank, Promo,
Agent, Player, Rake, BBJ and Spins, which on a short viewport is past the fold.
It is the first child of `<header className="lobby-top">` now, above the club
card, and `.lobby-top` became a flex column on desktop so the strip takes its
own row rather than pushing `.lobby-top__main` (which claims `height: 100%`)
into overflow.

## 2. It is the club's own message, not its tag line

The strip printed `club.tagline`. That column is the club's PERMANENT identity
line: it is written once in the opening wizard, it is a tracked item on the
opening checklist, and the invite page prints it. A message meant to change
every day cannot share it - rewriting the tag line each morning would keep
re-opening a checklist item and keep changing what invitees are shown.

So `clubs.lobby_message` is its own column, with `lobby_message_updated_at`
beside it. `tagline` is untouched and is still the fallback, so no club loses
the line it already wrote:

    lobby_message  ->  tagline  ->  "Welcome To <Club Name>"

## 3. It is clickable, and the click leads somewhere

`<ClubOwnerMessage>` renders a `<button>` with the same
`.lobby-top__house-welcome` class, so it draws as it always did. Tapping it
opens a panel with:

- the message **in full**, which is the reason anyone taps a one-line strip that
  ends in an ellipsis;
- for owners, co-owners, admins and managers, a textarea, a character count, a
  Save and a Clear;
- a **View Club Announcements** button through to `/clubs/:clubId/announcements`,
  the club's existing longer-form surface, so a reader who wanted more is not
  left at a dead end.

## The write path

`fn_set_club_lobby_message(p_club_id uuid, p_message text)`, SECURITY DEFINER.
The client is never handed a direct UPDATE on `clubs`: that row also carries
`chip_treasury`, `total_rake`, `level` and the rake configuration. The function
writes two columns and nothing else, checks `owner_id = auth.uid()` or
`fn_is_club_admin_uid` (the estate's existing owner/co-owner/admin/manager
test), collapses whitespace and caps at 240 characters.

Club Settings also gained a **Club Message** field in Basic Information, since
that is where an owner already manages the club. That page was already updating
the `clubs` row directly under RLS as the owner, so the column rides along with
`name`, `tagline` and `description` there, and carries the same timestamp the
RPC writes so freshness does not depend on which surface saved it.

## Migration

`supabase/migrations/20260902113000_club_lobby_owner_message.sql`, applied to
production `kuklfnapbkmacvwxktbh` as `club_lobby_owner_message` and verified:
both columns are present in `information_schema.columns`. One migration, one
`BEGIN`/`COMMIT`, one PostgREST schema reload, per the DDL policy in CLAUDE.md
section 2. Declared in `scripts/ci/schema-manifest.d/lobbydesk-msg.json` rather
than in the shared nightly manifests.

### The version was renamed after the fact

It was first written as `20260901120000_club_lobby_owner_message.sql`. Another
agent claimed the same stamp for
`20260901120000_the_seat_club_clone_is_not_an_anon_reader.sql` and landed on
`main` first, so `check-new-migration-version-collisions.mjs` refused this
branch. The file was renamed to `20260902113000`, which collides with nothing
on `origin/main` and with nothing in
`supabase_migrations.schema_migrations`. Its CONTENTS did not change and the
DDL was NOT re-run: the columns and the function already exist, and replaying
them would have bought a second ~28-second PostgREST schema reload for no new
object (CLAUDE.md section 2). The applied migration had never been written into
the ledger at all, so it was recorded there under the new version with a single
`INSERT` (DML, no schema reload):

    insert into supabase_migrations.schema_migrations (version, name)
    values ('20260902113000', 'club_lobby_owner_message');

`check-migrations-applied.mjs` never reads that ledger - it compares the
objects a changed migration DECLARES against the schema manifest, and this
migration's function and columns are declared in
`scripts/ci/schema-manifest.d/lobbydesk-msg.json`, which does not name a
version. The file stays idempotent (`ADD COLUMN IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`) so a fresh environment runs it cleanly.

## Hostile state

The cached club payload (`ca_club_cache_v3`) predates this column, so a player
arriving on a stale cache has `lobby_message === undefined`. That is the
fallback chain's first case and it renders the tag line, exactly as before,
until the live read lands. No branch anywhere requires the column to exist.

## Files

- `src/components/club/ClubOwnerMessage.tsx` / `.css` — new.
- `src/pages/ClubHomePage.tsx` — rendered at the top of the rail; the old
  paragraph after the wallets is gone; `lobby_message` added to the club type
  and to the club select.
- `src/pages/ClubHomePage.css` — the strip's rule carries the button reset, its
  margin moved below it, and desktop `.lobby-top` is a flex column.
- `src/pages/ClubSettingsPage.tsx` — the Club Message field.
- `tests/unit/clubOwnerMessage.test.ts` — new, 11 pins.
- `tests/club-lobby-premium-machine.test.ts` — one assertion pinned the strip
  BELOW the wallets, which is the arrangement Dan asked to change. Inverted in
  this same commit rather than left asserting the old rule.

## Verified

- `npx tsc --noEmit` clean.
- `npx vitest run tests/` — full client suite.
