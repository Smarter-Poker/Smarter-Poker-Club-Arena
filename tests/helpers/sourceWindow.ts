/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SOURCE PIN MUST SLICE A STRUCTURE, NOT A FIXED NUMBER OF BYTES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This repo tests a great deal of behaviour by reading source and asserting on
 * its text. That is a legitimate technique and it catches real regressions.
 * What is not legitimate is bounding the window with a magic number.
 *
 * 2026-08-28, and it cost a publish outage. `tournamentRakeAndBreaks` read a
 * 7000-character window from the start of `registerHorses`. Comments were added
 * inside that method and pushed the asserted code to offsets 7241, 7440, 7471
 * and 7695 - just past the end of the window. Three pins went red, the code
 * they guard had not changed by a character, and because a red client suite
 * skips `sync-to-world-hub`, NOTHING PUBLISHED FOR THE WHOLE ESTATE for 39
 * minutes until a human noticed.
 *
 * The silent direction is worse than the loud one. A window that can drift off
 * the end of the thing it guards can also drift off it while staying green -
 * the assertion passes because the code it was watching is no longer inside the
 * window at all. And the obvious fix for a red window, making the number
 * bigger, only moves the cliff.
 *
 * So bound every window by the structure it is about: a method by its matching
 * brace, a call by its matching paren, a statement by the block that encloses
 * it. Then the window grows exactly as fast as the code does, and it can never
 * be outrun by the body it watches.
 *
 * The scanners below ignore braces and parens inside comments and string
 * literals, because behaviour cannot live in either. Offsets are preserved
 * while blanking, so every returned slice indexes the ORIGINAL source.
 */

/**
 * Blank out comments and string literals, preserving length so that every
 * offset computed against the result is valid against the input.
 */
export const blankNonCode = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length));

const matchForward = (cleaned: string, from: number, open: '{' | '('): number => {
  const close = open === '{' ? '}' : ')';
  const start = cleaned.indexOf(open, from);
  if (start < 0) return -1;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === open) depth++;
    else if (cleaned[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/**
 * The whole body of the method or function introduced by `signature`.
 *
 * NOT simply "the first `{` after the signature". That is what the original
 * copy of this helper did, and it is wrong the moment a method annotates an
 * inline return type:
 *
 *     public async revealRabbitHunt(
 *       userId: string
 *     ): Promise<{ success: boolean; cards?: Card[] }> {
 *
 * The first brace there opens the RETURN TYPE, so a brace-matcher closes on
 * `}>` and hands back a window containing the signature and nothing else -
 * green on every negative assertion, and blind. Found 2026-08-28 by moving the
 * helper here and running the suites against it.
 *
 * So the end is found by indentation instead: the method closes at the first
 * line that is this signature's own indent followed by `}`. Prettier runs on
 * every commit through .husky/pre-commit, so that shape is guaranteed. Brace
 * matching stays as the fallback for anything unformatted.
 */
export const sliceMethod = (src: string, signature: string): string => {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`sliceMethod: "${signature}" not found`);

  const cleaned = blankNonCode(src);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart, start))?.[0] ?? '';

  // The closing line must END there. Matching `\n<indent>}` alone is not
  // enough, because Prettier closes an inline return type at the signature's
  // OWN indent:
  //
  //     ): Promise<{
  //       success: boolean;
  //     }> {
  //
  // `  }> {` would match and hand back the signature only. Requiring the brace
  // to be the last thing on its line separates the two: a body closes as
  // `  }`, a return type continues as `  }> {`.
  const closer = new RegExp(`\\n${indent}\\}[;,)]?[ \\t]*(?:\\r?\\n|$)`);
  const afterLine = cleaned.indexOf('\n', start);
  if (afterLine >= 0) {
    const m = closer.exec(cleaned.slice(afterLine));
    if (m) {
      const close = afterLine + (m.index ?? 0);
      return src.slice(start, close + 1 + indent.length + 1);
    }
  }

  const end = matchForward(cleaned.slice(start), 0, '{');
  return end < 0 ? src.slice(start) : src.slice(start, start + end + 1);
};

/**
 * A call and its complete argument list, from `signature` to the paren that
 * closes it - however long the arguments grow.
 *
 * Replaces a fixed window over a call whose payload object keeps gaining
 * fields, which is the shape that silently stops covering the newest field.
 */
