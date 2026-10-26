# tests/closing-a-table-closes-its-lifecycle.law.test.ts

The managed close door (`fn_close_managed_game`) wrote `status = 'closed'` without `lifecycle`, leaving every table it closed counted as a live member of its game and holding its main_index. The law pins that the door's latest definition writes `lifecycle = 'closed'` in the same UPDATE, keeps production's lane lock, seat refusal and tournament receipt, that the other cash closers write both, and that the 2026-10-24 settlement left retired clubs untouched.
