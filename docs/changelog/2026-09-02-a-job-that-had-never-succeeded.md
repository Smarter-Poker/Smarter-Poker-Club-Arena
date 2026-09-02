# A job that had never succeeded, failing every ninety seconds

Found by asking a question the incident board could not answer: _are any
scheduled jobs failing?_ **224 failed cron runs in six hours**, 223 of them one
job — `reconcile-tournament-denormals` — with

    ERROR: record "new" has no field "tournament_id"

## The trap

`fn_emit_managed_game_row_event` is attached to **both** `tables` and
`tournaments`, and opened with

```sql
IF TG_TABLE_NAME='tables' AND COALESCE(NEW.tournament_id,OLD.tournament_id) IS NOT NULL THEN
```

expecting `AND` to short-circuit. **It does not.** PL/pgSQL compiles the whole
condition into one SQL expression and plans every field reference in it, so
`NEW.tournament_id` is resolved even when the trigger fired on `tournaments` —
a table with no such column. The guard raised on **every** tournament UPDATE,
and the denormal reconciler had never completed a run.

The same trap bites a second way: on DELETE, `NEW` is unassigned, so
`NEW.<anything>` raises even on `tables`.

`to_jsonb(record) ->> 'key'` answers for a record missing the field and for a
record that does not exist, returning NULL either way. The sibling function
`fn_capture_managed_game_contract` already uses that idiom on the same column,
so this is the house pattern, not a new invention. The table test is nested as
well, so the field is never reached off `tables`.

## Verified live

Rolled-back probe: UPDATE on `tournaments` (the failing case), UPDATE on a cash
table, and `fn_reconcile_tournament_denormals()` all succeed.

Then production said it plainly:

| run          | result        |
| ------------ | ------------- |
| 00:28:01     | failed        |
| 00:29:01     | failed        |
| 00:30:05     | failed        |
| 00:31:00     | failed        |
| **00:32:00** | **succeeded** |

The migration landed between 00:31 and 00:32.

Worth noting that `fn_ca_cron_failure_watch` **had** filed warnings about this.
The detector was working; nobody had read it. That is the argument for the
ratchets: a count that moves is harder to ignore than a log line.
