import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const modal = read('src/components/modals/CreateClubModal.tsx');
const service = read('src/services/ClubsService.ts');

describe('Create Club Crest Vault', () => {
  it('offers exactly ten published placeholder crests', () => {
    const catalog = modal.match(/export const DEFAULT_CLUB_LOGOS = \[([\s\S]*?)\] as const;/)?.[1];
    expect(catalog).toBeTruthy();
    const files = [...(catalog?.matchAll(/file: '([^']+)'/g) ?? [])].map((match) => match[1]);
    expect(files).toHaveLength(10);
    expect(new Set(files).size).toBe(10);
    for (const file of files) expect(existsSync(resolve(root, 'public', file))).toBe(true);
  });

  it('contains no AI generation control, service, or nested generator modal', () => {
    expect(modal).not.toMatch(
      /Generate With AI|Create Image With AI|LogoGenerator|generateClubLogo/
    );
    expect(existsSync(resolve(root, 'src/services/LogoGeneratorService.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'public/images/logo-generator-frame.png'))).toBe(false);
    expect(existsSync(resolve(root, 'public/images/logo-generator-frame.webp'))).toBe(false);
  });

  it('keeps custom upload and sends presets directly through the atomic create contract', () => {
    expect(modal).toContain('Upload A Custom Logo');
    expect(modal).toContain('optimizeClubLogo(file)');
    expect(modal).toContain('logoPreview: selectedPresetId ? null : logoPreview');
    expect(modal).toContain('logoUrl: selectedPresetId ? logoPreview : null');
    expect(service).toContain('let logoUrl: string | null = clubData.logoUrl || null');
    expect(service).toContain("supabase.rpc('fn_create_club_atomic'");
    expect(service).toContain('Custom Logo Could Not Be Uploaded. Please Try Again.');
    expect(service).toContain(
      'Club Could Not Be Created. Your Details Are Still Here. Please Try Again.'
    );
  });

  it('exposes the gallery as one labelled, keyboard-operable radio group', () => {
    expect(modal).toContain('role="radiogroup"');
    expect(modal).toContain('aria-label="Default Club Logos"');
    expect(modal).toContain('role="radio"');
    expect(modal).toContain('aria-checked={selected}');
    expect(modal).toContain('type="button"');
  });
});
