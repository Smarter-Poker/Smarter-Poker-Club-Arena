# tests/the-ledger-replay-reads-only-the-legs-it-is-asked-about.law.test.ts

The nightly ledger replay reads, for each group of accounts last judged at one reading, only the legs of the entities that own them (the felt excepted), through a reader that is the full journal reader with one filter, so an idle account's old reading can no longer make the replay read weeks of the whole journal and miss its budget.
