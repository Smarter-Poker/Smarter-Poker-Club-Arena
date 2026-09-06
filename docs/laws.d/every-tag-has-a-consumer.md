# server/src/services/EveryTagHasAConsumer.law.test.ts

Every leak tag `HorseHandReview.detectLeaks` can emit is a `tag` row in `HorseDataLedger.TAG_CONSUMERS` naming the code that reads it (a tag-list constant in HorseLogic or a gate in HorseSelfTuner that mentions the tag by name), or a `measurement` row with a written reason; no ghost rows. The nightly `fn_audit_tag_consumers` reads the same registry from `horse_data_ledger` and raises `tag_unread`. Dan, 2026-09-05: "there is absolutely no point to keep upgrading the logic of the horses if nothing reads the tags."
