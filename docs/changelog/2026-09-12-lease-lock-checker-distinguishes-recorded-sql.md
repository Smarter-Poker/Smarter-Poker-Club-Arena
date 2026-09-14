# Lease Lock Checks Distinguish Recorded SQL

The lease-lock checker now recognizes dollar-quoted JSON history as data while retaining unsafe-lock detection when a surrounding block can execute that text. Unknown type names and real SQL after line comments remain visible to the check.

The already-installed lease migration remains byte-identical. Forty-six repository regression cases cover its recorded preimage, executable locks, JSON extraction, type boundaries, and statement traversal. Historical pre-repair failure evidence remains in the independent review packet; the repository tests exercise the current checker.
