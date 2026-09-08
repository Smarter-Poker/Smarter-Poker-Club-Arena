/**
 * Store readiness, phase 6: the app has its artwork, and a merge reaches
 * installed phones over the air under a version the binary will accept.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('the app icon and splash come from one committed source', () => {
  it('resources/ holds the two inputs @capacitor/assets wants, at the sizes it wants', () => {
    // PNG IHDR: width and height are the 4-byte big-endian ints at 16 and 20.
    const dims = (p: string) => {
      const b = readFileSync(resolve(root, p));
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    expect(dims('resources/icon.png')).toEqual([1024, 1024]);
    expect(dims('resources/splash.png')).toEqual([2732, 2732]);
  });

  it('every generated icon and splash the stores will read is committed', () => {
    for (const p of [
      'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
      'ios/App/App/Assets.xcassets/Splash.imageset/Default@2x~universal~anyany.png',
      'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
      'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      'android/app/src/main/res/drawable-port-xxxhdpi/splash.png',
    ]) {
      expect(existsSync(resolve(root, p)), p).toBe(true);
      expect(statSync(resolve(root, p)).size, p).toBeGreaterThan(200);
    }
    // native only: the generator must not rewrite the web manifest or drop
    // PWA icons into public/ (the web bundle does not change for the app).
    expect(read('package.json')).toContain('capacitor-assets generate --ios --android');
  });
});

describe('one native version, everywhere the binary and its OTA bundles state it', () => {
  it('native.version matches iOS MARKETING_VERSION and Android versionName', () => {
    const native = read('native.version').trim();
    expect(native).toMatch(/^\d+\.\d+$/);
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    for (const m of pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)) {
      expect(m[1].trim()).toBe(native);
    }
    expect(read('android/app/build.gradle')).toMatch(
      new RegExp(`versionName "${native.replace('.', '\\.')}"`)
    );
  });

  it('the publisher uploads the app bundle to Capgo after the origin is verified, and stays green without the token', () => {
    const wf = read('.github/workflows/publish-club-arena.yml');
    const job = wf.indexOf('publish-to-app:');
    expect(job).toBeGreaterThan(wf.indexOf('publish-to-origin:'));
    const body = wf.slice(job);
    expect(body).toContain("needs.publish-to-origin.result == 'success'");
    expect(body).toContain('CAPGO_TOKEN: ${{ secrets.CAPGO_TOKEN }}');
    expect(body).toContain('run: npm run build:native');
    expect(body).toContain('@capgo/cli@latest bundle upload');
    expect(body).toContain('VERSION="${NATIVE}.${{ github.run_number }}"');
    // no second publisher: the OTA job lives inside the one publisher
    expect(wf.match(/^ {2}publish-to-origin:/gm)).toHaveLength(1);
  });
});
