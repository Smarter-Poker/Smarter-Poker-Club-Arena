# A Lifetime VIP's Rabbit Hunt reads Unlimited on every hand

2026-10-11

Dan: **"Rabbit hunts aren't unlimited even to VIP PLAYERS".**

## What is advertised

- **Lifetime VIP:** "Unlimited Rabbit Hunts With No Diamond Charge" (VIP page,
  membership plate, VIP cards modal, profile, Lifetime plan card).
- **Ordinary VIP (monthly / yearly):** 100 free a month, then 5 Diamonds each
  (Dan 2026-08-25). `vip-is-not-a-ladder` pins that number and says nothing
  else is unlimited, so this change leaves it alone.

## What production showed (read-only SQL, 2026-10-11/12)

- Dan's two accounts (`kingfish`, `mason`) are `is_vip = true`,
  `vip_tier = 'lifetime'`, `vip_expires_at = NULL`.
- `fn_consume_rabbit_hunt_v2` (the only charge path; the engine calls it,
  engine-only) takes the Lifetime branch before the monthly cap, any pack and
  any debit, and returns `unlimited: true, diamonds_spent: 0`.
- Every rabbit-hunt receipt on the platform, 28 of 28, is `lifetime_vip` with 0
  spent, and `rabbit_hunt_reveals` records 0 charged on all 30 reveals. No VIP
  has ever been charged or refused for a rabbit hunt.
- The edge logs show the felt re-reading `profiles`,
  `vip_feature_usage_monthly` and `throw_usage` from Dan's own browser on each
  offer.

So the database and the engine kept the promise. The table did not show it.

## The cause

`TablePage` mounts `<RabbitHunt>` fresh for every offer
(`hudSlotControl === 'rabbit'`). The tile opened every mount as
`isVIP = false, isLifetime = false` and then asked
`vipService.checkVIPStatus`, which is three round trips. The offer is up for
about two seconds. So on every hand a Lifetime member first saw the paid tile:
a "5" Diamond pill and "Rabbit Hunt, 5 Diamonds", which is how a player who
has run out looks. When the lookup failed, the catch kept what the tile already
knew, which on a fresh mount was "not VIP", so the price stayed up for the
whole offer.

## The fix (client only)

`src/components/table/rabbitEntitlement.ts` gives the tile a first answer that
is already known instead of "not VIP":

1. the signed-in profile's own `vip_status`, resolved by `utils/vipStatus` at
   sign-in. A Lifetime member is unconditionally free and uncapped, so this
   alone paints "Unlimited" on the first frame, and it holds while the lookup
   is pending or after it fails;
2. the last answer confirmed for the same player this session, including the
   ordinary VIP's remaining count, updated from the server's own
   `vip_remaining` after each reveal.

An ordinary VIP is not told "Free" from the profile flag alone, because 100 is
finite. Without a confirmed count they see the price until the lookup answers,
as before. A non-VIP is unchanged. Every entry is keyed by user id, so nothing
crosses an account switch, and none of it reaches the charge: the engine and
the database still decide the price.

No engine change, no migration.

## Pinned

`tests/a-lifetime-vip-rabbit-hunt-is-never-limited.law.test.tsx`
(`docs/laws.d/a-lifetime-vip-rabbit-hunt-is-never-limited.md`) pins the
database branch order, the engine's lack of any VIP opinion of its own, and
the tile reading Unlimited while its lookup is pending, after it fails and
across offers. On the previous tile the three felt cases fail.

## Left alone, noted

`fn_reveal_rabbit_hunt(uuid, bigint)` is an obsolete August path with a flat
100 cap that does not recognise Lifetime. It is still executable by
`authenticated`, but it can only reveal a row in `rabbit_hunt_offers`, which
nothing writes (0 rows). It cannot charge anyone today, so this change does
not touch it. Retiring it is a separate cleanup.
