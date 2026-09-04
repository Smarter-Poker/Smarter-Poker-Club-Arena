# tests/law/PayoutFreezeIsHumanOnly.law.test.ts

The payout kill switch (ca_payout_freeze) is opened only by fn_ca_open_payout_freeze, which a person calls; no migration, cron or watch may insert into it (Dan 2026-09-02)
