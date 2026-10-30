# Bind the reviewed roster-fee CI qualification

Publisher 41097956219 refused shard 16 because the complete CI workflow guard
still bound the workflow before merged #8759. That change added only the
`Roster tournament fees read only their charged window` qualification and its
`Retain roster fee window index qualification` artifact step, both on shard 4.
The qualification runs the maintained PostgreSQL 17 roster-fee window driver;
the artifact step remains `always()` with missing evidence treated as an error.

Parsing the current workflow gives SHA256
`72820dff22232cef409cbffa156ac0c4b1ae6e6fb6c49d9a0893587a114cf4ad`.
Removing only those two steps in memory reproduces the old complete-workflow pin
`756ebaa3b74445e08a3e0fb4e9408607539376c85540311e0fa9e90fda64cbd5`
exactly. Bind the reviewed current workflow. Preserve the complete-workflow hash,
all runner admission assertions and the separate native workflow pin. No CI
configuration, runner, permission, qualification or production code changes.

The maintained guard fails before this correction; the same focused guard is
required to pass afterward. Open runner-capacity work in #8771 touches this guard
separately and must preserve this already-merged qualification when integrating.
