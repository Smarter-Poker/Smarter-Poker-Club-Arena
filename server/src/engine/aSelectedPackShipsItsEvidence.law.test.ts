/**
 * LAW: a selected Horse Brain pack ships its evidence inside the engine image.
 *
 * The engine image is built from the server tree alone, so `docs/` never
 * reaches production. A protected release selection whose qualification,
 * strength or completion record exists only under `docs/evidence/` is refused
 * `missing_evidence` on the engine and the pack silently stays in shadow while
 * every source test passes (they read the repository). This law admits every
 * committed selection, of every phase, through `releaseEvidenceReader` alone:
 * exactly the files `server/Dockerfile` copies to `/app/release-evidence/`.
 * It also refuses any shipped file that is not byte-identical to its `docs/`
 * original, so the copy the engine reads is the copy that was reviewed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  admitHorsePhase8ReleaseAuthority,
  PHASE8_PROTECTED_RELEASE_SELECTION,
  RELEASE_EVIDENCE_DIRECTORY,
  releaseEvidenceReader,
  repositoryEvidenceReader,
  type HorseAuthorityAdmission,
} from './HorseQualifiedAuthority.js';
import {
  admitHorsePhase10ReleaseAuthority,
  PHASE10_PROTECTED_RELEASE_SELECTION,
} from './HorsePhase10Authority.js';
import {
  admitHorsePhase11ReleaseAuthority,
  PHASE11_PROTECTED_RELEASE_SELECTIONS,
} from './HorsePhase11Authority.js';
import {
  admitHorsePhase12ReleaseAuthority,
  PHASE12_PROTECTED_RELEASE_SELECTIONS,
} from './HorsePhase12Authority.js';
import {
  admitHorsePhase13ReleaseAuthority,
  PHASE13_PROTECTED_RELEASE_SELECTIONS,
} from './HorsePhase13Authority.js';
import {
  admitHorsePhase14ReleaseAuthority,
  PHASE14_PROTECTED_RELEASE_SELECTIONS,
} from './HorsePhase14Authority.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const shippedRoot = `${serverRoot}${RELEASE_EVIDENCE_DIRECTORY}`;

interface CommittedSelection {
  readonly name: string;
  readonly selection: { readonly withdrawn: unknown } | null;
  readonly admit: () => HorseAuthorityAdmission;
}

const NOW = Date.now();
const keysOf = <T extends object>(record: T) => Object.keys(record) as (keyof T & string)[];

/** Every protected release selection on main, each admitted from the shipped copy alone. */
const committed: readonly CommittedSelection[] = [
  {
    name: 'phase8',
    selection: PHASE8_PROTECTED_RELEASE_SELECTION,
    admit: () =>
      admitHorsePhase8ReleaseAuthority(
        NOW,
        PHASE8_PROTECTED_RELEASE_SELECTION,
        releaseEvidenceReader
      ),
  },
  {
    name: 'phase10',
    selection: PHASE10_PROTECTED_RELEASE_SELECTION,
    admit: () =>
      admitHorsePhase10ReleaseAuthority(
        NOW,
        PHASE10_PROTECTED_RELEASE_SELECTION,
        releaseEvidenceReader
      ),
  },
  ...keysOf(PHASE11_PROTECTED_RELEASE_SELECTIONS).map((variant) => ({
    name: `phase11 ${variant}`,
    selection: PHASE11_PROTECTED_RELEASE_SELECTIONS[variant],
    admit: () =>
      admitHorsePhase11ReleaseAuthority(
        variant,
        NOW,
        PHASE11_PROTECTED_RELEASE_SELECTIONS[variant],
        releaseEvidenceReader
      ),
  })),
  ...keysOf(PHASE12_PROTECTED_RELEASE_SELECTIONS).map((variant) => ({
    name: `phase12 ${variant}`,
    selection: PHASE12_PROTECTED_RELEASE_SELECTIONS[variant],
    admit: () =>
      admitHorsePhase12ReleaseAuthority(
        variant,
        NOW,
        PHASE12_PROTECTED_RELEASE_SELECTIONS[variant],
        releaseEvidenceReader
      ),
  })),
  ...keysOf(PHASE13_PROTECTED_RELEASE_SELECTIONS).map((variant) => ({
    name: `phase13 ${variant}`,
    selection: PHASE13_PROTECTED_RELEASE_SELECTIONS[variant],
    admit: () =>
      admitHorsePhase13ReleaseAuthority(
        variant,
        NOW,
        PHASE13_PROTECTED_RELEASE_SELECTIONS[variant],
        releaseEvidenceReader
      ),
  })),
  ...Object.keys(PHASE14_PROTECTED_RELEASE_SELECTIONS).map((domain) => ({
    name: `phase14 ${domain}`,
    selection: PHASE14_PROTECTED_RELEASE_SELECTIONS[domain] ?? null,
    admit: () =>
      admitHorsePhase14ReleaseAuthority(
        domain,
        NOW,
        PHASE14_PROTECTED_RELEASE_SELECTIONS[domain] ?? null,
        releaseEvidenceReader
      ),
  })),
];

function shippedFiles(): string[] {
  if (!existsSync(shippedRoot)) return [];
  return readdirSync(shippedRoot, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f !== 'README.md' && f.endsWith('.json'));
}

describe('a selected pack ships its evidence inside the engine image', () => {
  it('the Dockerfile copies the shipped evidence directory into the image', () => {
    const dockerfile = readFileSync(`${serverRoot}Dockerfile`, 'utf8');
    expect(dockerfile).toMatch(/^COPY release-evidence\/ \.\/release-evidence\/$/m);
    expect(RELEASE_EVIDENCE_DIRECTORY).toBe('release-evidence/');
    expect(existsSync(`${shippedRoot}README.md`)).toBe(true);
  });

  it.each(committed.map((c) => [c.name, c] as const))(
    '%s: a committed, unwithdrawn selection is admitted from the shipped copy alone',
    (_name, c) => {
      if (c.selection === null || c.selection.withdrawn !== null) return;
      expect(c.admit(), c.name).toMatchObject({ status: 'admitted' });
    }
  );

  it('every shipped file is byte-identical to its docs/evidence original', () => {
    for (const file of shippedFiles()) {
      expect(file.startsWith('docs/evidence/'), file).toBe(true);
      const original = `${repoRoot}${file}`;
      expect(existsSync(original), file).toBe(true);
      expect(readFileSync(`${shippedRoot}${file}`).equals(readFileSync(original)), file).toBe(true);
    }
  });

  it('the repository reader prefers the shipped copy and the shipped reader never reads docs', () => {
    for (const file of shippedFiles())
      expect(repositoryEvidenceReader.read(file).equals(releaseEvidenceReader.read(file))).toBe(
        true
      );
    expect(() =>
      releaseEvidenceReader.read('docs/evidence/phase10/phase10-qualification-2026-10-03.json')
    ).toThrow();
    expect(
      repositoryEvidenceReader.read('docs/evidence/phase10/phase10-qualification-2026-10-03.json')
        .byteLength
    ).toBeGreaterThan(0);
  });
});
