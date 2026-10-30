# Bind the runner guard to the installed additive fee qualification

Publisher 41097226301 checked protected revision636717422 and failed only the
full-workflow fingerprint in requiredCiRunnerRecovery: expected756ebaa3, actual
72820dff. Its other2,544 tests passed. PR8759 had added two required shard-4
steps after the guard's baseline: native roster tournament-fee window qualification
and its always-retained seven-day artifact. The exact diff from556718296 to
current main is15 added lines, with no removed or changed workflow command.

Update only that guard's current parsed-YAML fingerprint and retain all five
runner/recovery/qualification assertions and normalization unchanged. The workflow,
runner choices, commands, permissions, timeouts, budgets, native SQL and financial
qualifications are untouched. The separate cash branch's composed fingerprint is
different and remains owned by that task.

This removes the demonstrated current-main publication blocker through ordinary
checks and protected delivery. The wallet/Lightning verification source is already
merged in8772; its actual safe report and live release bracket remain necessary.
