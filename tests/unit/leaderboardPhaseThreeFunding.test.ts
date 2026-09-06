import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    __dirname,
    '../../supabase/migrations/20260906003717_leaderboard_phase3_funded_publication.sql'
  ),
  'utf8'
);
const wizard = readFileSync(
  join(__dirname, '../../src/components/leaderboard/LeaderboardPrizeWizard.tsx'),
  'utf8'
);
const page = readFileSync(join(__dirname, '../../src/pages/LeaderboardPage.tsx'), 'utf8');

describe('leaderboard phase three funded publication', () => {
  it('derives commitments from only the latest immutable program per club', () => {
    expect(migration).toContain('SELECT DISTINCT ON (program.club_id)');
    expect(migration).toContain('ORDER BY program.club_id, program.version DESC');
    expect(migration).toContain('latest.funding_union_id = v_union_id');
    expect(migration).toContain('latest.club_id = p_club_id');
  });

  it('locks the canonical funding wallet and rejects union-wide oversubscription', () => {
    expect(migration).toContain('leaderboard_program_funding_gate');
    expect(migration).toContain('WHERE wallet.union_id = NEW.funding_union_id');
    expect(migration).toContain('WHERE club.id = NEW.club_id');
    expect(migration.match(/FOR UPDATE;/g)?.length).toBeGreaterThanOrEqual(2);
    expect(migration).toContain('WHERE program.club_id <> NEW.club_id');
    expect(migration).toContain(
      'Leaderboard Prize Program Requires % Promo Chips But Only % Are Available After Other Published Commitments'
    );
  });

  it('keeps the funding helper and trigger outside browser reach', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_leaderboard_funding_summary(uuid)'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_enforce_leaderboard_program_funding()'
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
  });

  it('reports replacement capacity without exposing wallet telemetry to members', () => {
    expect(migration).toContain("'publication_capacity'");
    expect(migration).toContain("'other_program_commitments'");
    expect(migration).toContain("'available_uncommitted_balance'");
    expect(migration).toContain("'committed_club_count'");
    expect(migration).toContain(
      "'wallet_balance', CASE WHEN v_can_manage THEN v_funding -> 'wallet_balance' ELSE NULL END"
    );
    expect(migration).toContain("'funding_status', v_funding ->> 'funding_status'");
  });

  it('moves no chips and changes no settlement function', () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.(union_wallets|clubs)/i);
    expect(migration).not.toContain('fn_payout_leaderboard');
    expect(migration).not.toContain('fn_settle_due_leaderboards');
  });

  it('blocks review in the client and hides prize badges when funding drifts', () => {
    expect(wizard).toContain('proposedCommitment > publicationCapacity');
    expect(wizard).toContain('This Plan Cannot Be Published.');
    expect(wizard).not.toContain('The Plan Can Be Saved, But It Is Not Funded Yet.');
    expect(page).toContain("settings?.funding_status !== 'funded'");
    expect(page).toContain(
      'Planned Prize Badges Are Hidden Until The Promo Wallet Is Fully Funded.'
    );
  });
});
