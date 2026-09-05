# tests/law/PayoutFreezeIsHumanOnly.law.test.ts

The payout kill switch (ca_payout_freeze) is opened only by fn_ca_open_payout_freeze, which a person calls; no migration, cron or watch may insert into it (Dan 2026-09-02) As of 2026-09-05 the law carries one superseded file (Phase 6.2's automatic opener, 20260905203905) whose exemption is spent on evidence: the correcting migration (20260905224524) must exist, must re-create fn_ca_kill_switch_trip with no insert into the freeze, and must assert the same at apply time. The kill switch escalates; a person opens the freeze.
