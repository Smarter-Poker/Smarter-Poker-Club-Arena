# Retention exact free-byte diagnostic

Existing retention now deletes original raw payloads, and its original journal
autovacuum completed while allocated heap size remained unchanged. Deletion
counters and vacuum timestamps do not measure reusable bytes. This change adds
only the upstream, provider-allowlisted pgstattuple 1.5 diagnostic extension in
the existing extensions schema. It does not scan production during installation,
change data, vacuum settings, role memberships, financial predicates or schedules.

The single guarded migration refuses an existing installation and unexpected
provider/version/reader authority. All nine extension-member functions retain
upstream pg_stat_scan_tables execution; PUBLIC, anon, authenticated and
service_role have no execution. Native PG17 qualification exercises the exact
migration, replay refusal, an actual NOSUPER reader, actual forbidden calls and
real heap deletion/vacuum with exact free-space increase without file shrink.
Actual TOAST is selected through the parent catalog relation. Native extension
creation uses a privileged installer; Supabase NOSUPER creation is supported by
its current allowlist and requires actual once-only installation/readback.

After root admits a finite diagnostic read, measure only explicitly selected
affected relations. pgstattuple(regclass) scans the complete physical relation
and reports free_space in bytes; pgstattuple_approx free space remains an estimate.
The scan is not an atomic snapshot of concurrent writers. Heap, catalog-linked
TOAST, index allocation, filesystem availability and provisioned disk size are
distinct measurements. Retained free bytes are usable within Postgres and do
not mean the 1,054 GB provisioned disk has shrunk. Without a paired earlier
measurement, report current reusable bytes rather than inventing a recovered
delta. No scan, installation or overall cleanup completion is claimed here.
