import ts from 'typescript';
import postcss from 'postcss';
import { gitEnvironmentForCwd } from './classify-ci-changes.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname, relative, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A positive proof, never a filename-only exemption for executable UI logic.
// Only scoped styles without global escapes, or JSX text with identical code,
// qualify. Requests, amounts, handlers, imports, attributes and predicates stay
// on the full route. Unknown Git inputs or companions also stay on that route.
export function presentationOnly(path, before, after) {
  if (
    /(?:cashier|financial|wallet|diamond|insurance|rabbit|rebuy|buyin|payout|bank|credit|bonus|commission|rake)/i.test(
      path
    )
  )
    return false;
  if (/^src\/.+\.module\.css$/.test(path)) {
    try {
      let scoped = true;
      for (const text of [before, after]) {
        if (/:global|@import|@font-face|@keyframes|url\s*\(/i.test(text)) return false;
        const sheet = postcss.parse(text);
        sheet.walkAtRules((rule) => {
          if (!/^(?:media|supports|container)$/.test(rule.name)) scoped = false;
        });
        sheet.walkDecls((decl) => {
          if (decl.prop === 'composes') scoped = false;
        });
        sheet.walkRules((rule) => {
          if (rule.selectors.some((selector) => !/^\s*\.[a-zA-Z_][\w-]*/.test(selector)))
            scoped = false;
        });
      }
      return scoped;
    } catch {
      return false;
    }
  }
  if (!/^src\/(?:components|pages)\/.+\.tsx$/.test(path)) return false;
  const signature = (text) => {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (file.parseDiagnostics.length) throw Error('Invalid TSX');
    // Token positions/comments are not semantic. Preserve the full AST text
    // except JSX text nodes, which cannot change handlers or transaction code.
    const ranges = [];
    const texts = [];
    const visit = (n) => {
      if (ts.isJsxText(n)) {
        const parent = n.parent;
        const tag = ts.isJsxElement(parent) ? parent.openingElement.tagName.getText(file) : '';
        texts.push({
          text: n.text,
          safe: /^(?:button|span|div|p|label|strong|em|small|h[1-6]|a|li|td|th)$/.test(tag),
        });
        ranges.push([n.pos, n.end]);
      } else ts.forEachChild(n, visit);
    };
    visit(file);
    for (const [start, end] of ranges.reverse())
      text = text.slice(0, start) + ' UI_TEXT ' + text.slice(end);
    return { code: text, texts };
  };
  try {
    const a = signature(before),
      b = signature(after);
    return (
      before !== after &&
      a.code === b.code &&
      a.texts.length === b.texts.length &&
      a.texts.every(
        (t, i) =>
          t.text === b.texts[i].text ||
          (t.safe && b.texts[i].safe && !/[0-9$€£]/.test(t.text + b.texts[i].text))
      )
    );
  } catch {
    return false;
  }
}

export function selectionInputs(root, base, head) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      env: gitEnvironmentForCwd(),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    if (![base, head].every((s) => /^[0-9a-f]{40}$/.test(s || '')))
      throw Error('Missing immutable inputs');
    const current = git('rev-parse', 'HEAD').trim();
    if (current !== head) {
      const parents = git('show', '-s', '--format=%P', current).trim().split(' ');
      if (parents.length !== 2 || !parents.includes(base) || !parents.includes(head))
        throw Error('Wrong checkout');
    }
    const ancestor = git('merge-base', '--all', base, head).trim();
    if (!/^[0-9a-f]{40}$/.test(ancestor)) throw Error('Ambiguous ancestry');
    const names = git('diff', '--name-status', '--no-renames', '-z', ancestor, head).split('\0');
    if (names.pop() !== '') throw Error('Incomplete diff');
    const changed = [];
    for (let i = 0; i < names.length; i += 2) {
      const [status, path] = names.slice(i, i + 2);
      if (status !== 'M' || !path || path.includes('..') || path.startsWith('/'))
        throw Error('Non-modification');
      const before = git('show', `${ancestor}:${path}`);
      const after = readFileSync(resolve(root, path), 'utf8');
      if (after !== git('show', `${head}:${path}`)) throw Error('Changed candidate input');
      if (!presentationOnly(path, before, after)) throw Error('Not proved presentation-only');
      changed.push(path);
    }
    if (!changed.length) throw Error('Empty diff');
    return {
      focused: true,
      changed,
      reason: 'Scoped CSS or JSX text only; executable code unchanged',
    };
  } catch (error) {
    return { focused: false, changed: [], reason: error.message };
  }
}

