# Native intake distinguishes stored excerpts and isolates failed reads

The native consumer remained subscribed, but its accepted batch waited on one
unacknowledged delivery. Its complete 2115-byte stored payload contained a
300-character suspected_cause copied from the original incident. The canonical
reader interpreted that source excerpt as transport truncation, acknowledged the
other two records, and stopped. The all-record batch barrier then stopped all
unrelated intake; 3654 unread deliveries were observed at 15:33 UTC October 29.

The read envelope now includes the stored inbox JSON length/digest. The native
prompt distinguishes source excerpts from missing tool output and requires
bounded separate/chunk reads when needed. A service-only explicit failed-read
receipt leaves read_at null, preserves the original and investigation, records
the actual reader identity/reason, and permits unrelated pending deliveries to
advance. The existing silence notification still counts failed unread records.
A later complete read can acknowledge normally; the failed-attempt record stays.
No schedule, automatic retry, incident resolution or financial write is added.

The real PostgreSQL regression reproduces the old incomplete batch barrier and
checks new length/digest, failure isolation, grants/RLS, invalid/missing/already
read IDs, duplicate deferrals and later real acknowledgement. Existing required
native/alert qualification jobs retain this protection. Publication, migration
installation and automatic intake proof remain pending until recorded.

The screenshot's orphan-running check independently names two live quarantined
MTTs: Omaha Thursday Graveyard and Midnight Free Buy (NLH), both on eed06fe5 with
mixed:physical_identity_unreadable and stale tournament lease heartbeats. Existing
active recovery ownership in chat01a184cc is preserved. This intake change does
not certify recovery of those games or bypass their hand/time-bank custody.
