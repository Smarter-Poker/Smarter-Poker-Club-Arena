# tests/a-union-join-closure-is-promo-only-for-its-promo.law.test.ts

A union join closure counts as a promo sweep only for its promo part (2026-10-12): fn_bbj_promo_bank_check and fn_bbj_promo_facts read a bbj_promo_sweep row whose metadata reason is union_join by its bbj_promo amount, while the whole-pool fn_bbj_conservation_check still counts the whole closure as an outflow.
