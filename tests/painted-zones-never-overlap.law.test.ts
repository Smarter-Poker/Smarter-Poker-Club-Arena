/**
 * LAW: no two painted zones that can be printed together ever intersect.
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, on the console standard: "NOTHING CAN BE COPY PASTED OR OVERLAPPED",
 * and "MAKE SURE FONT SIZES NEVER GO OVER THE EDGES OF THE FRAME".
 *
 * WHAT WENT WRONG (2026-09-22). `SHARK_CONSOLE_ZONES` declared a title band
 * of y 76-142 and a subtitle band of y 126-148 on a head that is 154 rows
 * tall. Those two rectangles intersect over 16 rows, so a shark console given
 * both a title and a subtitle printed the second through the bottom of the
 * first. `RIVETED_CONSOLE_ZONES` carried the same defect in a milder form:
 * a title band to y 172 against a subtitle band from y 168, four rows.
 *
 * Neither was ever seen by a player, because no live caller on either family
 * happened to pass a subtitle. An agent rebuilding ClubAdvertisePage met the
 * shark one, dropped the subtitle and wrote it down rather than editing a
 * shared file while other agents were in the tree. That was the right call
 * then; this file is so that the next table cannot be wrong in silence.
 *
 * WHY THIS ASKS THE COMPONENT INSTEAD OF THE TABLE. Most zones in a table are
 * ALTERNATIVES. `title` is wider than `titleBesidePill` and deliberately runs
 * under the pill slot, because it is only ever used when there is no pill. So
 * "do these two rectangles overlap" is meaningless asked of the raw table and
 * exact asked of the set a given head really paints. `consoleHeadZones` is
 * what the component prints from, and it is what this reads, so the two
 * cannot drift: a selector re-derived here would have agreed with the broken
 * table for as long as nobody rendered the case.
 *
 * AND A BAND THAT IS TOO SHORT CUTS ITS OWN LETTERS. The same tables held
 * subtitle bands shorter than the line box they carry, and a zone clips what
 * it holds: the shark printed 10.3 rows of a 15.9-row line and the riveted
 * 13.9 of 15.7. So every band is also held against the type it is given,
 * with the sizes read out of SpadeConsole.css rather than restated here.
 *
 * IT ALSO FAILS WHEN IT CANNOT TELL (CLAUDE.md 10.86 rule 2). An enumeration
 * that finds no zones is a broken enumeration, not a clean report, so the
 * counts and the font sizes are asserted before the verdicts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RIVETED_CONSOLE_W,
  RIVETED_CONSOLE_FOOT_H,
  RIVETED_CONSOLE_TOP_H,
  RIVETED_CONSOLE_ZONES,
  SHARK_CONSOLE_W,
  SHARK_CONSOLE_FOOT_H,
  SHARK_CONSOLE_TOP_H,
  SHARK_CONSOLE_ZONES,
  SPADE_CONSOLE_W,
  SPADE_CONSOLE_PLATES_H,
  SPADE_CONSOLE_TOP_H,
  SPADE_CONSOLE_ZONES,
  consoleHeadZones,
  type ConsoleFamily,
} from '../src/components/console/SpadeConsole';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rows and columns two rectangles share. Zero on either axis is clear. */
function intersection(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

function describeRect(name: string, r: Rect): string {
  return `${name} x ${r.x}-${r.x + r.width} y ${r.y}-${r.y + r.height}`;
}

const HEADS: Record<ConsoleFamily, { width: number; height: number }> = {
  spade: { width: SPADE_CONSOLE_W, height: SPADE_CONSOLE_TOP_H },
  shark: { width: SHARK_CONSOLE_W, height: SHARK_CONSOLE_TOP_H },
  riveted: { width: RIVETED_CONSOLE_W, height: RIVETED_CONSOLE_TOP_H },
};

const FAMILIES = Object.keys(HEADS) as ConsoleFamily[];

/** Every shape of head content a caller can ask for. The X (2026-09-23) is
 *  the fourth axis: it sits at the right end of the wide title band on the
 *  shark and riveted masters, so a head with an X and no pill has to narrow
 *  its title exactly as a pill does, and this file is what proves it. */
const CONTENT = [false, true].flatMap((eyebrow) =>
  [false, true].flatMap((subtitle) =>
    [false, true].flatMap((pill) =>
      [false, true].map((close) => ({ eyebrow, subtitle, pill, close }))
    )
  )
);

function shapeName(c: {
  eyebrow: boolean;
  subtitle: boolean;
  pill: boolean;
  close: boolean;
}): string {
  const parts = ['title'];
  if (c.eyebrow) parts.unshift('eyebrow');
  if (c.subtitle) parts.push('subtitle');
  if (c.pill) parts.push('pill');
  if (c.close) parts.push('close');
  return parts.join(' + ');
}

describe('painted zones never overlap', () => {
  it('enumerates every family and every shape of head content', () => {
    expect(FAMILIES).toEqual(['spade', 'shark', 'riveted']);
    expect(CONTENT).toHaveLength(16);
    /* A shape that returns nothing means the selector was renamed out from
       under this file, not that the art is clean. */
    for (const family of FAMILIES) {
      for (const content of CONTENT) {
        const painted = consoleHeadZones(family, content);
        const expected =
          1 +
          Number(content.eyebrow) +
          Number(content.subtitle) +
          Number(content.pill) +
          Number(content.close);
        expect(
          Object.keys(painted),
          `${family} / ${shapeName(content)} painted the wrong set of zones`
        ).toHaveLength(expected);
      }
    }
  });

  for (const family of FAMILIES) {
    const head = HEADS[family];

    for (const content of CONTENT) {
      it(`${family}: ${shapeName(content)} prints no zone on top of another`, () => {
        const painted = Object.entries(consoleHeadZones(family, content)) as [string, Rect][];
        const collisions: string[] = [];
        for (let i = 0; i < painted.length; i += 1) {
          for (let j = i + 1; j < painted.length; j += 1) {
            const [aName, a] = painted[i];
            const [bName, b] = painted[j];
            const overlap = intersection(a, b);
            if (overlap.width > 0 && overlap.height > 0) {
              collisions.push(
                `${describeRect(aName, a)} and ${describeRect(bName, b)} share ` +
                  `${overlap.width} x ${overlap.height} master pixels`
              );
            }
          }
        }
        expect(
          collisions,
          `Two zones a ${family} head prints together intersect. One line will ` +
            `be printed through the other. Re-measure the bands against the ` +
            `master art in public/assets/club-buttons/console/, give the ` +
            `title band back the rows its ink does not use, and keep its ` +
            `centre where it is so nothing already live moves.`
        ).toEqual([]);
      });

      it(`${family}: ${shapeName(content)} keeps every zone on the art`, () => {
        const painted = Object.entries(consoleHeadZones(family, content)) as [string, Rect][];
        const escaped = painted
          .filter(
            ([, z]) =>
              z.x < 0 || z.y < 0 || z.x + z.width > head.width || z.y + z.height > head.height
          )
          .map(([name, z]) => `${describeRect(name, z)} (head is ${head.width} x ${head.height})`);
        expect(
          escaped,
          `A zone runs off the head slice. Text printed there lands on the ` +
            `body, on the frame, or nowhere.`
        ).toEqual([]);
      });
    }
  }

  /**
   * HOW FAR THE INK REACHES BELOW A BAND'S TOP, as a multiple of the font
   * size, measured on the rendered page at 393px on 2026-09-22. A line sits
   * from the TOP of its zone once its line box is taller than the zone, and
   * the zone clips, so a band shorter than this cuts the bottom off the
   * letters. The title is line-height 1.2 and carries an engraved bevel under
   * the caps; the eyebrow, subtitle and pill are line-height 1.6, which puts
   * half a line of leading above the letters before they even start.
   */
  const INK_REACH: Record<string, number> = {
    eyebrow: 1.05,
    title: 0.98,
    subtitle: 1.1,
    pill: 1.1,
  };

  /** The console's own type sizes, in cqw, read from the stylesheet. */
  function fontCqw(): Record<string, number> {
    const css = readFileSync(
      join(__dirname, '..', 'src', 'components', 'console', 'SpadeConsole.css'),
      'utf8'
    );
    const out: Record<string, number> = {};
    for (const zone of Object.keys(INK_REACH)) {
      const rule = new RegExp(`\\.sc__${zone}\\s*\\{[^}]*?font-size:\\s*([\\d.]+)cqw`, 's');
      const found = css.match(rule);
      if (found) out[zone] = Number.parseFloat(found[1]);
    }
    return out;
  }

  it('reads a type size for every kind of line the head prints', () => {
    const sizes = fontCqw();
    /* An unreadable stylesheet is not a clean report. */
    expect(Object.keys(sizes).sort()).toEqual(['eyebrow', 'pill', 'subtitle', 'title']);
    for (const [zone, cqw] of Object.entries(sizes)) {
      expect(cqw, `.sc__${zone} has no usable font size`).toBeGreaterThan(0.5);
    }
  });

  for (const family of FAMILIES) {
    for (const content of CONTENT) {
      it(`${family}: ${shapeName(content)} gives every line a band its ink fits`, () => {
        const sizes = fontCqw();
        const width = HEADS[family].width;
        const short: string[] = [];
        for (const [name, zone] of Object.entries(consoleHeadZones(family, content)) as [
          string,
          Rect,
        ][]) {
          /* Both title bands are the same line of type. */
          const kind = name.startsWith('title') ? 'title' : name;
          const cqw = sizes[kind];
          if (cqw === undefined) continue;
          const fontPx = (cqw / 100) * width;
          const needed = INK_REACH[kind] * fontPx;
          if (zone.height + 0.001 < needed) {
            short.push(
              `${name} is ${zone.height} rows tall and its ink reaches ` +
                `${needed.toFixed(1)} rows below the band top (${cqw}cqw on a ` +
                `${width}-wide master)`
            );
          }
        }
        expect(
          short,
          `A band is shorter than the line it holds, so the zone will clip the ` +
            `bottom off the letters. Give the band the rows its ink needs and ` +
            `move whatever sits under it, measured against the master art.`
        ).toEqual([]);
      });
    }
  }

  it('the two plates in a foot never share a pixel', () => {
    const feet: [string, Rect, Rect, number, number][] = [
      [
        'spade',
        SPADE_CONSOLE_ZONES.plateSecondary,
        SPADE_CONSOLE_ZONES.platePrimary,
        SPADE_CONSOLE_W,
        SPADE_CONSOLE_PLATES_H,
      ],
      [
        'riveted',
        RIVETED_CONSOLE_ZONES.plateSecondary,
        RIVETED_CONSOLE_ZONES.platePrimary,
        RIVETED_CONSOLE_W,
        RIVETED_CONSOLE_FOOT_H,
      ],
    ];
    expect(feet).toHaveLength(2);
    for (const [family, secondary, primary, width, height] of feet) {
      const overlap = intersection(secondary, primary);
      /* Side by side plates share every row, which is not a collision. Only
         an overlap on BOTH axes puts one plate's label on the other's art. */
      expect(
        `${family}: ${Math.min(overlap.width, overlap.height) > 0 ? 'intersects' : 'clear'}`,
        `${family}'s painted plates intersect over ${overlap.width} x ` +
          `${overlap.height} master pixels: ` +
          `${describeRect('plateSecondary', secondary)} and ` +
          `${describeRect('platePrimary', primary)}`
      ).toBe(`${family}: clear`);
      for (const [name, plate] of [
        ['plateSecondary', secondary],
        ['platePrimary', primary],
      ] as [string, Rect][]) {
        expect(plate.x, `${family} ${name} starts left of its foot`).toBeGreaterThanOrEqual(0);
        expect(plate.y, `${family} ${name} starts above its foot`).toBeGreaterThanOrEqual(0);
        expect(plate.x + plate.width, `${family} ${name} runs past its foot`).toBeLessThanOrEqual(
          width
        );
        expect(plate.y + plate.height, `${family} ${name} runs below its foot`).toBeLessThanOrEqual(
          height
        );
      }
    }
  });

  it("the shark's one plate stays inside its own foot", () => {
    const plate = SHARK_CONSOLE_ZONES.plate;
    expect(plate.x).toBeGreaterThanOrEqual(0);
    expect(plate.y).toBeGreaterThanOrEqual(0);
    expect(plate.x + plate.width).toBeLessThanOrEqual(SHARK_CONSOLE_W);
    expect(plate.y + plate.height).toBeLessThanOrEqual(SHARK_CONSOLE_FOOT_H);
  });

  /**
   * The mechanism, not just the numbers. If the component goes back to
   * choosing zones inline, this file keeps passing while the thing it checks
   * stops being what renders.
   */
  it('the console prints from the same selector this law reads', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'components', 'console', 'SpadeConsole.tsx'),
      'utf8'
    );
    expect(source).toContain('const head = consoleHeadZones(family, {');
    for (const zone of ['head.eyebrow', 'head.title', 'head.subtitle', 'head.pill']) {
      expect(source, `the head stopped printing ${zone} through the selector`).toContain(
        `zonePct(${zone}, W, TOP_H)`
      );
    }
    /* The old inline choice, which is the shape this law replaced. */
    expect(source).not.toContain('zonePct(pill ? Z.titleBesidePill : Z.title');
  });
});
