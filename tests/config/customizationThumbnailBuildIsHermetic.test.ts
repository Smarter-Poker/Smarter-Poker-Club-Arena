import { readFileSync } from 'node:fs';

describe('customization thumbnail builds are hermetic', () => {
  const generator = readFileSync('scripts/generate-customization-thumbnails.mjs', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };

  it('does not use checkout mtimes to rewrite committed thumbnails during a build', () => {
    expect(generator).toContain("const force = args.includes('--force')");
    expect(generator).toContain('if (existsSync(output) && !force)');
    expect(generator).not.toContain('statSync(output).mtimeMs >= statSync(source).mtimeMs');
  });

  it('keeps regeneration available as an explicit authoring command', () => {
    expect(packageJson.scripts?.['assets:customization-thumbnails']).toBe(
      'node scripts/generate-customization-thumbnails.mjs --force'
    );
  });
});
