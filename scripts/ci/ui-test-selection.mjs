import ts from 'typescript';
import postcss from 'postcss';
import { gitEnvironmentForCwd } from './classify-ci-changes.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, appendFileSync, lstatSync } from 'node:fs';
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

// Configuration is executable code. Recognize only these positive proofs;
// never exempt a directory, filename suffix, or an arbitrary literal edit.
export function configOnly(path, before, after) {
  if (!/^src\/config\/[^/]+\.ts$/.test(path) || before === after) return false;
  if (
    /(?:cashier|financial|wallet|diamond|insurance|rabbit|rebuy|buyin|payout|bank|credit|bonus|commission|rake|bbj)/i.test(
      path
    )
  )
    return false;
  const parse = (text) => {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (file.parseDiagnostics.length) throw Error('Invalid configuration');
    return file;
  };
  const mask = (text, ranges) => {
    for (const [start, end] of ranges.reverse())
      text = text.slice(0, start) + ' CONFIG_VALUE ' + text.slice(end);
    return text;
  };
  try {
    const a = parse(before),
      b = parse(after);
    // Only existing top-level interfaces/type aliases may change. Runtime
    // declarations, imports, comments and compiler directives remain exact.
    // In particular, const enums are NOT erased types: consumers inline them.
    const types = (file) =>
      file.statements.filter((n) => ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n));
    const at = types(a),
      bt = types(b);
    if (
      at.length &&
      at.length === bt.length &&
      at.every((n, i) => n.kind === bt[i].kind && n.name.text === bt[i].name.text)
    ) {
      const signature = (text, nodes, file) =>
        mask(
          text,
          nodes.map((n) => [n.getStart(file), n.end])
        );
      const emit = (text) =>
        ts.transpileModule(text, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            isolatedModules: true,
          },
        }).outputText;
      if (signature(before, at, a) === signature(after, bt, b) && emit(before) === emit(after))
        return true;
    }
    // Navigation labels/descriptions may change; routes, role predicates,
    // actions, identifiers and every other byte must remain identical.
    if (
      !/^src\/config\/(?:arenaSectionNavigation|clubArenaNavigation|clubIntegrityNavigation|clubOperationsNavigation)\.ts$/.test(
        path
      )
    )
      return false;
    const labels = (file) => {
      const ranges = [],
        values = [];
      const visit = (n) => {
        if (
          ts.isPropertyAssignment(n) &&
          ts.isIdentifier(n.name) &&
          /^(?:label|description)$/.test(n.name.text) &&
          ts.isStringLiteral(n.initializer)
        ) {
          ranges.push([n.initializer.getStart(file), n.initializer.end]);
          values.push(n.initializer.text);
        }
        ts.forEachChild(n, visit);
      };
      visit(file);
      return { code: mask(file.text, ranges), values };
    };
    const al = labels(a),
      bl = labels(b);
    return (
      al.code === bl.code &&
      al.values.length === bl.values.length &&
      al.values.every((v, i) => v === bl.values[i] || !/[0-9$€£]/.test(v + bl.values[i]))
    );
  } catch {
    return false;
  }
}

