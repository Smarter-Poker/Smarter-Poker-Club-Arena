# 2026-09-26: visible tournament catalogs read their own records

Saved tournament templates and the completed-event archive had ongoing refresh wired only to unpublished tables. The existing authenticated read path now belongs to each visible view: completed events every 30 seconds, selected standings and template catalogs every 60 seconds, plus visibility and online recovery. Requests are single-flight, abort on scope exit and fence delayed replies. Hidden documents do not schedule reads. No table was added to the WAL publication.

Template reads run only on the authorized tournament form. Updating the list never changes the unsaved configuration. A confirmed save supersedes older in-flight reads and queues one fresh read; a reply from a former club/account cannot insert a template into the new list. Existing tournament creation and template persistence commands retain their original payloads.

The archive preserves query filters, recorded payout fields, field-size ceiling, sorting and error/retry decisions. Unchanged standings retain their identity instead of replaying the entrance animation every minute. These are archive reads, not gameplay transport or payout operations. Mystery breakdown and hand-history loading retain their existing selected-event behavior.

Actual component regressions cover visibility/cadence, old account/club/event replies, failed reads, draft preservation and save/read ordering. New read-only production cases run through the existing routes directory in the protected post-deployment browser job; they require real authenticated REST responses and successor reads without writes or page reloads. Their provider result and live revision must be verified separately from local checks.
