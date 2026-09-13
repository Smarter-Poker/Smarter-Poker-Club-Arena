# Verify the genuine Vault installation path

The native fixture build rejected Vault because its metadata check assumed a standalone `supabase_vault--0.3.1.sql`. The pinned upstream instead supplies the complete 0.3.0 base script plus its 0.3.0-to-0.3.1 update. The build now checks and records both original files, with exact upstream hashes, while keeping the control version at 0.3.1. It retains every shipped file and the complete final-image dependency checks.

No extension SQL is synthesized, concatenated, renamed or relabelled. A new native build and the separate genuine extension activation/function tests remain required.
