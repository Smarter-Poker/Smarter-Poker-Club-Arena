import { build } from 'esbuild';
export async function diamondTestFixture() {
  const result = await build({
    entryPoints: ['src/diamond-test.tsx'],
    bundle: true,
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/diamond-test-fixture',
    format: 'iife',
    metafile: true,
    define: { 'import.meta.env': '{"DEV":false,"BASE_URL":"/"}' },
    external: ['/assets/*'],
    logLevel: 'silent',
  });
  const forbidden = Object.keys(result.metafile.inputs).filter((p) =>
    /supabase|IdentityDNA|DiamondGamesService|WheelBonusEntryService|AuthContext/.test(p)
  );
  if (forbidden.length) throw new Error(`Test page connects to accounts: ${forbidden.join(',')}`);
  return {
    javascript: result.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css: result.outputFiles.find((f) => f.path.endsWith('.css')).text,
  };
}