export function selectionInputs(root, base, head, isolatedStyles = false) {
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
    // Tests consume the whole checkout, including tracked files absent from
    // this PR's diff. An unrelated dirty file invalidates the positive proof.
    git('diff', '--quiet', 'HEAD', '--');
    if (git('ls-files', '--others', '--exclude-standard', '--', 'src', 'server', 'supabase').trim())
      throw Error('Untracked runtime input');
    // The presentation proof may omit the unchanged bitmap scan. Ignored
    // local assets/baselines are still detector inputs, never an exemption.
    if (git('ls-files', '--others', '--', 'public/assets', 'docs/art').trim())
      throw Error('Untracked asset or art baseline input');
    const ancestor = git('merge-base', '--all', base, head).trim();
    if (!/^[0-9a-f]{40}$/.test(ancestor)) throw Error('Ambiguous ancestry');
    const names = git('diff', '--name-status', '--no-renames', '-z', ancestor, head).split('\0');
    if (names.pop() !== '') throw Error('Incomplete diff');
    const changed = [];
    let provedSource = false;
    for (let i = 0; i < names.length; i += 2) {
      const [status, path] = names.slice(i, i + 2);
      const changelog = /^docs\/changelog\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(path || '');
      if (
        (status !== 'M' && !(status === 'A' && changelog)) ||
        !path ||
        path.includes('..') ||
        path.startsWith('/')
      )
        throw Error('Non-modification');
      const bytesAt = (revision) => execFileSync('git', ['show', `${revision}:${path}`], {
        cwd: root, env: gitEnvironmentForCwd(), maxBuffer: 64 * 1024 * 1024,
      });
      if (isolatedStyles) {
        if (!lstatSync(resolve(root, path)).isFile()) throw Error('Non-regular input');
        for (const revision of status === 'A' ? [head] : [ancestor, head])
          if (!/^100(?:644|755) blob /.test(git('ls-tree', revision, '--', path)))
            throw Error('Non-regular Git input');
      }
      const afterBytes = readFileSync(resolve(root, path));
      if (!afterBytes.equals(bytesAt(head))) throw Error('Changed candidate input');
      const beforeBytes = status === 'A' ? Buffer.alloc(0) : bytesAt(ancestor);
      const before = beforeBytes.toString('utf8');
      const after = afterBytes.toString('utf8');
      if (!changelog) {
        if (isolatedStyles) {
          if (/^src\/.+\.css$/.test(path)) {
            if (!Buffer.from(before).equals(beforeBytes) || !Buffer.from(after).equals(afterBytes))
              throw Error('Invalid CSS encoding');
            postcss.parse(before);
            postcss.parse(after);
          } else if (!/^public\/assets\/.+\.(?:png|webp|jpe?g)$/.test(path)) {
            throw Error('Not isolated styles or raster artwork');
          }
        } else if (!presentationOnly(path, before, after)) {
          if (!configOnly(path, before, after))
            throw Error('Not proved presentation or configuration-only');
        }
        provedSource = true;
      }
      changed.push(path);
    }
    if (!provedSource) throw Error('No proved source edit');
    return {
      focused: true,
      changed,
      reason: 'Scoped presentation or proved configuration edit; affected consumers retained',
    };
  } catch (error) {
    return { focused: false, changed: [], reason: error.message };
  }
}

