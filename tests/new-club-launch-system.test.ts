import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20260901040000_new_club_opening_bank.sql');
const repairMigration = read(
  'supabase/migrations/20260901075500_repair_pre_trigger_opening_bank.sql'
);
const lobby = read('src/pages/ClubHomePage.tsx');
const progress = read('src/components/club/ClubLaunchProgress.tsx');
const progressCss = read('src/components/club/ClubLaunchProgress.css');
const machineCss = read('src/components/lobby/ClubLobbyCommandTop.css');

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

  it('repairs the one pre-trigger club and labels future opening grants as mint', () => {
    expect(repairMigration).toContain('v_club.club_id <> 11192');
    expect(repairMigration).toContain("v_club.name <> 'Deep Stack Society'");
    expect(repairMigration).toContain("'club-opening-grant:' || NEW.id::text");
    expect(repairMigration).toContain("set_config('app.ledger_counterparty', 'system_mint'");
    expect(repairMigration).toContain('COALESCE(chip_treasury, 0) = 0');
    expect(repairMigration).toContain("transaction_type = 'club_opening_grant'");
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
    expect(lobby).toContain('data-opening-checklist={showLaunchChecklist || undefined}');
    expect(machineCss).toMatch(
      /\.club-lobby-machine\[data-opening-checklist='true'\]\s*\{[\s\S]*overflow-y:\s*auto;/
    );
    expect(machineCss).toMatch(
      /\.club-lobby-machine\[data-opening-checklist='true'\]\s*>\s*\.club-launch\s*\{[\s\S]*flex:\s*0 0 auto;/
    );
  });
});
