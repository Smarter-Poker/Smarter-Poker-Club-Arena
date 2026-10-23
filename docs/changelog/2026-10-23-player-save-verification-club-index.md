# Restore The Required Club Cleanup Precheck

The fresh Player Record Save verification stopped before browser fixtures were created because the newly installed `lightning_horse_fill.club_id` foreign key lacks a full leading-column index. Add that index in a bounded migration, retaining any equivalent index that was installed meanwhile and refusing a changed FK or an invalid/partial index.

This supports the existing club-deletion regression gate and changes no rows, horse behavior, game settings, finances or permissions. The original table creation remains with PR #7846. Validate against isolated PostgreSQL, install the exact protected merged migration once, read back the durable result, then resume the failed production verification.
