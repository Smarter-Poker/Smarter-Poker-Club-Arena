/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW: the web bundle does not know the native app exists (2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "you need to do everything on this list, but can't break anything
 * that's currently working." Club Arena now builds for two targets from one
 * tree. The rule that keeps the web target safe is that every difference is
 * gated on ONE build constant, VITE_NATIVE=1, and that the constant is
 * compile-time so the native branches are dead code on the web.
 *
 * Pinned here:
 *   1. vite.config.ts keeps the web base '/hub/club-arena/' and dist/ unless
 *      VITE_NATIVE is set - and the native build goes to dist-native/, so it
 *      can never be published as the web bundle by mistake.
 *   2. The router basename is derived from BASE_URL in BOTH entry points; a
 *      literal basename in either one is a white screen on native.
 *   3. Capacitor plugin code is reached only through nativeShell.ts, which is
 *      imported dynamically behind IS_NATIVE_BUILD. A static import of a
 *      @capacitor/* plugin anywhere else in src/ ships native-only code to
 *      every web player and, worse, runs it there.
 *   4. build:native is the only script that sets VITE_NATIVE, and the
 *      publisher (the web) never does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('the web bundle does not know the native app exists', () => {
  it('vite.config.ts keeps the web base and web outDir unless VITE_NATIVE=1', () => {
    const vite = read('vite.config.ts');
    expect(vite).toContain("const NATIVE = process.env.VITE_NATIVE === '1';");
    expect(vite).toContain("const WEB_BASE = '/hub/club-arena/';");
    expect(vite).toContain("base: NATIVE ? '/' : WEB_BASE,");
    expect(vite).toContain("outDir: NATIVE ? 'dist-native' : 'dist',");
    expect(vite).toContain('sourcemap: !NATIVE,');
  });

  it('both entry points derive the basename instead of hardcoding it', () => {
    for (const entry of ['src/main.tsx', 'src/ClubArenaRoot.tsx']) {
      const src = read(entry);
      expect(src, `${entry} must derive its basename`).toContain('basename={ROUTER_BASENAME}');
      expect(src, `${entry} must not hardcode a basename`).not.toMatch(/basename="[^"]*"/);
    }
  });

  it('Capacitor plugins are imported only by the native shell, and only dynamically', () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const rel = file.slice(root.length + 1);
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      const staticImport =
        /^\s*import\s[^;]*from\s+['"]@(capacitor|capacitor-community|capgo)\//m.test(src);
      const dynamicImport = /import\(\s*['"]@(capacitor|capacitor-community|capgo)\//.test(src);
      if (staticImport) offenders.push(`${rel}: static import`);
      if (dynamicImport && rel !== 'src/lib/nativeShell.ts' && !rel.startsWith('src/lib/native/')) {
        offenders.push(`${rel}: dynamic import outside the native shell`);
      }
    }
    expect(offenders, 'Capacitor code must stay behind IS_NATIVE_BUILD').toEqual([]);
  });

  it('leaving the bundle goes through one seam: no window.open, no bare /auth/login, outside src/lib', () => {
    // Phase 2 (2026-09-07). Inside the app, window.open goes nowhere and
    // /auth/login is a World Hub page that is not in the bundle. Every site
    // that used to do either now calls src/lib/openExternal.ts or
    // src/lib/signIn.ts, which do the same thing on the web and the right
    // thing on native. A new bare call is a dead end for every app player.
    const opens: string[] = [];
    const logins: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const rel = file.slice(root.length + 1);
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      if (/\bwindow\.open\(/.test(src) && rel !== 'src/lib/openExternal.ts') opens.push(rel);
      if (
        /['"`]\/auth\/login/.test(src) &&
        rel !== 'src/lib/signIn.ts' &&
        rel !== 'src/lib/sessionRevoked.ts'
      ) {
        logins.push(rel);
      }
    }
    expect(opens, 'window.open outside src/lib/openExternal.ts').toEqual([]);
    expect(logins, "a literal '/auth/login' outside src/lib/signIn.ts").toEqual([]);
  });

  it('AuthGuard and AuthPage keep the player inside the app on native', () => {
    const guard = read('src/components/auth/AuthGuard.tsx');
    expect(guard).toContain('return <Navigate to={signInUrl(back)} replace />;');
    const page = read('src/pages/AuthPage.tsx');
    expect(page).toContain('} else if (!IS_NATIVE_BUILD) {');
    expect(page).toContain("emailRedirectTo: authReturnUrl('auth')");
    expect(page).toContain("redirectTo: authReturnUrl('auth?mode=update')");
    expect(page).toContain("if (event === 'PASSWORD_RECOVERY' && isMounted.current)");
  });

  it('the native shells register the clubarena:// scheme', () => {
    expect(read('ios/App/App/Info.plist')).toContain('<string>clubarena</string>');
    expect(read('android/app/src/main/AndroidManifest.xml')).toContain(
      'android:scheme="clubarena"'
    );
  });

  it('the native shell is loaded behind the compile-time constant', () => {
    const main = read('src/main.tsx');
    expect(main).toContain('if (IS_NATIVE_BUILD) {');
    expect(main).toContain("import('./lib/nativeShell')");
  });

  it('only build:native sets VITE_NATIVE, and the web publisher never does', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const setters = Object.entries(pkg.scripts).filter(([, v]) => v.includes('VITE_NATIVE=1'));
    expect(setters.map(([k]) => k)).toEqual(['build:native']);
    expect(pkg.scripts['build:native']).toContain('CA_DIST=dist-native');
    expect(read('.github/workflows/publish-club-arena.yml')).not.toContain('VITE_NATIVE');
    expect(read('.gitignore')).toMatch(/^dist-native$/m);
  });
});
