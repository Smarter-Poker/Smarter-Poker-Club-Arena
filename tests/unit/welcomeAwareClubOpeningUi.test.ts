import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const page = read('src/pages/ClubHomePage.tsx');
const wizard = read('src/components/club/ClubOpeningWizard.tsx');
const create = read('src/components/modals/CreateClubModal.tsx');
const welcome = read('src/components/club/ClubWelcomePackage.tsx');

describe('welcome-aware club opening UI', () => {
  it('uses the durable package receipt for every preloaded checklist task', () => {
    expect(page).toContain("item.slotKey === 'daily_25_freezeout_1900'");
    expect(page).toContain("welcomeHasCashSlot('classic_nlh_') || hasCashCategory('HOLDEM')");
    expect(page).toContain("welcomeHasCashSlot('classic_plo') || hasCashCategory('OMAHA')");
    expect(page).toContain("welcomeHasCashSlot('classic_flh_') || hasCashCategory('LIMIT')");
    expect(page).toContain("welcomeHasMttSchedule || tournamentKinds.includes('mtt')");
    expect(page).toContain("welcomeSpinsEnabled || tournamentKinds.includes('spin')");
    expect(page).toContain("welcomeSpinsEnabled || tournamentKinds.includes('sng')");
  });

  it('reuses package-funded BBJ and Spin principals without previewing a second debit', () => {
    expect(wizard).toContain("welcomePackage?.status === 'provisioned'");
    expect(wizard).toContain('(bbjEnabled && !packageBbjFunded ? bbjSeed : 0)');
    expect(wizard).toContain('(spinsEnabled && !packageSpinsFunded ? spinSeed : 0)');
    expect(wizard).toContain('Already Funded');
    expect(page).toContain('welcomePackage={welcomePackageState}');
  });

  it('discloses the package before create and keeps Diamond acceptance explicit', () => {
    expect(create).toContain('First-Club Opening Package');
    expect(create).toContain('Diamond Spins Still Require The Owner To Read And Accept');
    expect(create).toContain('aria-describedby="discoverable-help"');
    expect(create).toContain('aria-describedby="approval-help"');
    expect(welcome).toContain('<DiamondSpinsOwnerTerms clubId={clubId}');
    expect(welcome).toContain('onStatusChange={setDiamondAccepted}');
    expect(welcome).toContain('Acceptance Is Never Automatic');
    expect(welcome).toContain('Remove All Preloaded Games And Start From Zero');
    expect(welcome).toContain('Unused BBJ Chips');
    expect(welcome).toContain('No Chips Are Created Or Destroyed');
  });
});
