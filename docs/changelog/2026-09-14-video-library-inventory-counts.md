# The video inventory includes every row

The status route reported 1,917 total videos while its source breakdown contained only 1,000. The total used an exact count, but the breakdown selected individual rows through PostgREST and inherited its row limit.

`fn_video_library_scrape_inventory()` aggregates the total, each source, the number of sources, and unassigned rows in one database statement. Empty source names count as unassigned. The function is read-only and uses the caller's table permissions; execution is restricted to the service role.

The worker adopts this function separately and checks that the returned counts reconcile before showing a successful status response. This changes inventory reporting and does not certify video ingestion or refresh a daily execution receipt.

Validation: native PostgreSQL 17 covers an empty library, more than 1,000 rows, null/empty and unusual source names, repeat reads, concurrent uncommitted insertion, and caller permissions.
