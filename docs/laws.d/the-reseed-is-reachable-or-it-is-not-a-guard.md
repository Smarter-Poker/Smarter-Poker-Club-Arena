# tests/the-reseed-is-reachable-or-it-is-not-a-guard.law.test.ts

`fn_bbj_reseed_main_from_backup` fires only when a payout empties main, and no
stakes tier pays more than 85%, so it cannot currently fire. The reseed stays
wired (the payout RPC accepts 100%), but the law keeps the two facts tied: if a
tier is ever set to 100 this test fails and says the reseed has become live.