function files(root, dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((e) => {
    const p = dir + '/' + e.name;
    return e.isDirectory() ? files(root, p) : [p];
  });
}

// Resolve source reads without executing tests. A computed path, directory
// scan or unresolved local import retains the test. Package imports are fixed
// by the lockfile, which is excluded from the focused route.
export function consumedInputs(root, entry, seen = new Set(), cache = new Map()) {
  if (seen.has(entry)) return { paths: [], unknown: false };
  seen.add(entry);
  const path = resolve(root, entry);
  // Cache each file's own analysis, not a closure computed inside another
  // traversal: caching a partial cyclic closure could omit a later reader.
  const expand = (own) => {
    const result = { paths: [...own.paths], unknown: own.unknown };
    for (const childPath of own.imports) {
      const child = consumedInputs(root, childPath, seen, cache);
      result.paths.push(...child.paths);
      result.unknown ||= child.unknown;
    }
    return result;
  };
  if (cache.has(path)) return expand(cache.get(path));
  const imports = [];
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const vars = new Map();
  const localNames = new Set();
  const pathFunctions = new Set();
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      /^(?:node:)?path$/.test(statement.moduleSpecifier.text || '')
    ) {
      const clause = statement.importClause;
      if (clause?.name)
        for (const method of ['join', 'resolve'])
          pathFunctions.add(clause.name.text + '.' + method);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        for (const method of ['join', 'resolve'])
          pathFunctions.add(bindings.name.text + '.' + method);
      if (bindings && ts.isNamedImports(bindings))
        for (const entry of bindings.elements)
          if (!entry.propertyName && ['join', 'resolve'].includes(entry.name.text))
            pathFunctions.add(entry.name.text);
    }
  }
  const collect = (n) => {
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) localNames.add(n.name.text);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      !(
        n.parent.flags & ts.NodeFlags.Const &&
        ts.isVariableStatement(n.parent.parent) &&
        ts.isSourceFile(n.parent.parent.parent)
      )
    )
      localNames.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(ast);
  const paths = [entry];
  let ioCalls = 0;
  let unknown =
    ast.parseDiagnostics.length > 0 ||
    /(?:goto\s*\(|fetch\s*\(|request\.|location|addScriptTag|<script|require\s*\(|readFileSync\s+as|readFile\s+as)/.test(
      source
    );
  const value = (n) => {
    if (!n) return undefined;
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isIdentifier(n))
      return localNames.has(n.text)
        ? undefined
        : n.text === '__dirname'
          ? dirname(path)
          : vars.get(n.text);
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(ast);
      if (name === 'process.cwd' && !vars.has('process') && !localNames.has('process')) return root;
      if (pathFunctions.has(name) && !localNames.has(name.split('.')[0])) {
        const args = n.arguments.map(value);
        return args.every((a) => typeof a === 'string')
          ? name.endsWith('join')
            ? join(...args)
            : resolve(...args)
          : undefined;
      }
    }
    return undefined;
  };
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !localNames.has(n.name.text))
      vars.set(n.name.text, value(n.initializer));
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(ast);
      if (
        /(?:^|\.)(?:readFileSync|readFile|readdirSync|readdir|globSync|glob|existsSync|statSync)$/.test(
          name
        )
      ) {
        ioCalls++;
        if (/(?:^|\.)glob/.test(name)) unknown = true;
        const input = value(n.arguments[0]);
        if (typeof input !== 'string') unknown = true;
        else paths.push(relative(root, resolve(root, input)));
      }
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) unknown = true;
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      if (spec.startsWith('.')) {
        const candidate = resolve(dirname(path), spec);
        const file = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']
          .map((e) => candidate + e)
          .find((p) => existsSync(p) && /\.(?:tsx?|mjs|js)$/.test(p));
        if (file) {
          imports.push(relative(root, file));
        } else if (!/\.(?:css|json)$/.test(spec)) unknown = true;
        else paths.push(relative(root, candidate));
      } else if (
        !/^(?:(?:node:)?(?:fs(?:\/promises)?|path|os|url|assert(?:\/strict)?|util)|vitest|@playwright\/test|react(?:-dom)?(?:\/.*)?|@testing-library\/[^/]+)$/.test(
          spec
        )
      ) {
        unknown = true;
      }
    }
    if (
      ts.isImportDeclaration(n) &&
      /^(?:node:)?fs(?:\/promises)?$/.test(n.moduleSpecifier.text || '')
    ) {
      const bindings = n.importClause?.namedBindings;
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (e) =>
            e.propertyName ||
            !/^(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync)$/.test(e.name.text)
        )
      )
        unknown = true;
    }
    if (
      ts.isElementAccessExpression(n) ||
      (ts.isVariableDeclaration(n) && !ts.isIdentifier(n.name))
    )
      unknown = true;
    if (
      ts.isPropertyAccessExpression(n) &&
      /^(?:readFileSync|readFile|readdirSync|globSync|existsSync|statSync)$/.test(n.name.text) &&
      !(ts.isCallExpression(n.parent) && n.parent.expression === n)
    )
      unknown = true;
    ts.forEachChild(n, visit);
  };
  visit(ast);
  if (/(?:node:fs|['"]fs(?:\/promises)?['"])/.test(source) && ioCalls === 0) unknown = true;
  const own = { paths, unknown, imports };
  cache.set(path, own);
  return expand(own);
}
const overlaps = (inputs, changed) =>
  changed.some((c) => inputs.some((p) => c === p || c.startsWith(p.replace(/\/$/, '') + '/')));
export function contractTests(root, changed) {
  const cache = new Map();
  return files(root, 'tests')
    .filter((p) => /\.test\.tsx?$/.test(p) && !p.startsWith('tests/_archive/'))
    .filter((p) => {
      const source = readFileSync(resolve(root, p), 'utf8');
      // Preserve the established source-contract basename selection, including
      // deleted sources, alongside imports and conservative dynamic readers.
      if (changed.some((c) => source.includes(basename(c)))) return true;
      const footprint = consumedInputs(root, p, new Set(), cache);
      return (
        footprint.unknown ||
        overlaps(footprint.paths, changed) ||
        /execFile|execSync|spawnSync/.test(source)
      );
    });
}
export function browserSpecs(root, changed, specs) {
  const cache = new Map();
  return specs.filter((p) => {
    const source = readFileSync(resolve(root, p), 'utf8');
    // A built-page fixture can consume the application indirectly. Keep it.
    if (/(?:goto\s*\(|fetch\s*\(|request\.)/i.test(source)) return true;
    if (changed.some((c) => source.includes(basename(c)))) return true;
    const footprint = consumedInputs(root, p, new Set(), cache);
    return footprint.unknown || overlaps(footprint.paths, changed);
  });
}

export function runSelection(root, args, env = process.env) {
  const mode = args.shift();
  const proof = selectionInputs(root, env.CI_BASE_SHA, env.CI_HEAD_SHA);
  console.log(`UI test selection: ${JSON.stringify(proof)}`);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `\nUI selection: ${JSON.stringify(proof)}\n`);
  const invoke = (bin, argv) => {
    const result = spawnSync(resolve(root, 'node_modules/.bin', bin), argv, {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`${bin} failed (${result.status})`);
  };
  if (mode === 'unit') {
    if (!proof.focused) return invoke('vitest', ['run', 'tests/', ...args]);
    // Run the conservative source-contract set, then the actual import graph.
    // Exact exclusions prevent a contract from executing twice on this shard.
    const contracts = contractTests(root, proof.changed);
    if (!contracts.length) throw Error('No source contracts discovered');
    invoke('vitest', ['run', ...contracts, ...args]);
    invoke('vitest', [
      'related',
      '--run',
      ...proof.changed,
      ...args,
      ...contracts.flatMap((p) => ['--exclude', p]),
      '--passWithNoTests',
    ]);
  } else if (mode === 'browser') {
    const split = args.findIndex((a) => a.startsWith('--'));
    if (split < 0) throw Error('Browser options missing');
    const specs = args.slice(0, split);
    const selected = proof.focused ? browserSpecs(root, proof.changed, specs) : specs;
    // An empty selection is uncertainty, never a successful zero-test gate.
    invoke('playwright', ['test', ...(selected.length ? selected : specs), ...args.slice(split)]);
  } else throw Error('Unknown selection mode');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runSelection(process.cwd(), process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
