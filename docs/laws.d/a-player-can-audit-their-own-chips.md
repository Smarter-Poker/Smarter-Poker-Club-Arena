# tests/a-player-can-audit-their-own-chips.law.test.ts

Phase 7 of the chip-accounting programme, roadmap 9.5. `chip_ledger`'s RLS let
a player read their own legs and the only surface (the wallet page's feed)
asked for `performed_by` and `to_entity_id` only, so every chip that LEFT the
player was invisible, with no balance and nothing to check one against.
`fn_ca_chip_statement` binds scope=player to `auth.uid()` (never a parameter),
gates scope=club_treasury on `ca_can_view_club_finances`, has no horse branch,
returns both directions, and carries an audit block computed from the nightly
`ca_account_snapshots` reading (balance at reading + in - out against balance
now) with a stated status. The wallet page renders the statement; the feed that
remains asks for `from_entity_id` too; the component never reads an error as
"no movements".
