# tests/a-profile-is-born-with-its-diamond-mirrors.law.test.ts

`profiles.diamonds` is the canonical diamond store and `user_diamonds`,
`user_diamond_balance` and `diamond_wallets` are mirrors of it. The trigger
that keeps them equal fired on UPDATE OF diamonds and not on INSERT, so a
profile only got its mirror rows the first time its balance changed - one born
with 500 and never touched had none at all, and the hourly DR10 check reported
it 94 times. The trigger fires on INSERT now, including at zero. The signup
trigger `initialize_user_diamonds` seeded `(100, 100)` into a mirror of a
balance no account held (profiles.diamonds defaults to 0; no profile in
fourteen days held a canonical 100, and the supply meter never counted it); it
reads the canonical store now, and the column default is 0 like the other two
mirrors.
