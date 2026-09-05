# A VIP throws 500 a month, and I took that off the page by mistake

2026-09-05

Same day, later. `fix/vip-is-vip-or-lifetime` removed the six-rung tier ladder
and four claims the platform did not honour. **One of the four was true.**

## What I got wrong

The VIP perks grid said **"500 Free Throws Per Month"**. I removed it after
reading `feature_pricing`:

```
feature: 'throwable'   usage_type: 'per_use'   diamond_cost: 1
vip_tiers_included: []
```

An empty `vip_tiers_included` looked conclusive next to `rabbit_hunt` and
`offline_protection`, which both list tiers. It is not conclusive, because
**that column is read by nothing** - no function, no view, no client code. I
checked exactly that for `vip_pricing` in the same sweep and did not think to
check it for the column I was leaning on.

The enforcement was `fn_use_throwable` the whole time:

```sql
v_free constant integer := 500;  -- VIP free throws per calendar month
...
IF COALESCE(v_vip, false) THEN
  SELECT count(*) INTO v_used FROM public.throw_usage
   WHERE user_id = v_uid
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC');
  IF v_used < v_free THEN ... RETURN 'paid', false ...
```

Server-side, per calendar month, counted against `throw_usage`, charging the
1-diamond price only from the 501st. Live on the board: **95 throws by 5
players, every single one of them free**.

So a real, enforced, actively used benefit was off the page for a few hours.

## What changed

- `VIP_MONTHLY_ALLOWANCES.throwables = 500`, with the enforcing function named
  beside it like the other four.
- `VIPMonthlyLimits.throwables`, and `getMonthlyUsage` now reads **two**
  sources: `vip_feature_usage_monthly` for the four features written by
  `fn_increment_vip_usage`, and a month-scoped count of `throw_usage` for this
  one, because that is where `fn_use_throwable` writes and reads it. A failed
  count reports 0 _used_, never 0 _allowed_ - a read that did not happen is not
  an exhausted allowance.
- The membership plate meters it as a fifth allowance with the rest.
- The profile's VIP tile gains a Throwables line.

## What the law says now

`tests/vip-is-not-a-ladder.law.test.ts` used to pin one direction: nothing may
advertise what the server does not do. It now pins the other as well - the five
metered allowances may not quietly shrink, each named with the function that
enforces it, so removing one means proving the enforcement is gone first.

The header records the rule this cost me: **an empty column is not an absent
feature.** The enforcement is whatever the function does.

## Still correct from the earlier pass

Re-verified across both repos before writing this:

| removed                        | still gone, and why                                            |
| ------------------------------ | -------------------------------------------------------------- |
| "+6% Score Boost"              | no scoring boost exists in Club Arena or the World Hub         |
| "All Packs" emojis             | the real allowance is 1,200 a month, now metered               |
| "Unlimited" offline protection | included, per session, which is a different claim              |
| themes 3, clubCreation 3       | display-only; the real club rule is 4 memberships for everyone |
