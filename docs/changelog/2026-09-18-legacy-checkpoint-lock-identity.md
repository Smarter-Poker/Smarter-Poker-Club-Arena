# Legacy checkpoint lock identity

The first production checkpoint entry refused its inherited engine lock before writing an intent or opening the inspector. On the host, `/var/lock` resolves to `/run/lock`. The helper canonicalized the descriptor path but compared it with the uncanonicalized configured path, rejecting the same locked file.

Compare the descriptor and configured lock by device/inode identity instead. Keep the nonblocking lock check, immutable request binding, one-attempt intent, checkpoint guards, cleanup proof and full 285-second restart reserve unchanged. Missing descriptors and different files must still be refused.

Regression coverage exercises the actual shell admission predicate with an inherited descriptor and a symlinked lock path, plus direct-path, wrong-file and missing-descriptor cases. Source qualification and actual engine publication are recorded separately in the delivery evidence.
