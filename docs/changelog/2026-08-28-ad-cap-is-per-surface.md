# The frequency cap counted the wrong thing, and it killed the Hub on arrival

**2026-08-28.** The World Hub ad surface shipped, deployed, and rendered
nothing. Two independently written Hub clients — this session's strip and PR
#903's rail — both showed an empty surface, while the Club Arena lobby strip
kept serving and logging normally throughout.

Neither client was at fault. The resolver was.

---

## The count had no slot in it

`fn_resolve_ads` decided whether a campaign was over its cap like this:

```sql
SELECT count(*) FROM public.ad_event e
 WHERE e.user_id = v_user AND e.ad_id = c.id
   AND e.event_type = 'impression'
   AND e.created_at > now() - interval '24 hours'
```

There is no slot in that predicate. The count was global across every surface,
while `daily_cap` is a property of **one placement on one surface**. So
impressions earned in the lobby were spent against the Hub's cap — and against
every future slot's cap.

The account that found it:

| campaign            | impressions in 24h | where             |
| ------------------- | ------------------ | ----------------- |
| `spins_jackpot`     | 36                 | all `lobby_strip` |
| `bbj_running`       | 24                 | all `lobby_strip` |
| `referral_invite`   | 19                 | all `lobby_strip` |
| `tournaments_daily` | 16                 | all `lobby_strip` |
| `diamonds_store`    | 3                  | all `lobby_strip` |

Every `hub_promotions` placement caps at 2 or 3. Every one was already over cap
before the Hub had shown a single advert.

Proved rather than inferred, by probe:

```
fn_resolve_ads('hub_promotions', null, 3)
  as postgres            3 rows     (auth.uid() null, so the cap is skipped entirely)
  as the signed-in user  0 rows
```

That gap is the whole bug.

## Why this shape matters more than this instance

It is PR #1505 in a different costume. A suppression rule whose every refusal
is an empty list is **indistinguishable from "no campaigns are running"**, so a
brand-new surface can be born permanently silent and nothing anywhere goes red.
The first Hub client to ship would have been blamed for a bug that lived in the
database.

And it compounds: every slot wired from here — `session_summary`,
`empty_state`, `table_between_hands` — would have inherited a cap that any
active player had already spent somewhere else. The system would have looked
more broken the more successful the lobby became.

## The fix, in two parts

**1. The cap counts impressions on the placement's own surface.** One
predicate, `AND e.slot = pl.slot`. A cap is a statement about how often
somebody sees a thing _in a place_; "three times in the lobby" and "twice on
the Hub" are different sentences and the database now reads them that way.

**2. Suppression became countable.** `fn_ad_cap_status(slot)` answers, for the
caller, exactly why a slot is empty: which campaigns exist on it, how many
impressions each has spent in that slot's rolling window, its cap, and whether
it is suppressed right now. An empty surface has three completely different
causes — no placements, no audience match, a spent cap — and until this they
were identical from outside.

Dan, 2026-08-28: _"if you add a cap or a hold, make it rotate, and make a
suppressed ad countable."_ The 24-hour window is rolling, so it rotates on its
own. This is the countable half, and it was the half that was missing.

The migration asserts the regression rather than describing it: it takes the
player with the most `lobby_strip` impressions in the window — the one the old
rule punished hardest — and aborts if no `hub_promotions` placement is eligible
for them.

## Verified in production, not reasoned about

Applied via the Supabase MCP, then confirmed from a browser on smarter.poker:

```
before   fn_resolve_ads('hub_promotions') as the signed-in player   0 rows
after                                                              3 rows

ad_event 170  hub_promotions  impression  spins_jackpot     03:21:41 UTC
ad_event 171  hub_promotions  impression  bbj_running       03:21:48 UTC
ad_event 172  hub_promotions  impression  diamonds_store    03:21:55 UTC
ad_event 173  hub_promotions  click       spins_jackpot     03:22:05 UTC
```

The second of five slots is live and counted. Before this, `ad_event` held 169
rows and every one of them said `lobby_strip`.

## What that click then exposed

It landed on "Unknown World - This World is Being Built". Club Arena is a
static SPA, not a Next page, so `router.push('/hub/club-arena/')` strips the
trailing slash and falls through to `pages/hub/[orbId].js`. Two of the six Hub
placements point there. Fixed in World Hub PR #907.

Worth noting how that was found: **because the click was recorded.** A promo
that lands nowhere and logs nothing is invisible. This one announced itself in
`ad_event` within seconds of happening. That is the entire argument for the
tracking this system exists to do.

## And then the lobby ad sent players to an error page

While this was being written, `ad_catalog.target_url` was changed by another
agent to carry a template:

```
bbj_running    /clubs/{clubId}/jackpot
spins_jackpot  /clubs/{clubId}/tournaments
```

with the substitution to be done by the Club Arena client. The data change went
live immediately. The client that understands it ships through Club Arena ->
World Hub -> Vercel, and had not landed. Observed in the browser at 03:32 UTC,
in the SHARK CLUB lobby:

```
ad_event id 182  click  lobby_strip  bbj_running
browser landed   /hub/club-arena/invite/%7BclubId%7D
page rendered    "Oops! Club not found or invitation expired"
```

`%7BclubId%7D` is the literal `{clubId}`. Before the change those campaigns
merely bounced a player to the club picker; for the length of that window they
showed an error page instead, so it was worse, not better.

**Migration `20260828034000` moves the substitution into the resolver**, which
is where this project's founding rule already put it. `fn_resolve_ads` is
handed `p_club_id`; it now expands `{clubId}` itself, once, for every client at
once, with no deploy. Three clients across two repos and two pipelines cannot
each be trusted to expand a template the server invented — a placeholder only
one of them understands is a literal string in the other two, and every future
slot inherits the trap.

A client that also does its own replacement finds nothing left to replace, so
this is safe to land before or after any client change.

When there is no club in context — the World Hub calls with NULL — the
placeholder cannot be honoured, so **the row is dropped rather than served**.
Handing a browser a destination we know is broken is worse than showing one
advert fewer. Nothing is lost today: every `hub_promotions` placement carries
its own override.

Verified after applying:

```
fn_resolve_ads('lobby_strip', <shark club>, 10)
  spins_jackpot  /clubs/a41434bb-.../tournaments
  bbj_running    /clubs/a41434bb-.../jackpot
  diamonds_store /cashier
  referral_invite /invite
  tournaments_daily /tournaments
```

No `{` survives in any destination the resolver will now hand out; the
migration asserts exactly that and aborts if it does.
