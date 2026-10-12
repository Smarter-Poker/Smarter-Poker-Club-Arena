/**
 * The complete enabled catalogue must stay connected to animated art and
 * authored sound cues. Atlas rigs use measured specs; boxing_glove deliberately
 * uses
 * the separate knockout-flurry player and its synthesized punch sound.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { allSpecs, riggedThrowable } from '../src/throwables/registry';
import { THROWABLE_CUE_MANIFEST } from '../src/throwables/cueManifest.generated';
import { throwableLandingMs } from '../src/throwables/spec';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const catalogue = JSON.parse(read('docs/throwables/COVERAGE-CATALOGUE.json'));
const enabledIds: string[] = [...catalogue.original, ...catalogue.additional];
const rigModules = import.meta.glob<Record<string, unknown>>('../src/throwables/rigs/*.tsx', {
  eager: true,
});

describe('LAW: every enabled throwable keeps its reference animation and sound path', () => {
  it('audits all 80 picker entries, including the separately animated boxing glove', () => {
    const pickerSource = read('src/services/ThrowableService.ts');
    const pickerIds = [...pickerSource.matchAll(/\bT\(\s*'([^']+)'/g)].map((match) => match[1]);
    const specs = allSpecs();
    const specById = new Map(specs.map((spec) => [spec.id, spec]));

    expect(enabledIds).toHaveLength(80);
    expect(new Set(enabledIds).size).toBe(enabledIds.length);
    expect(new Set(pickerIds)).toEqual(new Set(enabledIds));
    expect(specs).toHaveLength(79);
    expect(specById.has('boxing_glove')).toBe(false);

    const glovePlayer = read('src/components/table/ThrowAnimation.tsx');
    const gloveSound = read('src/services/SoundService.ts');
    expect(glovePlayer).toContain("event.throwable.id === 'boxing_glove'");
    expect(glovePlayer).toMatch(/playKnockoutFlurry\(\{[\s\S]*?withCall:\s*false/);
    expect(gloveSound).toMatch(/playKnockoutFlurry\([\s\S]*?createSweptNoiseBurst/);
    expect(gloveSound).toMatch(/punchesAtMs\s*=\s*\[180, 320, 460\]/);
    expect(gloveSound).toMatch(/scheduleTone\(at,/);

    for (const id of enabledIds) {
      expect(pickerIds, id + ' is not offered by the picker').toContain(id);
      if (id === 'boxing_glove') continue;

      const spec = specById.get(id);
      expect(spec, id + ' has no measured rig spec').toBeTruthy();
      const rig = 'src/throwables/rigs/' + id;
      expect(fs.existsSync(rig + '.tsx'), id + ' has no rendered rig').toBe(true);
      expect(fs.existsSync(rig + '.css'), id + ' has no animation stylesheet').toBe(true);
      const module = rigModules['../' + rig + '.tsx'];
      const registered = riggedThrowable(id);
      expect(module, id + ' rig module is not loadable').toBeTruthy();
      const moduleRig = Object.values(module ?? {}).find(
        (candidate): candidate is { Projectile: unknown; Payload: unknown } =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'Projectile' in candidate &&
          'Payload' in candidate
      );
      expect(registered?.spec, id + ' registry spec is not the audited spec').toBe(spec);
      expect(moduleRig, id + ' rig module exports no complete renderer').toBeTruthy();
      expect(
        registered?.rig.Projectile,
        id + ' registry projectile is not exported by its rig'
      ).toBe(moduleRig?.Projectile);
      expect(registered?.rig.Payload, id + ' registry payload is not exported by its rig').toBe(
        moduleRig?.Payload
      );
      expect(spec!.beats.length, id + ' has no authored animation beats').toBeGreaterThanOrEqual(3);
      expect(spec!.audio.length, id + ' has no sound cues').toBeGreaterThan(0);

      const lastFrame =
        throwableLandingMs(spec!) + Math.max(spec!.payload.ms, spec!.residue?.ms ?? 0);
      for (const cue of spec!.audio) {
        const asset = THROWABLE_CUE_MANIFEST[cue.sample];
        expect(asset, id + ' names unknown cue ' + cue.sample).toBeTruthy();
        expect(asset!.placeholder, id + ' has placeholder cue ' + cue.sample).not.toBe(true);
        expect(cue.at, id + '/' + cue.sample + ' starts before launch').toBeGreaterThanOrEqual(0);
        expect(
          cue.at,
          id + '/' + cue.sample + ' outlasts its visible performance'
        ).toBeLessThanOrEqual(lastFrame);
        if (cue.gain !== undefined) {
          expect(cue.gain, id + '/' + cue.sample + ' has an invalid gain').toBeGreaterThan(0);
          expect(cue.gain, id + '/' + cue.sample + ' has a gain above unity').toBeLessThanOrEqual(
            1
          );
        }
        if (cue.loopUntil !== undefined) {
          expect(
            cue.loopUntil,
            id + '/' + cue.sample + ' loop ends before it starts'
          ).toBeGreaterThan(cue.at);
          expect(
            cue.loopUntil,
            id + '/' + cue.sample + ' loop outlasts its visible performance'
          ).toBeLessThanOrEqual(lastFrame);
        }
        for (const ext of ['webm', 'm4a']) {
          const file = 'public/sounds/throwables/' + cue.sample + '.' + ext;
          expect(fs.existsSync(file), id + '/' + cue.sample + ' is missing ' + ext).toBe(true);
          expect(
            fs.statSync(file).size,
            id + '/' + cue.sample + ' ' + ext + ' is empty'
          ).toBeGreaterThan(256);
        }
      }
    }
  });
});
