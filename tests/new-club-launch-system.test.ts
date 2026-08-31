import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20260901040000_new_club_opening_bank.sql');
const lobby = read('src/pages/ClubHomePage.tsx');
const progress = read('src/components/club/ClubLaunchProgress.tsx');
const progressCss = read('src/components/club/ClubLaunchProgress.css');

describe('new club opening bank', () => {
  it('seeds exactly 100,000 chips at the authoritative club insert boundary', () => {
    expect(migration).toContain('BEFORE INSERT ON public.clubs');
    expect(migration).toContain('NEW.chip_treasury := 100000');
    expect(migration).toContain('ALTER COLUMN chip_treasury SET DEFAULT 100000');
    expect(migration).not.toMatch(/UPDATE public\.club_members[\s\S]*100000/);
  });

  it('records the opening balance in the same transaction', () => {
    expect(migration).toContain('AFTER INSERT ON public.clubs');
    expect(migration).toContain('club_opening_grant');
    expect(migration).toContain("'destination', 'club_bank'");
    expect(migration).toContain('balance_after');
  });
});

describe('owner launch controls', () => {
  it('provides one real create action for every requested category', () => {
    for (const label of [
      'Create MTT',
      'Create NLH Table',
      'Create PLO Table',
      'Create Limit Table',
      'Create Spin',
      'Create Heads Up',
    ]) {
      expect(lobby).toContain(label);
    }
    expect(lobby).toContain("HOLDEM: 'nlh'");
    expect(lobby).toContain("OMAHA: 'plo4'");
    expect(lobby).toContain("LIMIT: 'flh'");
    expect(lobby).toContain('onClick={() => openCreationFor(gameType)}');
    expect(lobby).not.toContain(
      'club?.is_union === true && (\n          <div className="lobby-resultsbar'
    );
  });

  it('derives every checklist step from live club, table, tournament, and member data', () => {
    for (const task of [
      "id: 'identity'",
      "id: 'tagline'",
      "id: 'nlh'",
      "id: 'plo'",
      "id: 'limit'",
      "id: 'mtt'",
      "id: 'spin'",
      "id: 'heads-up'",
      "id: 'first-player'",
    ]) {
      expect(lobby).toContain(task);
    }
    expect(lobby).toContain('Number(club.member_count || 0) > 1');
    expect(lobby).toContain('classifyTournament');
  });

  it('renders an accessible, responsive, unclipped progress system', () => {
    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow={percent}');
    expect(progress).toContain('New Club Opening Checklist');
    expect(progress).toContain('Opening Club Bank');
    expect(progressCss).toContain('@media (max-width: 760px)');
    expect(progressCss).toContain('grid-template-columns: 1fr');
    expect(progressCss).not.toContain('clip-path');
  });
});
