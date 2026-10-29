CREATE INDEX accounting_cash_receipts_scope_time_keys ON public.accounting_cash_source_receipts USING btree ((
CASE
    WHEN ((scope ->> 'kind'::text) = 'unknown'::text) THEN 'unknown'::text
    WHEN (((scope ->> 'kind'::text) = ANY (ARRAY['club'::text, 'union'::text])) AND (octet_length((scope ->> 'id'::text)) = 36)) THEN (((scope ->> 'kind'::text) || ':'::text) || (scope ->> 'id'::text))
    ELSE NULL::text
END), earned_at, id)
