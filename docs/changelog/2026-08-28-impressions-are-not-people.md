# 65 impressions across 5 people is not 65 people

**2026-08-28.** `fn_ad_stats` counted **events**. That is the right unit for
"how often was this shown" and the wrong one for almost every question an
operator actually asks — and the two numbers can differ by an order of
magnitude with nothing on the panel saying which one you are reading.

The lobby strip logs one impression per advert per **page load**. A player who
reloads the lobby thirty times in an evening produces thirty impressions of the
same advert and is one person who has seen it. Today's own numbers:

| ad                  | slot          | impressions | viewers | views each |
| ------------------- | ------------- | ----------- | ------- | ---------- |
| `spins_jackpot`     | `lobby_strip` | 65          | **5**   | 13.0       |
| `bbj_running`       | `lobby_strip` | 44          | **5**   | 8.8        |
| `referral_invite`   | `lobby_strip` | 35          | **5**   | 7.0        |
| `tournaments_daily` | `lobby_strip` | 29          | **5**   | 5.8        |
| `diamonds_store`    | `lobby_strip` | 10          | **5**   | 2.0        |

Read as reach, 65 is a campaign doing well. It is five people, one of whom was
a test account refreshing the page. A click-through rate computed against 65
says one thing; against the people who actually saw it, something completely
different — and that second number is what decides whether a campaign lives.

Neither number is wrong. Showing only one of them, unlabelled, is.

## What this adds

`viewers` and `clickers`, **beside** the event counts rather than instead of
them. An operator wants "65 views, 5 people": the ratio between them is
frequency, and a campaign with a high one is either working hard or nagging.
That is a judgement the panel should let somebody make, not make for them.

A signed-out viewer has no `user_id` and cannot log at all — RLS demands
`user_id = auth.uid()` — so there is no anonymous bucket to explain away. Every
row already belongs to somebody.

The migration refuses to apply if any row reports more people than events. If
reach ever exceeds frequency the `DISTINCT` is on the wrong column, and every
ratio built on it is wrong in a way nobody would catch by eye.

## And the last two silent ceilings

The stats read used to carry `.limit(50000)` and report the total with complete
confidence once it passed it. That one is gone — counted in Postgres. Two of
the same shape remained, further away:

```
ad_catalog     .limit(200)
ad_placement   .limit(1000)
```

A catalog of 201 adverts, or a 1001st placement, would simply stop being
mentioned and the panel would look complete. Both reads now ask PostgREST for
an exact count and the route returns `truncated` when the list really is a
subset; the panel says "Showing Part Of The List Only: 200 Of 214 Campaigns".

The limits stay. Loading ten thousand rows into an editor helps nobody.
Presenting a partial catalog as the whole one is the part that had to go.

`null` when nothing was cut, a number only when something was — the same rule
this page already follows for everything else it prints.

## Verification

```
npx tsc --noEmit     clean
npx vitest run       504 files, 0 failures
fn_ad_stats()        viewers <= impressions on every row, asserted in the migration
```
