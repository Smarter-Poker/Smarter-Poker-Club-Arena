# Weight was a queue position. It was always meant to be a share of voice.

**2026-08-28.** `fn_resolve_ads` has ordered by `weight DESC, created_at DESC`
since Phase 1. That is deterministic: the same player, on the same surface,
gets the same advert in the same position every time until a cap moves.

It did not matter while one slot showed six adverts at once — the strip
returned all six and rotated through them client-side, so the order only
decided which came first.

It matters now. `empty_state` and `session_summary` are **single-card**
surfaces: `HouseAdCard` asks for one advert. So the highest-weighted eligible
campaign won _every_ draw, and the others were invisible until it ran out of
cap — and a campaign with no cap never runs out. A player who saw the empty
lobby twice a day would see the same two campaigns, in the same order, forever.

That is not what a weight is for. Everywhere else in this industry a weight
means "this campaign should get roughly this share of the impressions", and the
admin panel offers a free-text weight box that quietly meant something else.

## What replaced it

Weighted sampling without replacement, by the exponential-key method
(Efraimidis-Spirakis A-Res):

```sql
ORDER BY random() ^ (1.0 / GREATEST(r.weight, 1)) DESC
```

A candidate with twice the weight is twice as likely to lead, and nothing is
ever locked out. One expression, no second query, no state anywhere.

Measured against production, 600 single draws from the six-campaign lobby slot:

```
ad                 weight   drawn   share of draws   share of weight
spins_jackpot        110     153        25.5%            23.7%
bbj_running          100     122        20.3%            21.5%
diamonds_store        90     122        20.3%            19.4%
referral_invite       85     105        17.5%            18.3%
tournaments_daily     80      98        16.3%            17.2%
```

Five campaigns rather than six because `vip_upsell` is `non_vip` and the probe
ran with no signed-in user. Every campaign appears; the order tracks the
weights; the noise is what 600 draws looks like.

## Two details that would have quietly undone it

**`GREATEST(weight, 1)`.** `weight` is a plain integer column with no CHECK, so
a 0 or a negative typed into the admin panel would divide by zero or invert the
ordering. A weight of 0 now means "vanishingly unlikely" rather than "crash",
which is the kinder reading of what somebody typing 0 probably meant.

**`STABLE` → `VOLATILE`.** `random()` is volatile, and a STABLE function is
allowed to be evaluated once and reused within a statement — precisely the
behaviour this change exists to remove. The clients call this through
`supabase.rpc()`, which POSTs, so a VOLATILE function is served normally; only
PostgREST's GET path requires STABLE and nothing uses it.

That one nearly bit during verification: a first distribution probe ran the
resolver inside a `generate_series` and got the same advert 600 times out of 600. The function was already VOLATILE; the _probe_ was wrong — an uncorrelated
scalar subquery is hoisted into an InitPlan and evaluated once. The rewritten
probe is the table above.

## What did not change

Every eligibility rule: audience, club scoping, flight dates, the per-surface
frequency cap, and the guard that drops a destination with an unresolved
placeholder. Only the `ORDER BY` moved. The return signature is untouched, so
no client needed redeploying.

A `CREATE OR REPLACE` is exactly where those get silently dropped, so the
migration asserts each one is still present by name, and refuses to apply if
any is missing.

## It proves it varies

The migration draws one advert from the six-campaign slot twenty times and
aborts if all twenty come back the same. A deterministic `ORDER BY` cannot pass
that.

## Verification

```
npx tsc --noEmit     clean
npx vitest run       504 files, 0 failures
600-draw probe       all five eligible campaigns, proportional to weight
```
