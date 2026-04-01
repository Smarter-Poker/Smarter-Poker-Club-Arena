# SMARTER POKER — AGENT DEPLOYMENT GUIDE
## Last Updated: 2026-03-24

## CREDENTIALS (ACTIVE)

| Key | Value | Notes |
|-----|-------|-------|
| GitHub PAT | `<insert-your-token-locally-only>` | Full access, never expires. **DO NOT COMMIT TOKENS HERE** |
| Vercel Token | lRnRVWnwQFWcFV2ny1i5XHsa | Team deployment token |
| Vercel Org ID | team_SVD8r7AOPH065G3usBxVvrBc | Team ID |
| Hub-Vanguard Project | prj_op66GkZyZcygXQKm76iyycfVFAQx | WH — owns smarter.poker |
| Club Arena Project | prj_oaCq8RYhExLRUYizLG93li0uX468 | CA Vite SPA |
| Supabase URL | https://kuklfnapbkmacvwxktbh.supabase.co | Project ref: kuklfnapbkmacvwxktbh |
| Supabase Anon Key | eyJhbGci...ZGFrUYq7... | Role: anon |
| Supabase Service Role | (in Vercel WH env vars) | Decrypt via Vercel API |

## EXPIRED/REVOKED TOKENS (DO NOT STORE NEW TOKENS HERE)
- **WARNING:** Storing `ghp_` tokens in this file causes GitHub's Secret Scanning to immediately revoke them upon push.
- Keep tokens in a local `.env` file that is gitignored, or configure the `gh` CLI directly via `gh auth login`.

## ARCHITECTURE
- **Club Arena (CA)**: Vite+React SPA at Smarter-Poker/Smarter-Poker-Club-Arena
- **World Hub (WH)**: Next.js app at Smarter-Poker/Smarter-Poker-World-Hub
- Build pipeline: Vite build on CA → copy dist to WH public/hub/club-arena/ → push WH → Vercel auto-deploys
- CRITICAL: Two Vercel projects serve the same repo. Deployments MUST target hub-vanguard.
- Every push to WH main triggers a Vercel deployment. Last push wins.

## BUILD & DEPLOY STEPS
1. Clone CA repo, make changes, build with `npx vite build`
2. `npx tsc --noEmit` MUST pass before commit
3. Copy dist/ contents to WH public/hub/club-arena/
4. Push WH to main — Vercel auto-deploys

## DATABASE RPCs (all SECURITY DEFINER)
- `add_bbj_contribution(p_table_id, p_club_id, p_amount, p_big_blind, p_hand_number, p_stakes_tier, p_main_portion, p_backup_portion, p_promo_portion)` → JSONB
- `increment_club_rake(p_club_id, p_amount)` → VOID
- `increment_union_rake(p_union_id, p_amount)` → VOID
- `increment_agent_rake(p_agent_id, p_amount)` → VOID
- `increment_rake_generated(p_entity_id, p_entity_type, p_amount)` → VOID
- `refresh_player_stats()` → INTEGER
- `exec_sql(query)` → JSON (admin only, use service role key)

## KEY TABLE IDs
- Dan: 47965354-0e56-43ef-931c-ddaab82af765
- SHARK CLUB: a41434bb-8d0c-400a-8f0d-e8b3d65afed4
- Club JAQK: a0000000-0000-0000-0000-000000000001
- Midway Union: fade0000-0000-0000-0000-000000000001

## RULES
- Horses are regular players — never labeled as "horses" or "bots" in UI
- Horses auto-join tables when players sit and wait
- Max 4 horses per cash table (not in tournaments)
- Tables built from the union, displayed inside clubs
- Rake is NEVER fixed — formula-based per stakes tier
- Production build strips console.debug/log/info
