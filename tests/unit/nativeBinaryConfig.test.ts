/**
 * Store readiness: what the BINARY needs, which the readiness audit never
 * named. Every failure here is a crash or a store rejection, not a nicety:
 *
 *  - iOS terminates an app that touches the microphone, camera or photo
 *    library without a usage string in Info.plist;
 *  - Android refuses the microphone without the manifest declaration;
 *  - push and universal links do nothing without the entitlements;
 *  - App Store Connect rejects an upload with no privacy manifest;
 *  - Play refuses an unsigned bundle.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('iOS: the app can ask for what it uses, and says why', () => {
  const plist = () => read('ios/App/App/Info.plist');

  it('has a usage string for every protected resource the app actually reaches', () => {
    const p = plist();
    // src/services/VoiceSignalService.ts calls getUserMedia for table voice.
    expect(p).toContain('<key>NSMicrophoneUsageDescription</key>');
    // The avatar and club-logo pickers are <input type="file">.
    expect(p).toContain('<key>NSCameraUsageDescription</key>');
    expect(p).toContain('<key>NSPhotoLibraryUsageDescription</key>');
    // Apple reads these at review: they must name the feature, not the API.
    for (const m of p.matchAll(/<key>NS\w*UsageDescription<\/key>\s*<string>([^<]+)<\/string>/g)) {
      expect(m[1].length, m[0]).toBeGreaterThan(30);
      expect(m[1]).toContain('Club Arena');
    }
  });

  it('answers the export-compliance question so every upload does not stop and ask', () => {
    expect(plist()).toContain('<key>ITSAppUsesNonExemptEncryption</key>');
  });

  it('declares push and the universal-link domain, and the project signs with them', () => {
    const ent = read('ios/App/App/App.entitlements');
    expect(ent).toContain('<key>aps-environment</key>');
    expect(ent).toContain('applinks:smarter.poker');
    // the domain must match what the World Hub serves the AASA for
    expect(ent).not.toContain('applinks:www.smarter.poker');
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    // both build configurations, or a release archive silently drops them
    expect(pbx.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g)).toHaveLength(2);
  });

  it('ships a privacy manifest, in the app bundle, that matches the listing answers', () => {
    const x = read('ios/App/App/PrivacyInfo.xcprivacy');
    expect(x).toContain('<key>NSPrivacyTracking</key>');
    // The app does not track: no ad SDK, and analytics are consented in-app.
    expect(x).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    for (const type of [
      'NSPrivacyCollectedDataTypeEmailAddress',
      'NSPrivacyCollectedDataTypePurchaseHistory',
      'NSPrivacyCollectedDataTypeDeviceID',
      'NSPrivacyCollectedDataTypeCrashData',
    ]) {
      expect(x, type).toContain(type);
    }
    // Preferences (Capacitor) reads UserDefaults: Apple requires the reason.
    expect(x).toContain('NSPrivacyAccessedAPICategoryUserDefaults');
    // it has to be a build resource or it never reaches the bundle
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    expect(pbx).toContain('PrivacyInfo.xcprivacy in Resources');
  });
});

describe('Android: the manifest declares what the app uses, and release builds are signable', () => {
  it('declares microphone and notification permissions beside INTERNET', () => {
    const m = read('android/app/src/main/AndroidManifest.xml');
    expect(m).toContain('android.permission.RECORD_AUDIO');
    expect(m).toContain('android.permission.MODIFY_AUDIO_SETTINGS');
    expect(m).toContain('android.permission.POST_NOTIFICATIONS');
  });

  it('reads the release keystore from the environment and never from the repo', () => {
    const g = read('android/app/build.gradle');
    expect(g).toContain('System.getenv("CA_ANDROID_KEYSTORE")');
    expect(g).toContain('signingConfigs {');
    expect(g).toContain('signingConfig signingConfigs.release');
    // no password, path or alias may be literal in the file
    expect(g).not.toMatch(/storePassword\s+["']/);
    expect(g).not.toMatch(/keyPassword\s+["']/);
    // and a keystore can never be committed
    const ig = read('android/.gitignore');
    expect(ig).toMatch(/^\*\.jks$/m);
    expect(ig).toMatch(/^\*\.keystore$/m);
  });
});

describe('one command per store build', () => {
  it('both scripts exist, are wired to npm, and refuse to produce a useless artifact', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['ios:archive']).toContain('scripts/native/ios-archive.sh');
    expect(pkg.scripts['android:bundle']).toContain('scripts/native/android-bundle.sh');
    expect(existsSync(resolve(root, 'scripts/native/ios-archive.sh'))).toBe(true);

    const ios = read('scripts/native/ios-archive.sh');
    // it must build the NATIVE bundle, not the web one
    expect(ios).toContain('npm run build:native');
    expect(ios).toContain('npx cap sync ios');
    expect(ios).toContain('xcodebuild');
    // Xcode missing is the common case on this Mac: say so, do not half-run
    expect(ios).toContain('Xcode is not installed');

    const android = read('scripts/native/android-bundle.sh');
    expect(android).toContain('npm run build:native');
    expect(android).toContain('bundleRelease');
    // an unsigned bundle is rejected by Play: stop before building one
    expect(android).toContain('CA_ANDROID_KEYSTORE');
    expect(android).toMatch(/exit 1/);
    // Java 25 is the Mac default and Gradle refuses it
    expect(android).toContain('17');
    expect(android).toContain('21');
  });
});
