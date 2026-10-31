# Player Management current-week fee display

Player Management already defaults to the current week. Its Simple and Advanced cards now read fees, authorized downline fees and profit/loss from the same selected-period batch response. The existing Monday-midnight America/Chicago boundary remains unchanged; Today, Month and Overall use their matching periods.

The compatible summary contract was protected-merged in PR8534 and installed as migration 20261029043300 before this client change. Exact catalog, history, permissions and bounded read-only API execution were verified. Financial writers and existing lifetime readers are unchanged.

Both modes show the selected fee period. Missing or failed period data stays pending or unavailable rather than falling back to lifetime fees. Existing period/viewer ownership and stale-response rejection carry fees with profit/loss. Existing lifetime filter/sort criteria now explicitly say Overall; their query values and the Newest default are unchanged. Preserve the common exact two-decimal fee formatter and approved layout.

Focused regression covers both modes, incomplete API responses, numeric-string cents, loading/error states, late period responses, current-week default and unchanged Overall criteria queries. The original lifetime-fee rendering failed the new regression; the restored final candidate passes92 focused checks. No real chips are spent.
