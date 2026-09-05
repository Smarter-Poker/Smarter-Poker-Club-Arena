# tests/vip-is-not-a-ladder.law.test.ts

VIP is `is_vip` + `vip_tier` ('lifetime' | 'monthly') + `vip_expires_at`, resolved only by `src/utils/vipStatus.ts`. There are no bronze/silver/gold/platinum/diamond tiers, and `profiles.tier` ('Newcomer' on all 1,310 rows) may never gate an entitlement, badge or avatar ring. Nothing advertises a reward the platform does not pay.
