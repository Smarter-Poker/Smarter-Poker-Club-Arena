# House Ads Phase 2 — the hub_promotions slot, and the first proven click

**2026-08-28.** Club Arena side: one file, a migration that production had
already run and no repository contained. The World Hub side ships separately in
`Smarter-Poker-World-Hub`.

---

## 1. The click path is proven, in a real browser, against production

Phase 1 handed over with **131 impressions and zero clicks**, and no way to tell
whether the click path fired or nobody clicked. That is the same unanswerable
question the whole system exists to end: eleven promotional surfaces shipped in
this product and not one recorded an impression or a click.

It is answered now. Signed in to smarter.poker, in the SHARK CLUB lobby, the
HOUSE strip was tapped once:

```
ad_event id 165 · event_type 'click' · slot 'lobby_strip'
ad_key   'bbj_running' · club a41434bb-…-e8b3d65afed4
2026-08-28 02:29:52 UTC
```

Everything under it was verified rather than assumed:

- the deployed bundle production serves (`ClubHomePage-DN3jJcg8-v6.js`) contains
  `logClick` writing `event_type:"click"` into `ad_event`;
- `ad_event_event_type_check` permits `'click'`, and the RLS policy
  `ad_event_insert_own` gates on `user_id` alone, so a click is accepted on
  exactly the terms an impression is;
- `ClubHomePage.tsx` passes both `onOpen` and `onNavigate`, so the strip is a
  real button and `handleActivate` logs before it navigates.

**The zero was honest.** 131 impressions across four players is too small a
denominator for a single click to be expected. Nothing was broken; nothing had
been provable either.

## 2. A migration production had run, that no branch contained

`20260828021842_house_ads_hub_promotions` was applied to the live database at
02:18 UTC on 2026-08-28. It exists in no branch, no pull request and no
worktree: it was applied straight through the Supabase MCP and the file was
never committed. Production's schema was therefore ahead of all seven repos, and
the next author to touch `supabase/migrations/` would have met a CI failure
about a manifest they had nothing to do with.

The file is recovered here **byte for byte** from
`supabase_migrations.schema_migrations`, verified by md5 against the text the
database actually executed (`a1069c59b297db98bf22dc29197acb4e`, 7,878 bytes). It
is **not re-applied** and must not be: it is already live, and its own assertion
block would abort a second run.

What it does, for anyone reading this instead of the SQL:

- adds nullable `ad_placement.target_url`, a per-placement destination
  override. A campaign's Club Arena path (`/vip`, `/cashier`) is a 404 from the
  World Hub, so the destination is a property of where the ad ran, not only of
  the campaign. That is also the shape a real advertiser expects.
- rewrites `fn_resolve_ads` to `COALESCE(pl.target_url, c.target_url)`. Same
  eight columns, same types, so the Club Arena client needed no redeploy.
- places the six existing campaigns on `hub_promotions` with Hub-absolute
  destinations and tighter daily caps than the lobby's, because the Hub is a
  surface a player crosses repeatedly while the lobby is one they sit in.

VIP suppression stays absent, in both directions (Dan 2026-08-27: "even vips
will see ads remove that for now").

## 3. Found and not fixed here, deliberately

**Two of the six campaigns land nowhere useful.** `spins_jackpot` ("Find A
Spin") and `bbj_running` ("How It Works") both carry `target_url = '/'`, which
is the club picker. Tapping either does not take a player to a Spin or to the
jackpot; it drops them out of the club they were reading it in. That is how the
proven click above behaved. The other four resolve correctly (`/vip`,
`/cashier`, `/invite`, `/tournaments`).

It is left alone in this pass because the fix is not a one-liner and is not
mine to guess at:

- the jackpot page is club-scoped (`clubs/:clubId/jackpot`), so a static
  catalog URL cannot express it. Doing it properly means the resolver
  substituting the club it was already handed, which keeps routing server-side
  where the design requires it.
- there is no Spins page at all. The lobby's SPINS filter is local state with
  no URL parameter, so a deep link has to be built before it can be pointed at.

Both are written up for the next pass rather than half-done in this one.

## 4. Verification

```
npx tsc --noEmit                                     clean
npx vitest run tests/                                green
GITHUB_BASE_REF=main node scripts/ci/check-migrations-applied.mjs   exit 0
node scripts/ci/check-phantom-tables.mjs             0 phantoms
```

There are two manifests, and only one of them needed anything.
`supabase-schema-manifest.json` records table and function NAMES, and both
`ad_placement` and `fn_resolve_ads` were already in it. The column gate reads a
separate file, `supabase-columns-manifest.json`, and that is where
`ad_placement.target_url` was missing. CI said so precisely, which is the gate
working:

```
A MIGRATION IN THIS BRANCH DECLARES SOMETHING THE LIVE SCHEMA DOES NOT HAVE:
  supabase/migrations/20260828021842_house_ads_hub_promotions.sql
    column ad_placement.target_url
```

The one key was refreshed from `fn_columns_manifest()` — the same RPC the
generator calls — rather than regenerating all 867 tables. A wholesale
regeneration would have swept every other agent's un-manifested drift into this
pull request, which is not this change's to carry and not this reviewer's to
read.
