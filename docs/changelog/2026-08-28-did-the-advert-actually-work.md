# A click is attention. It is not a result.

**2026-08-28.** Everything this system measured until now answered one question:
_did anyone look at it_. That was the point, and it was worth building —
eleven promotional surfaces shipped in this product before a single one
recorded an impression.

But it is not the question an operator acts on. `vip_upsell` has clicks. Did
anybody buy VIP? Until today the panel showed the same two numbers for a
campaign converting a third of its clicks and one converting none, and turning
the wrong one off is an easy mistake to make from a rate alone.

Every one of those outcomes was already in this database. Nothing new had to be
logged. The join simply was not made.

---

## What it measures, precisely

For each click, whether **the same player** did the thing the campaign promotes
within a window afterwards.

That is correlation inside a window. It is **not** proof the advert caused
anything — a player who was going to subscribe anyway is counted. Which is why
nothing here is called "conversions": the column is `clicks_followed_by`, the
panel says "Followed Through", and the tooltip says _correlation, not proof of
cause_. A test pins the naming, because the moment this becomes "conversions
caused by" somebody will make a budget decision on a number that does not mean
that.

## The rules

```
vip_upsell         a row in vip_subscriptions          they subscribed
diamonds_store     a COMPLETED diamond_purchases row   they paid
referral_invite    a referrals row they referred       somebody used their code
tournaments_daily  an MTT registration                 they entered a tournament
spins_jackpot      a SPIN registration                 they sat in a Spin
bbj_running        none, deliberately                  returns NULL
```

`diamond_purchases` is filtered on `completed_at IS NOT NULL` rather than on
status text. An abandoned checkout is not a purchase, and a started one is not
either.

The rules are a `CASE` in a migration, not a `conversion_sql` column. A column
would be dynamic SQL executed by a `SECURITY DEFINER` role; five hand-written
rules, auditable in a diff, cannot become an injection surface. Adding one is
then a deliberate act, which is correct — deciding what counts as success for a
campaign is a judgement, not configuration.

## The campaign with no rule

`bbj_running` promotes the Bad Beat Jackpot. Reading a jackpot page is not a
database event, and the nearest proxy — "sat at a qualifying table" — would
count nearly everybody who plays and mean nothing.

So it returns **NULL, not 0**, and the panel prints "No Outcome Defined". A
confident zero would read as _this campaign converts nobody_ when the truth is
_we have not defined what success looks like for it_. Inventing a metric to
avoid an empty cell is how a reporting system starts lying, and there is an
assertion in the migration that fails if a future edit gives `bbj_running` a
number.

## First real answer

```
ad               slot             clicks  followed  rule
bbj_running      lobby_strip        2       NULL    (none defined)
spins_jackpot    hub_promotions     1        0      They registered for a Spin
```

Two clicks that cannot be judged, and one that can and did not convert. Both of
those are more honest than the single blended "3 clicks" the panel showed an
hour ago.

## It asserts its own denominator

If the click count the function reports ever drifts from `ad_event`, the panel
is dividing by a number that is not the clicks. The migration aborts on that
rather than shipping a plausible ratio.

## Grants

`service_role` only, like `fn_ad_stats` and `fn_ad_suppression`. This one joins
`ad_event` to subscription and purchase history; `ad_event` has no select policy
precisely so one player can never read another's, and this would otherwise hand
back rather more than that.

## Verification

```
npx tsc --noEmit               clean
npx vitest run                 504 files, 0 failures
fn_ad_conversions(24)          2 rows, click total matches ad_event exactly
```

## Window

24 hours by default, and a parameter so a shorter window can be asked for
without a migration. A tighter window is a stronger claim about the advert and a
weaker count. Both are useful; neither is the truth on its own.
