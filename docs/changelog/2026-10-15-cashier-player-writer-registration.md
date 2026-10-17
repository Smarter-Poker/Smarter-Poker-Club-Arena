# Register The Player Wallet Writer Before Creation

The selected-wallet installer refused the new Player Wallet writer because its money-RPC registry entry was missing. The entire transaction rolled back: history, new functions and registry entry remain absent, and the previously installed routing hashes remain exact.

The still-uninstalled migration now registers this authenticated, own-balance writer before CREATE FUNCTION and refuses an existing non-approved entry. No installed migration is changed. The isolated PostgreSQL fixture includes the actual production registry predicate and DDL event trigger, with the existing registered function entries. It first reproduces the missing-registration refusal and verifies rollback, then installs the corrected migration and exercises the existing wallet, authorization, journal and concurrent-replay cases. Function bodies and all nine definition hashes are unchanged; a tenth live proof requires the approved registration.
