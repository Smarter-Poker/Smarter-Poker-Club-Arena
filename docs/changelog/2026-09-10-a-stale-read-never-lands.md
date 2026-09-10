# 2026-09-10 - A Stale Read Never Lands

Swarm remediation of the 2026-09-08 client audit, findings CL-27, CL-28,
CL-29, CL-46, CL-51, CL-52, CL-53. Client only. No migration.

## One shape, seven places

An effect started asynchronous work keyed on a prop and let the answer to the
OLD key land after the key had changed, or let the work outlive the component.

- **`useClubRole` / `useIsMember`** (`src/hooks/index.ts`): switching clubs
  with a membership read in flight let the previous club's row resolve last,
  so `isAdmin`, `canManageMembers` and `canViewFinancials` described the
  wrong club. Both hooks now carry a cancellation flag and clear the old
  membership before reading the new one.
- **`PlayerNotesPanel`**: the load wrote state only inside `if (data)`, so a
  player with no saved note inherited the previous player's text, tags and
  colour, which `saveNote` then upserted against the new `target_user_id`.
  The form is reset the moment the target changes, a read that resolves after
  the target moved on is dropped, and a note that could not be read blocks
  the save button (saving would overwrite a note the player cannot see).
- **`AgentManagementPage`**: every agents load was guarded by `isMounted`
  alone; changing club mid-read landed the old club's credit limits, wallet
  balances and debt under the new club's header. Each load claims a ticket, a
  club change reissues it, and a result whose ticket is stale is dropped.
- **`RealTimeResultPanel`**: `channelRef.current` was assigned after
  `await ch.subscribe(...)` while the cleanup read the ref, so closing the
  card mid-subscribe leaked a live channel and a presence track per
  open/close on a table mounted for hours. The ref is claimed before the
  await; a subscribe completing after cancellation removes its own channel.
- **`AnimatedCounter`**: the frame id was never captured and the effect had
  no cleanup. It is captured and cancelled on change and unmount. (The
  component is currently unreferenced; fixed rather than left as a trap.)
- **`SortableTable`**: `key={rowIdx}` on a list the sort reorders. Rows key
  on their record. (Also unreferenced today.)
- **`RakeTab` (CL-46)**: fixed where the promise belongs.
  `StatsFactsService.normaliseRakeStats` coerces every numeric field of the
  rake payload against the empty shape, so a missing column is a 0 in its own
  row rather than a `TypeError` that unmounted the whole stats tab.

Law: `tests/a-stale-read-never-lands.law.test.ts` +
`docs/laws.d/a-stale-read-never-lands.md`.
