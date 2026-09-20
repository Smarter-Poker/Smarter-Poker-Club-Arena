import { build } from 'esbuild';
/**
 * The shipping standalone test entry, bundled exactly as scripts/build-diamond-test.mjs
 * ships it, so a spec plays the real DiamondTestPage rather than a copy of it.
 *
 * Built once per worker: ten tests in diamond-games-playfield.spec.ts mount this
 * page (four games times two stake kinds, plus the two phone passes), and the
 * bundle is a pair of immutable strings, so rebuilding it per test only costs
 * time. The wheel fixtures beside this one cache the same way.
 */
let bundled;
export function diamondTestFixture() {
  return (bundled ??= (async () => {
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
    // esbuild's metafile keys are paths RELATIVE to the working directory
    // ("src/stores/useUserStore.ts"), so a pattern anchored on a leading slash
    // can never match one: `/src/stores/` and `/src/contexts/` were dead
    // alternatives that let a store or a context into the wallet-free test page
    // unseen. Anchor on the start of the key or a directory boundary instead.
    const forbidden = Object.keys(result.metafile.inputs).filter((p) =>
      /supabase|IdentityDNA|DiamondGamesService|DiamondWheelService|DiamondChoiceService|DiamondBonusService|WheelBonusEntryService|AuthContext|authUtils|(^|\/)src\/stores\/|(^|\/)src\/contexts\//.test(
        p
      )
    );
    if (forbidden.length) throw new Error(`Test page connects to accounts: ${forbidden.join(',')}`);
    return {
      javascript: result.outputFiles.find((f) => f.path.endsWith('.js')).text,
      css: result.outputFiles.find((f) => f.path.endsWith('.css')).text,
    };
  })());
}
