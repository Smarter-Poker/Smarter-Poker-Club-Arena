-- READ-ONLY pre-warm for one weekly close (2026-09-28, weekly-close-scale).
-- On an instance whose uncached page reads cost ~17 ms, the close's first
-- read of a book is most of its cost. Run this in its own session right
-- before the close (after the separately committed preparation), so the close
-- transaction, which holds wallet row locks, reads a warm cache. Every
-- statement is a plain SELECT over one day of the book.
--   psql -v scope_club=<club uuid or empty> -v scope_union=<union uuid or empty> \
--        -v week_from='2026-09-21 07:00+00' -f scripts/dev/weekly-close-prewarm.sql
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
\timing on
SELECT q FROM generate_series(:'week_from'::timestamptz, :'week_from'::timestamptz+interval '6 days', interval '1 day') d,
LATERAL (VALUES
 (format($q$SELECT %1$L::date AS day,count(s.club_id) AS sources FROM public.accounting_payable_earning_sources s
    WHERE s.earned_at>=%1$L::timestamptz AND s.earned_at<%1$L::timestamptz+interval '1 day'
      AND (s.coordinator_union_id=%2$L::uuid OR (%3$L::uuid IS NOT NULL AND s.coordinator_union_id IS NULL AND s.club_id=%3$L::uuid))$q$,
   d,NULLIF(:'scope_union',''),NULLIF(:'scope_club',''))),
 (format($q$SELECT %1$L::date AS day,count(a.amount) AS commission_rows FROM (SELECT s.source_id FROM public.accounting_payable_earning_sources s
    WHERE s.earned_at>=%1$L::timestamptz AND s.earned_at<%1$L::timestamptz+interval '1 day'
      AND (s.coordinator_union_id=%2$L::uuid OR (%3$L::uuid IS NOT NULL AND s.coordinator_union_id IS NULL AND s.club_id=%3$L::uuid))
    ORDER BY s.source_id) s CROSS JOIN LATERAL (SELECT ac.amount FROM public.agent_commissions ac WHERE ac.source_id=s.source_id OFFSET 0) a$q$,
   d,NULLIF(:'scope_union',''),NULLIF(:'scope_club',''))),
 (format($q$SELECT %1$L::date AS day,count(l.amount) AS deposits FROM public.accounting_cash_bank_receipts b JOIN public.chip_ledger l ON l.id=b.club_ledger_id
    WHERE b.union_id IS NULL AND b.club_id=%2$L::uuid AND b.banked_at>=%1$L::timestamptz AND b.banked_at<%1$L::timestamptz+interval '1 day'$q$,
   d,NULLIF(:'scope_club','')))
) v(q) \gexec