// This proof only omits isolated SQL and monitoring simulations. It must not
// narrow browser/unit coverage or omit the asset matte scan. Those consumers
// still use the original presentation proof above.
export function isolatedSimulationsUnchanged(root, base, head) {
  return selectionInputs(root, base, head).focused ||
    selectionInputs(root, base, head, true).focused;
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
  const fsBindings = new Set();
  const urlFunctions = new Set();
  const readers = new Map();
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      /^(?:node:)?url$/.test(statement.moduleSpecifier.text || '')
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const entry of bindings.elements)
          if ((entry.propertyName || entry.name).text === 'fileURLToPath')
            urlFunctions.add(entry.name.text);
    }
    if (
      ts.isImportDeclaration(statement) &&
      /^(?:node:)?fs(?:\/promises)?$/.test(statement.moduleSpecifier.text || '')
    ) {
      const clause = statement.importClause;
      if (clause?.name) fsBindings.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) fsBindings.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const entry of bindings.elements) fsBindings.add(entry.name.text);
    }
    if (
      ts.isImportDeclaration(statement) &&
      /^(?:node:)?path$/.test(statement.moduleSpecifier.text || '')
    ) {
      const clause = statement.importClause;
      if (clause?.name)
        for (const method of ['join', 'resolve', 'dirname'])
          pathFunctions.add(clause.name.text + '.' + method);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        for (const method of ['join', 'resolve', 'dirname'])
          pathFunctions.add(bindings.name.text + '.' + method);
      if (bindings && ts.isNamedImports(bindings))
        for (const entry of bindings.elements)
          if (!entry.propertyName && ['join', 'resolve', 'dirname'].includes(entry.name.text))
            pathFunctions.add(entry.name.text);
    }
    // A private, one-expression read wrapper can be resolved at each direct
    // call. Any escaped reference or computed argument below still retains it.
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const &&
      !statement.modifiers?.length
    ) {
      for (const declaration of statement.declarationList.declarations) {
        const fn = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          fn &&
          ts.isArrowFunction(fn) &&
          !fn.modifiers?.length &&
          fn.parameters.length === 1 &&
          ts.isIdentifier(fn.parameters[0].name) &&
          !fn.parameters[0].initializer &&
          !fn.parameters[0].dotDotDotToken &&
          ts.isCallExpression(fn.body) &&
          (fn.body.arguments.length === 1 ||
            (fn.body.arguments.length === 2 && ts.isStringLiteralLike(fn.body.arguments[1]))) &&
          /(?:^|\.)readFileSync$/.test(fn.body.expression.getText(ast))
        )
          readers.set(declaration.name.text, {
            declaration,
            fn,
            parameter: fn.parameters[0].name.text,
            read: fn.body,
          });
      }
    }
  }
  const bindingNames = (name) => {
    if (ts.isIdentifier(name)) localNames.add(name.text);
    else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) bindingNames(element.name);
  };
  const collect = (n) => {
    if (ts.isParameter(n)) bindingNames(n.name);
    if (ts.isVariableDeclaration(n) && !ts.isIdentifier(n.name)) bindingNames(n.name);
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
  const value = (n, parameters = new Map()) => {
    if (!n) return undefined;
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isIdentifier(n))
      return parameters.has(n.text)
        ? parameters.get(n.text)
        : localNames.has(n.text)
          ? undefined
          : n.text === '__dirname'
            ? dirname(path)
            : vars.get(n.text);
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(ast);
      if (
        urlFunctions.has(name) &&
        !localNames.has(name) &&
        n.arguments.length === 1 &&
        n.arguments[0].getText(ast) === 'import.meta.url'
      )
        return path;
      if (name === 'process.cwd' && !vars.has('process') && !localNames.has('process')) return root;
      if (pathFunctions.has(name) && !localNames.has(name.split('.')[0])) {
        const args = n.arguments.map((arg) => value(arg, parameters));
        return args.every((a) => typeof a === 'string')
          ? name.endsWith('dirname')
            ? args.length === 1
              ? dirname(args[0])
              : undefined
            : name.endsWith('join')
              ? join(...args)
              : resolve(root, ...args)
          : undefined;
      }
    }
    return undefined;
  };
  const visit = (n) => {
    if (ts.isArrowFunction(n) && [...readers.values()].some((reader) => reader.fn === n)) return;
    if (ts.isIdentifier(n) && readers.has(n.text)) {
      const reader = readers.get(n.text);
      if (
        n !== reader.declaration.name &&
        !(ts.isCallExpression(n.parent) && n.parent.expression === n)
      )
        unknown = true;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !localNames.has(n.name.text))
      vars.set(n.name.text, value(n.initializer));
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(ast);
      if (readers.has(name)) {
        ioCalls++;
        const reader = readers.get(name);
        const input =
          n.arguments.length === 1 && !localNames.has(name)
            ? value(reader.read.arguments[0], new Map([[reader.parameter, value(n.arguments[0])]]))
            : undefined;
        if (typeof input !== 'string') unknown = true;
        else paths.push(relative(root, resolve(root, input)));
      }
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
    // Array indexing and data destructuring are not filesystem reads. Retain
    // uncertainty where an actual fs binding escapes, is aliased/destructured,
    // or is called indirectly. Computed read paths are handled above.
    if (ts.isIdentifier(n) && fsBindings.has(n.text)) {
      const parent = n.parent;
      const imported =
        ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      const callee = ts.isPropertyAccessExpression(parent) && parent.expression === n ? parent : n;
      const called = ts.isCallExpression(callee.parent) && callee.parent.expression === callee;
      if (!imported && !called) unknown = true;
    }
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
  if (mode === 'scope') {
    if (!env.GITHUB_OUTPUT) throw Error('Compiler scope output is missing');
    // Only positive presentation/configuration proofs may omit the unchanged
    // SQL replay. Financial, executable, mixed and unknown inputs keep it.
    appendFileSync(env.GITHUB_OUTPUT, `presentation_only=${proof.focused}\n`);
    appendFileSync(env.GITHUB_OUTPUT,
      `isolated_simulations_unchanged=${proof.focused || selectionInputs(root, env.CI_BASE_SHA, env.CI_HEAD_SHA, true).focused}\n`);
  } else if (mode === 'unit') {
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
