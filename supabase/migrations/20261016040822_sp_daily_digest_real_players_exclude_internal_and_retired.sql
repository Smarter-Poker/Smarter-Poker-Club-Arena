-- The Daily Digest's "real player" filter also excludes internal and retired
-- accounts (2026-10-16). Measured after 20261016040716: 1,596 retired
-- certification fixtures keep a scrambled auth email with no '@', 96 load-test
-- accounts sit on hydra.bot, and staff, QA, canary and probe accounts sit on
-- the owner's own domains. Real players were 46, not 1,752.
BEGIN;

CREATE OR REPLACE VIEW smarter_private.sp_real_humans WITH (security_barrier) AS
SELECT p.id, p.created_at, p.last_seen, p.phone_verified, p.is_vip, p.vip_tier,
       p.vip_expires_at, p.referred_by, p.username, u.email_confirmed_at
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
 WHERE NOT COALESCE(p.is_horse, false)
   AND NOT COALESCE(u.is_anonymous, false)
   AND p.id::text NOT LIKE '00000000-0000-0000-0000-%'
   -- a retired account's auth email is scrambled and has no '@'
   AND position('@' IN COALESCE(u.email, '')) > 0
   AND lower(u.email) !~ '(\.invalid|\.local|\.test|@horses\.smarter\.poker|@hydra\.bot|@example\.(com|org|net))$'
   -- staff, QA, canary and probe accounts live on the owner's own domains
   AND lower(u.email) !~ '@([a-z0-9-]+\.)*(smarter\.poker|pepnationlab\.com|bekavactrading\.com)$'
   AND lower(COALESCE(p.email, '')) !~ '(\.invalid|\.local|\.test|@hydra\.bot|@example\.(com|org|net))$'
   AND COALESCE(p.username, '') !~* '^(deleted-|crest_cert_|postdeploy|reels_qa|trivia_canary|codex-)'
   AND NOT EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p.id AND c.active);
REVOKE ALL ON smarter_private.sp_real_humans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON smarter_private.sp_real_humans TO service_role;

COMMIT;
