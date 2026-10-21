# Fresh managed installer context

PR7590 installation39661044925 refused atomically: production postgres is not a superuser, and ALTER FUNCTION SET of app.money_path is privileged. History remains absent and the original seat definition remains unchanged. A fresh NOSUPERUSER regression reproduces that refusal; registering the placeholder first does not authorize ALTER either.

The same reserved, never-applied migration now captures the actual caller context inside the existing seat function, restores it immediately before all six returns, and restores it before rethrowing exceptions. Reversing only these additions exactly reproduces the original definition. No validation, lock, financial write, ACL or enforcement changes; no new helper or privilege grant. Installed SQL history is not rewritten.

The existing required native regression now runs through a fresh NOSUPERUSER postgres connection. Original seat/R3 failure-before/pass-after, caller restoration, early return, seat race, nested exception, rollback, private ACL and replay cases remain enforced.
