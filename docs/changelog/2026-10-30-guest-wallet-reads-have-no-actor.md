# Anonymous table viewers do not request a player wallet

The daily client-error cohort contained 213 failed spendable-balance reads with
the literal actor `guest`. Public table viewing uses that placeholder before
sign-in; it is not a wallet UUID. Sending it to the balance RPC could only fail.

The wallet read door now returns an explicit unauthenticated outcome with an
unknown balance before any RPC. Table funding reads and global balance sync also
stop before querying an anonymous actor. No zero balance is invented, and the
authenticated scoped read and server-side financial authorization are unchanged.

Regression checks cover guest/empty actors making no RPC and an authenticated
actor retaining the exact club/table-scoped request and returned balance.
