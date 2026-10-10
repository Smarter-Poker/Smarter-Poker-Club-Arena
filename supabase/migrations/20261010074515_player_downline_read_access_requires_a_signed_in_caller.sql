-- Restate the verified existing downline RPC ACL explicitly. A body replace
-- preserves live grants; the static migration guard cannot infer those grants.
-- Preserve authenticated/service access and anonymous denial, without editing
-- any already-installed SQL or widening an authorization allowlist.
BEGIN;
REVOKE ALL ON FUNCTION public.ca_club_member_downline(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_downline(uuid,uuid) TO authenticated,service_role;
COMMIT;
