/* Phase 6 of the union accounting programme (2026-09-07), companion to
   20260907215753. That migration rewrote fn_union_eco_adjustment and
   fn_union_club_invoice with CREATE OR REPLACE, which PRESERVES grants, and
   asserted that neither anon nor authenticated can execute them. Both were
   already service_role only. check-definer-authorization reads grants across
   a branch's migrations rather than production, so it cannot see a preserved
   grant; this restates them in the same terms it reads. GRANT and REVOKE
   are not in pgrst_ddl_watch, so this triggers no schema reload. */
REVOKE ALL ON FUNCTION public.fn_union_eco_adjustment(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_eco_adjustment(uuid, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_club_invoice(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_invoice(uuid, timestamptz, timestamptz) TO service_role;
