/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A RIGGED THROWABLE PLAYS THE MEASURED GRAMMAR (2026-09-06, phase 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "CURRENTLY THEY ARE JUST EMOJI'S THAT DON'T DO ANYTHING, WE NEED TO ADD
 * IN THE FULL FRAME BY FRAME ANIMATION FOR EACH AND EVERY SINGLE ONE."
 *
 * Thirty-one PokerBros throws were measured at 30 fps and every one of them
 * obeys the same grammar (plan section 1.1). This law pins the MECHANISMS that
 * make it playable, so the next agent cannot quietly reintroduce the thing
 * that made the old system read as stickers: a long arc, a squash, and a stain.
 *
 * Every pin below is either a decision Dan made on 2026-09-06 (the seven
 * rulings in plan section 6) or a bug this pass actually found. If your change
 * turns one red, you are re-shipping it. Per CLAUDE.md 10.6, if you replace a
 * mechanism with a better one, MOVE THE PIN in the same commit and say so.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const PLAYER = code(read('src/components/table/ThrowablePlayer.tsx'));
const PLAYER_CSS = code(read('src/components/table/ThrowablePlayer.css'));
const CONTAINER = code(read('src/components/table/ThrowAnimation.tsx'));
const SPEC = code(read('src/throwables/spec.ts'));

describe('LAW: the flight is straight, and short', () => {
  it('translates the projectile in a LINEAR line, with no arc keyframe', () => {
    // The reference never arcs: 20-25 px per frame in a straight line, and
    // every millisecond it does not spend travelling it spends performing.
    // The legacy engine had seven physics profiles (arc, lob, spiral, swoop);
    // none of them may come back through this player.
    expect(PLAYER_CSS).toMatch(/@keyframes thr-flight[\s\S]*?translate: var\(--thr-from-x\)/);
    expect(PLAYER_CSS).toMatch(/animation: thr-flight [^;]*linear/);
    expect(PLAYER_CSS, 'an arc height would mean a parabola').not.toMatch(
      /--arc-height|arc-height/
    );
  });

  it('reads the flight time from the SPEC, never from a physics profile', () => {
    expect(PLAYER).toMatch(/spec\.flight\.ms/);
    expect(PLAYER, 'the player must not carry a physics table').not.toMatch(
      /PHYSICS|'lob'|'swoop'|'spiral'|'fastball'/
    );
  });
});

describe('LAW: the throw is one clock, at the speed the player chose', () => {
  it('reads the Animation Speed ONCE per throw', () => {
    // Read per-use, a setting changed mid-flight desynchronises a throw that
    // is already in the air. The knockout and the legacy throwables both
    // learned this; the memo is `useMemo(() => getAnimationSpeed(), [])`.
    expect(PLAYER).toMatch(/const speed = useMemo\(\(\) => getAnimationSpeed\(\), \[\]\)/);
  });

  it('multiplies every phase timer by it', () => {
    expect(PLAYER).toMatch(/setTimeout\(fn, Math\.max\(0, ms \* speed\)\)/);
  });

  it('scales every duration in the player stylesheet by the same variable', () => {
    const decls = PLAYER_CSS.match(/animation:\s*[^;]+;/g) || [];
    expect(decls.length).toBeGreaterThan(3);
    for (const d of decls) {
      if (/animation:\s*none/.test(d)) continue;
      expect(d, `'${d.trim()}' does not scale`).toMatch(/var\(--animation-speed/);
    }
  });

  it('hands the same speed to the sound, on the AudioContext clock', () => {
    // Not four setTimeouts: a main thread laying out a table drifts a timer by
    // tens of milliseconds and the priority window then eats the late arrival.
    expect(PLAYER).toMatch(/scheduleCues\(audio, \{[\s\S]*?speed,/);
    const SOUND = code(read('src/services/ThrowableSoundService.ts'));
    expect(SOUND).toMatch(/src\.start\(Math\.max\(startAt, now\)\)/);
    expect(SOUND).toMatch(/const t0 = ctx\.currentTime/);
  });
});

describe('LAW: a throwable never moves the seat (Dan, ruling 6)', () => {
  it('the player neither flinches a seat nor shakes a table', () => {
    // The reference never moves the avatar; everything happens in the overlay.
    // A throw lands while a hand is live, and the target's cards, stack and
    // action badge must not move under it. The KNOCKOUT keeps its flinch,
    // which is a different event: a seat really is changing.
    expect(PLAYER, 'the throwable player must not flinch a seat').not.toMatch(
      /seat--throw-flinch|seat--ko-flinch/
    );
    expect(PLAYER, 'the throwable player must not shake a table').not.toMatch(/--shake/);
  });

  it('never eats a click', () => {
    expect(PLAYER_CSS).toMatch(/\.thr \{[^}]*pointer-events: none/);
  });
});

describe('LAW: the payload is measured in AVATAR UNITS, on this table', () => {
  it('measures the unit off the target seat, scoped to this table', () => {
    // A bare document.querySelector hits the first matching seat in DOM order,
    // which in a multi-table view is somebody else's table. ThrowAnimation and
    // SeatKnockout both learned this the hard way.
    expect(PLAYER).toMatch(/closest\('\.table-page'\)/);
    expect(PLAYER).toMatch(/\[data-seat-num="\$\{seatNumber\}"\] \.seat__avatar/);
  });

  it('falls back to a sane unit rather than drawing at zero', () => {
    expect(PLAYER).toMatch(/return 84;/);
  });
});

describe('LAW: a paid throw is never silent and never invisible', () => {
  it('keeps throwable failures out of external telemetry, as Dan requested', () => {
    // Dan explicitly removed throwable Sentry reporting on 2026-09-07.
    // The completion path and local cue counters are still required below.
    const paths = [
      'src/components/table/ThrowablePlayer.tsx',
      'src/components/table/ThrowAnimation.tsx',
      'src/services/ThrowableService.ts',
      'src/services/ThrowableSoundService.ts',
      'src/services/ThrowableVoice.ts',
      'src/services/ThrowableCutout.ts',
      'src/components/table/ThrowableImage.tsx',
      'src/components/table/ThrowableSelector.tsx',
    ];
    for (const file of paths) {
      expect(code(read(file)), file).not.toMatch(
        /reportError|captureException|captureMessage|addBreadcrumb|SentryInit|@sentry\//
      );
    }
  });

  it('completes even when it cannot draw, so the parent never leaks it', () => {
    expect(PLAYER).toMatch(/onCompleteRef\.current\(\)/);
  });

  it('a cue with no file falls back to the legacy recipe and is COUNTED', () => {
    const SOUND = code(read('src/services/ThrowableSoundService.ts'));
    expect(SOUND).toMatch(/cuePlaceholdersPlayed \+= 1/);
    expect(SOUND).toMatch(/get placeholderCuesPlayed/);
    expect(PLAYER).toMatch(/playPlaceholder/);
  });

  it('a cue that produces NO sound names a reason, and never returns silently', () => {
    // THE GAP THIS PINS (found by the phase 1 verification pass): a scheduled
    // cue has three ways to make no sound and none of them throws - the file
    // 404s or fails to decode, a one-shot decodes more than a beat late, or a
    // loop's window is already behind the clock. All three were a bare
    // `return`, so "the cues are fine" and "every file is missing" were the
    // same observation. CLAUDE.md 10.86 rule 1: could-not-play is its own
    // outcome and must have a name.
    const SOUND = code(read('src/services/ThrowableSoundService.ts'));
    expect(SOUND).toMatch(
      /export type CueDropReason =[\s\S]*?'no_buffer'[\s\S]*?'late'[\s\S]*?'window_passed'/
    );
    expect(SOUND).toMatch(/get droppedCues\(\)/);
    for (const reason of ['no_buffer', 'late', 'window_passed']) {
      expect(SOUND, `the '${reason}' path must count, not return silently`).toMatch(
        new RegExp(`return this\\.dropCue\\('${reason}'\\)`)
      );
    }
    expect(SOUND).toMatch(/this\.cueDrops\[reason\] \+= 1/);
    expect(SOUND).not.toMatch(/cueDropReported|AnimationLaw\.throw_cue_silent/);
  });
});

describe('LAW: a rig names nothing it does not draw', () => {
  const rigDir = path.join(process.cwd(), 'src/throwables/rigs');
  const ids = fs
    .readdirSync(rigDir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''));

  it('has a rig to check', () => {
    expect(ids.length).toBeGreaterThanOrEqual(11);
  });

  it('every class a rig writes has a rule in that rig stylesheet', () => {
    // THE HOLE THIS CLOSES. `tests/unit/classNamesResolve.test.ts` only reads
    // SINGLE-class attributes - its regex is `className="one-name"` - so
    // `className="thr-beer thr-beer--proj"` was invisible to it. Twenty-one
    // `--proj` / `--payload` modifiers accumulated across eleven rigs that no
    // stylesheet defined and nothing selected: the PLAYER puts its own
    // `thr__proj` / `thr__payload` on the wrapper div, so the rig-level ones
    // named nothing at all. Phase 1 found eight of these by hand; this is the
    // check that means nobody has to.
    const offenders: string[] = [];
    for (const id of ids) {
      const tsx = fs.readFileSync(path.join(rigDir, `${id}.tsx`), 'utf8');
      const css = code(fs.readFileSync(path.join(rigDir, `${id}.css`), 'utf8'));
      const defined = new Set([...css.matchAll(/\.(thr[a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
      for (const m of tsx.matchAll(/className="([^"{}]+)"/g)) {
        for (const name of m[1].split(/\s+/).filter(Boolean)) {
          if (!defined.has(name)) offenders.push(`${id}.tsx -> ${name}`);
        }
      }
    }
    expect(offenders, `a class with no rule draws nothing and hides a missing animation`).toEqual(
      []
    );
  });

  it('a measured position is never on the same element as an animated transform', () => {
    // A CSS `transform` in a keyframe REPLACES the SVG `transform` ATTRIBUTE on
    // the same element - it does not compose with it. So
    //
    //   <g className="thr-cake__berry" transform="translate(2 -46)">
    //
    // with `@keyframes thr-cake-berry { 0% { transform: scale(0.6) } }` throws
    // the translate away the instant the animation starts, and the element
    // renders at the SVG ORIGIN. The strawberry that was measured at the crown
    // of the head drew in the middle of the face, and the darkroom is what
    // caught it.
    //
    // It was never one rig. The same shape was in EIGHT places across five:
    // cake's berry, dice's hand, horseshoe's bob / rays / label, snowman's
    // plume, and BOTH trophy sparkles - which is worse than a wrong offset,
    // because two glints measured at different points on the cup collapsed
    // onto each other and read as one.
    //
    // The fix is the pattern rose.tsx already used deliberately: the measured
    // position goes on a PLAIN WRAPPER, the animation goes on the child. This
    // is the check that keeps it that way.
    const offenders: string[] = [];
    for (const id of ids) {
      const tsx = fs.readFileSync(path.join(rigDir, `${id}.tsx`), 'utf8');
      const css = fs.readFileSync(path.join(rigDir, `${id}.css`), 'utf8');

      // classes whose animation writes `transform` at least once
      const moves = new Set<string>();
      for (const rule of css.matchAll(/\.([a-zA-Z0-9_-]*thr[a-zA-Z0-9_-]*)\s*\{([^}]*)\}/g)) {
        const name = /animation:\s*([a-zA-Z0-9_-]+)/.exec(rule[2])?.[1];
        if (!name || name === 'none') continue;
        const frames = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
        if (frames && /transform\s*:/.test(frames[1])) moves.add(rule[1]);
      }

      for (const el of tsx.matchAll(/<(\w+)([^>]*)>/g)) {
        const attrs = el[2];
        const cls = /className="([^"{}]+)"/.exec(attrs);
        // BOTH SPELLINGS. The first version of this check read only the
        // literal `transform="..."`, and horseshoe's four clovers - which
        // build their corner offsets with a template literal, transform={...}
        // - walked straight through it and stacked on the origin anyway. A
        // guard that knows one of the two ways to write the same attribute
        // reports "clean" on the very case it was written for. CLAUDE.md
        // 10.86: a fix that leaves the same trap one level up has not landed.
        const literal = /\btransform="([^"]*)"/.exec(attrs);
        const expression = /\btransform=\{/.test(attrs);
        if (!cls || !(literal || expression)) continue;
        const shown = literal ? `transform="${literal[1]}"` : 'transform={...}';
        for (const name of cls[1].split(/\s+/).filter(Boolean)) {
          if (moves.has(name)) {
            offenders.push(`${id}.tsx: ${name} carries ${shown}, which its own keyframes discard`);
          }
        }
      }
    }
    expect(
      offenders,
      'put the measured position on a wrapper <g> and the animation on the child'
    ).toEqual([]);
  });

  it('one hundred units is one avatar width, in every rig, always', () => {
    // Every rig's geometry is measured in units and converted with "measured
    // pixels x (100 / reference avatar px)". That conversion is only true
    // because the payload box is ALWAYS three avatar widths and the viewBox is
    // ALWAYS -150 -150 300 300 - 300 units across three avatar widths.
    //
    // `payload.sizeU` looks like it sets that box. It does not: it is
    // declarative, nothing reads it, and it was documented as "width of the
    // payload's own box" until 2026-09-07, which is exactly how an author ends
    // up sizing artwork against a number that does nothing. This pins the two
    // halves that ARE real, so that wiring sizeU up - which would silently
    // rescale all eighteen rigs at once - has to be a deliberate act that moves
    // this law with it.
    expect(PLAYER_CSS).toMatch(/\.thr__payload \{[^}]*width: calc\(var\(--thr-u\) \* 3\)/);
    expect(read('src/throwables/rig.ts')).toMatch(/RIG_VIEWBOX\s*=\s*'-150 -150 300 300'/);
    expect(PLAYER, 'the player must not read sizeU without moving this law').not.toMatch(/sizeU/);
  });

  it('the payload floor is DERIVED from the shortest measured payload', () => {
    // THE BOUND HAS BEEN WRONG TWICE - 1800, then 1600 - and both times because
    // it was read off the plan's life table, which measures SPAWN TO CLEAN,
    // while the bound governs LANDING TO CLEAN. The bomb is the worked example:
    // the life table says 2.0 s and its payload is 1566, because 167 ms of
    // spawn and 267 ms of flight happen before the payload exists. 2000 - 434.
    //
    // So the floor is not a judgement any more, it is the minimum of the
    // measured set, and this is the equality that keeps it that way. A shorter
    // item turns this red, and the bound then has to be RE-DERIVED rather than
    // nudged until the newest rig fits.
    const shortest = Math.min(
      ...ids.map((id) => {
        const tsx = fs.readFileSync(path.join(rigDir, `${id}.tsx`), 'utf8');
        return Number(/payload:\s*\{[^}]*\bms:\s*(\d+)/.exec(tsx)?.[1] ?? Infinity);
      })
    );
    const floor = Number(/payloadMs:\s*\{\s*min:\s*(\d+)/.exec(SPEC)?.[1] ?? NaN);
    expect(
      floor,
      `THROWABLE_GRAMMAR.payloadMs.min is ${floor} but the shortest measured payload is ${shortest}`
    ).toBe(shortest);
  });

  it('a keyframe stop lands on the millisecond its own comment names', () => {
    // THE CHECK THAT WAS MISSING, and the one that would have caught the two
    // worst timing bugs in this programme on the day they were written.
    //
    // A rig's stops are percentages. The millisecond each one MEANS is written
    // beside it in a comment, and nothing ever compared the two. Recomputing
    // them found the same mistake twice, in two different rigs, made by
    // subtracting the wrong zero:
    //
    //   beer `thr-beer-m2`  - percentages were (ms - delay) / duration, with
    //     the LANDING left out, so mug 2 reached the clink pose 333 ms (one
    //     whole flight) after mug 1 was already there and after
    //     `glass_clink_rattle` had played.
    //   water_gun - the four long rules start at landing + 67 = 367, but their
    //     percentages were computed against 267. The squirt appeared 100 ms
    //     after its own `squirt_start` cue, and the gun's scale-out finished
    //     100 ms after the payload had unmounted, so it never played.
    //
    // Both are invisible to every other check here: the specs are right, the
    // classes resolve, the delays scale, nothing is hidden on its own beat.
    // Only the arithmetic inside the keyframe block is wrong, and the comment
    // beside it says so.
    //
    // The tolerance is one frame at 30 fps (34 ms), because the reference is a
    // 30 fps capture and a stop written to the nearest frame is not a defect.
    const FRAME_MS = 34;
    const offenders: string[] = [];
    for (const id of ids) {
      const tsx = fs.readFileSync(path.join(rigDir, `${id}.tsx`), 'utf8');
      const flight = Number(/flight:\s*\{\s*ms:\s*(\d+)/.exec(tsx)?.[1] ?? NaN);
      if (!Number.isFinite(flight)) continue;
      const raw = fs.readFileSync(path.join(rigDir, `${id}.css`), 'utf8');
      // reduced motion sets no timings worth checking, and its `animation:
      // none` would be read as a rule
      const css = raw.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gs, '');

      // animation name -> its duration and delay, in ms. BOTH the shorthand
      // and the longhand: water_gun writes `animation-delay` on its own line,
      // and a reader that only parses the shorthand reports a 67 ms delay as
      // zero - which is exactly the mistake this check exists to catch, made
      // by the checker instead of the rig.
      const timing = new Map<string, { dur: number; delay: number }>();
      for (const rule of css.matchAll(/\{([^{}]*)\}/g)) {
        const body = rule[1];
        const short = /animation:\s*([^;]+);/.exec(body);
        const name = short
          ? /^\s*([a-zA-Z][\w-]*)/.exec(short[1])?.[1]
          : /animation-name:\s*([\w-]+)/.exec(body)?.[1];
        if (!name || name === 'none') continue;
        const secs = (src: string | undefined) =>
          src ? [...src.matchAll(/calc\(\s*([\d.]+)s/g)].map((m) => Number(m[1]) * 1000) : [];
        const inline = secs(short?.[1]);
        const dur = secs(/animation-duration:\s*([^;]+);/.exec(body)?.[1])[0] ?? inline[0];
        const delay = secs(/animation-delay:\s*([^;]+);/.exec(body)?.[1])[0] ?? inline[1] ?? 0;
        if (dur === undefined) continue;
        if (!timing.has(name)) timing.set(name, { dur, delay });
      }

      for (const [name, { dur, delay }] of timing) {
        const block = new RegExp(`@keyframes\\s+${name}\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`, 's');
        const body = block.exec(css)?.[1];
        if (!body) continue;
        // a stop (or the last of a comma-separated group) whose block opens
        // with a comment naming a millisecond
        for (const stop of body.matchAll(
          /([\d.]+)%\s*(?:,\s*[\d.]+%\s*)?\{\s*\/\*\s*~?(\d{2,4})\b/g
        )) {
          const pct = Number(stop[1]);
          const says = Number(stop[2]);
          const at = flight + delay + (pct / 100) * dur;
          if (Math.abs(at - says) > FRAME_MS) {
            offenders.push(
              `${id}.css ${name} ${pct}% says ${says}ms but plays at ${Math.round(at)}ms ` +
                `(landing ${flight} + delay ${delay} + ${pct}% of ${dur})`
            );
          }
        }
      }
    }
    expect(
      offenders,
      'a stop and the millisecond written beside it must be the same moment'
    ).toEqual([]);
  });

  it('no animation outlives the payload it is drawn on', () => {
    // An element removed mid-animation never plays its own ending. Two rigs
    // were doing it: snowman's plume and nose ran 167 ms past the unmount (a
    // stretch left behind when this phase LOWERED the `payloadMs` floor from
    // 1800 to 1600 - the bound was fixed and the thing it had distorted was
    // not), and water_gun's four long rules ran 103 ms past it, so the gun's
    // scripted scale-out never rendered at all. In both the tail is the part
    // that vanishes, which is why nobody noticed: the animation looks right
    // until the exact moment it is supposed to finish.
    const offenders: string[] = [];
    for (const id of ids) {
      const tsx = fs.readFileSync(path.join(rigDir, `${id}.tsx`), 'utf8');
      const payload = Number(/payload:\s*\{[^}]*\bms:\s*(\d+)/.exec(tsx)?.[1] ?? NaN);
      if (!Number.isFinite(payload)) continue;
      const css = fs
        .readFileSync(path.join(rigDir, `${id}.css`), 'utf8')
        .replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gs, '');
      for (const rule of css.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^{}]*)\}/g)) {
        const body = rule[2];
        const short = /animation:\s*([^;]+);/.exec(body)?.[1];
        if (short && /\bnone\b/.test(short)) continue;
        // a repeating animation ends when the payload does, by construction
        if (/infinite/.test(body)) continue;
        const secs = (src: string | undefined) =>
          src ? [...src.matchAll(/calc\(\s*([\d.]+)s/g)].map((m) => Number(m[1]) * 1000) : [];
        const inline = secs(short);
        const dur = secs(/animation-duration:\s*([^;]+);/.exec(body)?.[1])[0] ?? inline[0];
        const delay = secs(/animation-delay:\s*([^;]+);/.exec(body)?.[1])[0] ?? inline[1] ?? 0;
        if (dur === undefined) continue;
        const iterations = Number(/animation-iteration-count:\s*(\d+)/.exec(body)?.[1] ?? 1);
        const end = delay + dur * iterations;
        if (end > payload + 1) {
          offenders.push(
            `${id}.css .${rule[1]} runs to ${Math.round(end)}ms but the payload unmounts at ${payload}ms`
          );
        }
      }
    }
    expect(offenders, 'an animation cut off mid-play never shows its own ending').toEqual([]);
  });

  it('the beat called `land` IS the landing, to the millisecond', () => {
    // `throwableLandingMs` returns `flight.ms` and the player mounts the payload
    // there. A beat named `land` that says anything else is a rig measuring from
    // a different zero than the code - and the whole stylesheet's delays are
    // `beat.at - flight.ms`, so the error is silent and systematic.
    //
    // THIS IS WHY IT EXISTS. Ten of the twelve tables in
    // pokerbros-reference-video-1.md label the SPAWN frame "Launch frame L" -
    // their own first row is `Spawn at thrower` starting at L. Three rigs were
    // built on that reading: `snowman` and `dice` came out one frame short, and
    // `water_gun`'s recorded beats sat 133 ms from its own reference. The doc
    // now says where L really is; this is the check that does not rely on
    // anyone reading it.
    const rigDirFiles = fs.readdirSync(rigDir).filter((f) => f.endsWith('.tsx'));
    const offenders: string[] = [];
    for (const f of rigDirFiles) {
      const tsx = fs.readFileSync(path.join(rigDir, f), 'utf8');
      const mode = (/mode:\s*'(straight|none)'/.exec(tsx) || [])[1];
      const flight = Number((/flight:\s*\{\s*ms:\s*(\d+)/.exec(tsx) || [])[1]);
      const land = /\{ at: (\d+), marker: 'land' \}/.exec(tsx);
      if (!land) continue; // fireworks and other spawn-at-target items have none
      const expected = mode === 'none' ? 0 : flight;
      if (Number(land[1]) !== expected) {
        offenders.push(`${f}: land beat ${land[1]} but the payload mounts at ${expected}`);
      }
    }
    expect(
      offenders,
      'a `land` beat that is not the landing means a rig and the player disagree'
    ).toEqual([]);
  });

  it('nothing is invisible on the frame its own beat names', () => {
    // THE IDIOM, and the bug it replaced. `animation-fill-mode: both` fills the
    // DELAY with the 0% frame. So a DELAYED animation whose 0% is hidden is
    // invisible on the very frame it is meant to appear - the element waits,
    // correctly, and then keeps waiting for one more frame.
    //
    // Phase 1 shipped seven of these across beer and tomato, and the darkroom
    // photographed the tomato's burst as an empty seat at 300. In playback it
    // is four milliseconds late and nobody sees it; in the DARKROOM, which
    // freezes exactly on the beat, it is a black frame at a documented moment -
    // and the darkroom is the instrument this whole programme verifies itself
    // with. Two real bugs (fireworks rendering nothing, champagne's cork and
    // jet missing) were nearly lost in that noise.
    //
    // So: a delayed animation is `forwards` with a VISIBLE 0% frame. `both` is
    // for an element that is already on screen when its animation starts.
    const offenders: string[] = [];
    for (const id of ids) {
      const css = code(fs.readFileSync(path.join(rigDir, `${id}.css`), 'utf8'));
      const opensHidden = new Map<string, boolean>();
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
        const first = /0%\s*\{([^}]*)\}/.exec(m[2]);
        opensHidden.set(m[1], first ? /opacity:\s*0(?!\.\d*[1-9])/.test(first[1]) : false);
      }
      for (const m of css.matchAll(/\.([\w-]+)\s*\{[^}]*?animation:\s*([^;]+);/g)) {
        const shorthand = m[2];
        const name = (shorthand.match(/^\s*([\w-]+)/) || [])[1];
        const times = [...shorthand.matchAll(/calc\((\d*\.?\d+)s \* var/g)].map((x) => +x[1]);
        const delayed = times.length > 1 && times[1] > 0;
        if (delayed && /\bboth\b/.test(shorthand) && opensHidden.get(name)) {
          offenders.push(`${id}.css .${m[1]} (${name})`);
        }
      }
    }
    expect(
      offenders,
      'a delayed `both` with a hidden 0% is invisible on its own beat: use `forwards` and open visible'
    ).toEqual([]);
  });

  it('every rule in a rig stylesheet is worn by something', () => {
    // The other direction, and the more dangerous one: a rule nobody wears is
    // an ANIMATION NOBODY PLAYS. A beat can go missing this way without any
    // test noticing, because the keyframes are all still there and correct.
    const offenders: string[] = [];
    for (const id of ids) {
      const tsx = fs.readFileSync(path.join(rigDir, `${id}.tsx`), 'utf8');
      const css = code(fs.readFileSync(path.join(rigDir, `${id}.css`), 'utf8'));
      const worn = new Set<string>();
      for (const m of tsx.matchAll(/className="([^"{}]+)"/g))
        for (const n of m[1].split(/\s+/).filter(Boolean)) worn.add(n);
      for (const m of css.matchAll(/\.(thr[a-zA-Z0-9_-]*)/g)) {
        if (!worn.has(m[1])) offenders.push(`${id}.css -> .${m[1]}`);
      }
    }
    expect(offenders, `a rule nothing wears is an animation nobody plays`).toEqual([]);
  });
});

describe('LAW: the migration seam stays honest', () => {
  it('routes a rigged item to the player and everything else to the legacy engine', () => {
    // One container, two engines, for exactly as long as the rebuild takes.
    // A table can show one of each side by side; neither may swallow the other.
    expect(CONTAINER).toMatch(/riggedThrowable\(event\.throwable\.id\)/);
    expect(CONTAINER).toMatch(/rigged \? \(/);
    expect(CONTAINER).toMatch(/<ThrowablePlayer/);
    expect(CONTAINER).toMatch(/<ThrowAnimation/);
  });

  it('the grammar bounds live in ONE place, as data', () => {
    // So the specs test, the darkroom and this law cannot disagree about what
    // the reference said.
    expect(SPEC).toMatch(/export const THROWABLE_GRAMMAR/);
    expect(SPEC).toMatch(/flightMs: \{ min: 133, max: 400 \}/);
  });

  it('the landing is defined ONCE, and it is where the player mounts the payload', () => {
    // THE BUG THIS PINS: water_gun's rig counted its delays from
    // "flight + the blink-pop", the player mounts at `flight.ms`, and every
    // beat in it fired 100 ms early. One definition, used by both.
    expect(SPEC).toMatch(/export function throwableLandingMs/);
    expect(PLAYER).toMatch(/throwableLandingMs\(spec\)/);
  });
});
