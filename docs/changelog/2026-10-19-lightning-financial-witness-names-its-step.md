# The Lightning financial witness names the step it stopped at

Two private Action top-up witnesses (runs 39175638033 and 39190252076) ended
`unknown` with cause `normal_ui_or_readback_unknown`, no submitted intent and a
failed local sign-out. Production readback confirmed neither moved anything (no
pending add-on, add-on key or wallet transaction; anchor and wallet unchanged).

Two defects hid the cause. Any normal UI step that timed out was folded into
one generic cause with nothing saying which step, and the bounded session
client capped every request at "time left minus the 20-second cleanup
reserve". Once a stalled step had spent the budget, the `finally` block's local
`signOut({ scope: 'local' })` was sent with a 1 ms abort, so cleanup always
reported `unknown` as well.

The witness now records `failedStep` (the last normal step reached:
authenticate, browser, serving_before, open_table, player_terms, room_tools,
anchor, table_menu, top_up_item, addon_dialog, addon_25, addon_submit,
response) and `failure` (the error class only, never its message, which can
carry URLs or selector text). The session client's request ceiling is now the
time actually left, so cleanup gets its reserve. No action, retry, scope,
consent or money path changed. Two regressions fail before and pass after;
the 30 financial and witness operator tests pass.
