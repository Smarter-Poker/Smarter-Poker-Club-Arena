# Pending Approval: Legacy Rakeback Repair

**NOT APPLIED. No active migration is present. PR4252 remains draft.**

`20260911070726_legacy_rakeback_closed_period_single_payer.sql` preserves the exact prepared SQL and reserved filename. Its SHA256 is `a55e792f12040799a20fcf6d54969059efecaea3869c3aa148191fe1b083c4c7`, identical to the reviewed standalone atomic00 entrypoint. `pending-adoption.json` records its original active path, source identity and release hold.

Automatic approval review rejected the proposed production application because the broad audit/publication approval did not specifically authorize this security-definer financial SQL mutation. No application retry or alternative execution route is permitted under that rejected action. This archive is documentation of the prepared change, not a workaround for the database publication gate.

Fresh specific approval, current admission checks, normal migration reservation/application, and exact function/guard/trigger/ACL readback remain required before coordinated UI publication. Existing native and component evidence retains its documented scope; archival preservation is not production acceptance.

The former 07:07 filename is historical. The reservation script scans active migration directories, so this archive does not keep that version allocated. After specific approval, rerun `scripts/reserve-migration-version.sh` and check collisions; approval concerns the exact reviewed SQL hash, not that historical filename. Preservation uses only `backup/resume-poker-sep11/rakeback-adoption-preparation`; PR4252 stays pinned to `36938a26c0cbea9947c648f15177a9d6f768b7ab` and the reviewed UI ref stays at `92a43636e6b8da408fade162780c3d0478d73084`.
