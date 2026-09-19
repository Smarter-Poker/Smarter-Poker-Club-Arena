# tests/estate-integrity-rulesets-fail-closed.law.test.ts

The estate audit fails closed whenever any branch-ruleset detail cannot be read
and validated, so an unreadable secondary ruleset can never hide an unauthorized
release gate. It must also say WHICH kind of failure it hit. Measured
2026-09-19: every branch ruleset in all seven repos had been reported as
"returned an empty or malformed detail" on every run since 2026-09-09, and the
audit had been red and unread for ten days. None of them was malformed. GitHub
hands a caller without `Administration: Read` a well formed ruleset with `rules`
and `bypass_actors` simply absent, so one message was standing for an unreadable
body, a wrong id, a changed API shape and a missing permission, which are four
different repairs. It matters which one it names, because what it could not see
was real: World Hub's `main: no rewinds` ruleset read `bypass=0` on 2026-09-08
and carries an Integration bypass actor with mode `always` today. A message that
says "malformed" sends the next reader to the API shape; a message that says the
token cannot see it sends them to the App's permissions, which is where the
answer is. The audit reports the permission case once per repo, names
`Administration: Read` and the workflow that holds the `app-id`, verifies
nothing else about that repo, and still exits nonzero.
