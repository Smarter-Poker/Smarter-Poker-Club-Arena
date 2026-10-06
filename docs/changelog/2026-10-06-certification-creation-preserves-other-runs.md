# Certification creation preserves other runs

Starting either production verification lane previously swept every reserved
post-deploy account older than 40 minutes. The lanes use separate concurrency
groups and currently allow 65 and 76 minutes, so age could retire a still-active
account. Increasing the age would still misclassify overdue or unknown owners.

Creation now creates only its own account. Its setup-failure cleanup and both
workflow `always()` cleanup steps retain the exact owned fixture and existing
guarded database retirement. Interrupted fixtures require explicit recovery
after terminal ownership is established; a new run no longer attempts foreign
reclamation. Existing guarded recovery doors remain unchanged.

The actual creation regression reproduces foreign retirement at 44, 80 and
1,440 minutes, plus setup failure. All four fail before the change by deleting
both identities. Afterward only the newly created identity is retired. No
production accounts, financial rows, runtime engine or verification assertions
are modified by this change.

Observed incident: browser run 37402498660 created its account at 02:16 UTC.
Four audit rows were archived at 03:00:40.092365 UTC with reason
`guarded_test_account_deletion`, while live job 112085055256 provisioned at
03:00:38–41 and created its account at 03:00:40.953550. This matches the source
overlap; the archive does not independently name the caller. The old browser
run was later cancelled and its broad verdict remains unknown. This does not
claim a root cause for unrelated historical Cashier fetch errors.