export const sliceCall = (src: string, signature: string): string => {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`sliceCall: "${signature}" not found`);
  const cleaned = blankNonCode(src.slice(start));
  const end = matchForward(cleaned, 0, '(');
  return end < 0 ? src.slice(start) : src.slice(start, start + end + 1);
};

/**
 * The innermost `{ ... }` block containing `needle`, braces included.
 *
 * This is the one to reach for when the thing being pinned sits in the MIDDLE
 * of a structure - a field inside an object literal, a statement inside a
 * handler - so there is no signature in front of it to slice from. It matters
 * most for NEGATIVE assertions (`not.toMatch`): a fixed forward window can run
 * past the object and read a match belonging to the next one, and the test then
 * fails for a reason that has nothing to do with the invariant.
 *
 * `occurrence` picks which appearance of `needle` to use when it repeats.
 */
export const sliceEnclosingBlock = (
  src: string,
  needle: string,
  occurrence = 0,
  levels = 1
): string => {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = src.indexOf(needle, at + 1);
    if (at < 0)
      throw new Error(`sliceEnclosingBlock: "${needle}" occurrence ${occurrence} not found`);
  }
  const cleaned = blankNonCode(src);

  // Walk backwards to the nearest '{' still open at `at`.
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (cleaned[i] === '}') depth++;
    else if (cleaned[i] === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) throw new Error(`sliceEnclosingBlock: no enclosing block for "${needle}"`);

  // `levels` climbs outward. Needed when the thing asserted sits in a SIBLING
  // statement rather than the same object - a filter applied just before the
  // emit it protects, for instance. One level would take only the emit.
  for (let up = 1; up < levels; up++) {
    let d = 0;
    let outer = -1;
    for (let i = open - 1; i >= 0; i--) {
      if (cleaned[i] === '}') d++;
      else if (cleaned[i] === '{') {
        if (d === 0) {
          outer = i;
          break;
        }
        d--;
      }
    }
    if (outer < 0) break;
    open = outer;
  }

  const end = matchForward(cleaned, open, '{');
  return end < 0 ? src.slice(open) : src.slice(open, end + 1);
};

/**
 * From `needle` through the balanced `{ ... }` block that follows it.
 *
 * The same scan as `sliceMethod`, under the name that is honest when the
 * anchor is not a signature - an `if` condition, a `case`, a `.then(`. Reach
 * for this when the needle INTRODUCES a block; reach for `sliceEnclosingBlock`
 * when it sits inside one.
 */
export const sliceBlockAfter = sliceMethod;

/**
 * One CSS rule, from its selector through the `}` that closes it.
 *
 * `avatarChoreographyCascade` already found this the hard way and fixed one
 * assertion by hand: "the assertion used to be `rive.slice(0, 320)`, which is a
 * guess at how long the rule is: adding the comment that explains which scale
 * variable to use pushed the declaration past the window and failed a rule that
 * was correct. A test should fail when the CSS is wrong, not when it is
 * documented." This is that fix, generalised.
 */
export const sliceCssRule = (css: string, selector: string): string => {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`sliceCssRule: "${selector}" not found`);
  const end = css.indexOf('}', start);
  return end < 0 ? css.slice(start) : css.slice(start, end + 1);
};

/**
 * One SQL statement, from `anchor` through the semicolon that ends it.
 *
 * Dollar-quote aware, which is the whole difficulty: a function body lives in
 * `AS $$ ... $$;` and is full of semicolons that do NOT end the statement. The
 * scanner tracks the opening tag (`$$`, `$function$`, `$preflight$`) and only
 * accepts a semicolon once the body has closed.
 *
 * Replaces `MIG.slice(MIG.indexOf('CREATE ...')).slice(0, 400)`, which asserts
 * against however much of a migration happens to fit in 400 characters and
 * quietly stops covering the clause it was written for.
 */
