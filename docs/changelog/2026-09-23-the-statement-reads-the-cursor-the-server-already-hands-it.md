# The statement reads the cursor the server already hands it

The chip statement's server side shipped a composite page cursor on 2026-09-14.
The client that uses it was reverted two days later. Production has been running
the new reader and the old caller ever since.

## What is live

Three migrations are on main and applied in production:

- `20260914060325_chip_statement_complete_page_cursor` - adds
  `fn_ca_chip_statement_page(text,uuid,jsonb,integer)`, which returns
  `next_cursor` as `{at, id, direction, account, club_filter}` rather than a
  bare `next_before` timestamp.
- `20260914064415_chip_statement_legacy_cursor_refusal` - keeps the original
  `fn_ca_chip_statement` signature for cached clients and makes it **refuse an
  ambiguous legacy continuation instead of guessing at a page boundary.**
- `20260914070338_chip_statement_cached_boundary_refusal` - replaces it again,
  fifty-nine minutes later, with the definition that is live now.

Confirmed against production: `fn_ca_chip_statement_page` exists, and
`fn_ca_chip_statement` is at md5 `48dd7c1b2b828579f04a45b84a6a6eee` - the
refusing version.

The first of those migrations says in its own header: _"Apply after the
component using fn_ca_chip_statement_page is verified served."_ That component
was `ChipStatement.tsx`, and `ea498c1fab` returned it to the September 13
version, which calls the legacy signature with `p_before`.

So the ordering the migration asked for was satisfied and then undone. A
player or club operator paging a statement across a boundary several legs
share gets the refusal the server was told to raise, because the caller cannot
express which of those legs it stopped at.

## Why a timestamp was never enough

A bare `next_before` names an instant. Two legs written in the same instant -
an in and an out of the same sweep, a batch that settles together - are both
"before" it and both "not before" it, and the page boundary has no way to say
which side each belongs on. Whichever way the server guesses, one of them is
either shown twice or never shown at all, and this is the ledger a player reads
to answer "where did my chips go".

The composite cursor carries `at`, `id`, `direction`, `account` and
`club_filter`, which identifies one leg exactly. The restored client passes it
back unchanged, microseconds included, and throws `Statement continuation is
missing` rather than silently dropping a page when the server says there is
more but hands back no cursor.

## Restored, with the tests that were reverted with it

`tests/unit/ChipStatement.test.tsx` and
`tests/a-player-can-audit-their-own-chips.law.test.ts` were reverted alongside
the component. Against the client that is live on main today, five of their
seventeen checks fail, including "passes the full server cursor unchanged,
including microseconds", "refuses a response that says more rows exist but
loses their cursor", and "does not fall back to timestamp pagination when the
new reader is unavailable". All seventeen pass with the component restored.