export const sliceSqlStatement = (sql: string, anchor: string): string => {
  const start = sql.indexOf(anchor);
  if (start < 0) throw new Error(`sliceSqlStatement: "${anchor}" not found`);
  const tagRe = /\$[A-Za-z_]*\$/g;
  let i = start;
  let tag: string | null = null;
  while (i < sql.length) {
    if (tag) {
      const close = sql.indexOf(tag, i);
      if (close < 0) return sql.slice(start);
      i = close + tag.length;
      tag = null;
      continue;
    }
    tagRe.lastIndex = i;
    const m = tagRe.exec(sql);
    const semi = sql.indexOf(';', i);
    if (semi >= 0 && (!m || semi < m.index)) return sql.slice(start, semi + 1);
    if (!m) return sql.slice(start);
    tag = m[0];
    i = m.index + m[0].length;
  }
  return sql.slice(start);
};

/**
 * The contents of a dollar-quoted block, opening and closing tag included -
 * `$preflight$ ... $preflight$`, `$$ ... $$`.
 */
export const sliceDollarQuoted = (sql: string, tag: string): string => {
  const start = sql.indexOf(tag);
  if (start < 0) throw new Error(`sliceDollarQuoted: "${tag}" not found`);
  const end = sql.indexOf(tag, start + tag.length);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + tag.length);
};

/**
 * One statement, from `anchor` to the semicolon that ends it at depth zero.
 *
 * For `const SEVEN_DEUCE_VARIANTS = new Set([...]);` and friends, where the
 * declaration grows every time a variant is added and a fixed window silently
 * stops covering the newest one - the exact case a `not.toContain` is there to
 * catch.
 */
export const sliceStatement = (src: string, anchor: string): string => {
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`sliceStatement: "${anchor}" not found`);
  const cleaned = blankNonCode(src.slice(start));
  let depth = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth <= 0) return src.slice(start, start + i + 1);
  }
  return src.slice(start);
};

/**
 * One YAML block, from the line introducing `key` to the next line indented at
 * or below it.
 *
 * A workflow job is defined by its indentation and nothing else, so a byte
 * count is doubly wrong here: adding one `env:` entry to a job pushes the
 * `needs:` line the assertion is about out of a 260-character window, and the
 * gate that guards publishing stops guarding it.
 */
export const sliceYamlBlock = (yaml: string, key: string): string => {
  const start = yaml.indexOf(key);
  if (start < 0) throw new Error(`sliceYamlBlock: "${key}" not found`);
  const lineStart = yaml.lastIndexOf('\n', start) + 1;
  const indent = /^[ \t]*/.exec(yaml.slice(lineStart))?.[0] ?? '';
  const lines = yaml.slice(lineStart).split('\n');
  let end = lines.length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const thisIndent = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (thisIndent.length <= indent.length) {
      end = i;
      break;
    }
  }
  return lines.slice(0, end).join('\n');
};

/**
 * The YAML list entry (a workflow STEP) that contains `key`.
 *
 * `sliceYamlBlock` takes the block a key OWNS; a step's `id:` owns nothing, so
 * asking for it returns one line and an assertion about its sibling `if:`
 * fails. This climbs to the `- ` that starts the entry and takes the whole of
 * it.
 */
export const sliceYamlEntry = (yaml: string, key: string): string => {
  const at = yaml.indexOf(key);
  if (at < 0) throw new Error(`sliceYamlEntry: "${key}" not found`);
  const lines = yaml.split('\n');
  let idx = yaml.slice(0, at).split('\n').length - 1;
  while (idx >= 0 && !/^\s*- /.test(lines[idx])) idx--;
  if (idx < 0) throw new Error(`sliceYamlEntry: no list entry around "${key}"`);
  const indent = (/^[ \t]*/.exec(lines[idx]) ?? [''])[0];
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ind = (/^[ \t]*/.exec(lines[i]) ?? [''])[0];
    if (ind.length <= indent.length) {
      end = i;
      break;
    }
  }
  return lines.slice(idx, end).join('\n');
};

/**
 * From `from` up to the next `to`, exclusive.
 *
 * For a section that is delimited by the thing that comes after it - numbered
 * guards in a migration, banner comments in a long function - where the honest
 * bound is "until the next one starts" and a byte count is a guess that goes
 * stale the moment the section gains a line.
 */
export const sliceBetween = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  if (start < 0) throw new Error(`sliceBetween: "${from}" not found`);
  const end = src.indexOf(to, start + from.length);
  return end < 0 ? src.slice(start) : src.slice(start, end);
};
