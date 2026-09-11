/**
 * rule-metric-producers.mjs
 *
 * Shared by check-monitoring-drift.mjs (the CI guard) and its law test.
 *
 * Extracts every metric name that a Prometheus rule expression NAMES, and
 * decides whether anything in this repo EMITS it.
 *
 * The distinction matters because Prometheus does not make it for you. An
 * expression like `poker_settlement_failure_rate > 0.02` against a metric that
 * has never had a sample is not an error and not a warning: it evaluates to an
 * empty vector, forever, and the alert shows as green. Fourteen rules lived in
 * this state from 2026-09-04 to 2026-09-11, including three SMS pages.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// PromQL keywords and functions. A bare word in an expression is a metric name
// unless it is one of these.
const RESERVED = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset',
  'bool', 'and', 'or', 'unless', 'start', 'end', 'atan2', 'inf', 'nan',
  'rate', 'irate', 'increase', 'sum', 'avg', 'min', 'max', 'count',
  'count_values', 'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'group',
  'absent', 'absent_over_time', 'changes', 'delta', 'idelta', 'deriv',
  'predict_linear', 'histogram_quantile', 'histogram_count', 'histogram_sum',
  'holt_winters', 'double_exponential_smoothing', 'label_replace', 'label_join',
  'time', 'timestamp', 'vector', 'scalar', 'clamp', 'clamp_max', 'clamp_min',
  'abs', 'ceil', 'floor', 'round', 'exp', 'ln', 'log2', 'log10', 'sqrt', 'sgn',
  'resets', 'sort', 'sort_desc', 'sort_by_label', 'sort_by_label_desc',
  'day_of_week', 'day_of_month', 'day_of_year', 'days_in_month', 'hour',
  'minute', 'month', 'year', 'rad', 'deg', 'pi', 'acos', 'acosh', 'asin',
  'asinh', 'atan', 'atanh', 'cos', 'cosh', 'sin', 'sinh', 'tan', 'tanh',
  'avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time',
  'count_over_time', 'quantile_over_time', 'stddev_over_time',
  'stdvar_over_time', 'last_over_time', 'present_over_time', 'mad_over_time',
  'info', 'limitk', 'limit_ratio',
]);

// Series this stack gets from somewhere other than our own code. Prometheus
// and node_exporter emit these; the scrape-job pin (check 7) is what keeps
// those targets present, so re-checking them here would only add noise.
const FOREIGN_PREFIXES = [
  'up', 'ALERTS', 'scrape_', 'node_', 'go_', 'process_', 'prometheus_',
  'promhttp_', 'container_', 'probe_', 'alertmanager_',
];

const isForeign = (name) =>
  FOREIGN_PREFIXES.some((p) => (p.endsWith('_') ? name.startsWith(p) : name === p));

/** Pull the text of every `expr:` in a rules file, block scalars included. */
export function extractExpressions(body) {
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)expr:\s*(\|-?|>-?)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (m[2]) {
      const buf = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (!lines[j].trim()) { buf.push(''); continue; }
        if (lines[j].length - lines[j].trimStart().length <= indent) break;
        buf.push(lines[j]);
      }
      out.push(buf.join('\n'));
      i = j - 1;
    } else if (m[3]) {
      out.push(m[3]);
    }
  }
  return out;
}

/**
 * Metric names named by one expression.
 *
 * Order matters. Quoted strings go first (they can contain anything), then
 * label matchers `{...}` and aggregation label lists `by (...)`, so that label
 * NAMES are never mistaken for metric names. Comment stripping is first of
 * all: prose in a `#` comment reads as identifiers otherwise, which is how an
 * earlier hand-run of this census produced a list of rules that was wrong.
 */
export function metricsIn(expr) {
  let e = expr.replace(/#.*$/gm, '');
  e = e.replace(/"[^"]*"|'[^']*'/g, ' ');
  e = e.replace(/\{[^}]*\}/g, ' ');
  // Range selectors and offsets: `[30m]`, `[$__rate_interval]`. The unit
  // letter in `[30m]` is a standalone identifier to any regex that does not
  // remove the brackets, and `m` then sails through any substring-based
  // producer check because every source file contains the letter m.
  e = e.replace(/\[[^\]]*\]/g, ' ');
  // Bare duration literals, as in `offset 5m`. Same trap as above: the unit
  // letter survives on its own once the digits stop matching.
  e = e.replace(/\b\d+(?:\.\d+)?(ms|s|m|h|d|w|y)\b/g, ' ');
  e = e.replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  const found = new Set();
  for (const tok of e.match(/[A-Za-z_:][A-Za-z0-9_:]*/g) ?? []) {
    if (RESERVED.has(tok)) continue;
    found.add(tok);
  }
  return [...found];
}

/** Every rule (file, name, metrics) across the given rules files. */
export function rulesWithMetrics(dir, files) {
  const rules = [];
  for (const f of files) {
    const path = resolve(dir, f);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*-\s*(alert|record):\s*['"]?([\w:.-]+)/.exec(lines[i]);
      if (!m) continue;
      let j = i + 1;
      const buf = [];
      for (; j < lines.length; j++) {
        if (/^\s*-\s*(alert|record):/.test(lines[j])) break;
        if (/^\s*-?\s*name:\s/.test(lines[j])) break;
        buf.push(lines[j]);
      }
      const metrics = new Set();
      for (const e of extractExpressions(buf.join('\n'))) {
        for (const n of metricsIn(e)) metrics.add(n);
      }
      rules.push({ file: f, kind: m[1], name: m[2], metrics: [...metrics] });
      i = j - 1;
    }
  }
  return rules;
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|sh|sql|py)$/;
// `scripts/ci` is excluded deliberately: a CI script that NAMES a metric — this
// file's own header does — is not a thing that emits one. Leaving it in made
// the guard pass itself.
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'test-results', 'ci']);

function readTree(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      readTree(p, acc);
    } else if (SOURCE_EXT.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) {
      try {
        if (statSync(p).size > 4_000_000) continue;
        acc.push(readFileSync(p, 'utf8'));
      } catch { /* unreadable file is not a producer */ }
    }
  }
  return acc;
}

/**
 * The haystack a metric name must appear in to count as produced: the engine,
 * the collector scripts, and the migrations that back them. Test files are
 * deliberately excluded — a name asserted in a test but emitted nowhere is the
 * exact shape of the bug this guard exists for.
 */
export function producerHaystack(root, dirs = ['server/src', 'server/scripts', 'infra/monitoring', 'scripts']) {
  const parts = [];
  for (const d of dirs) readTree(resolve(root, d), parts);
  return parts.join('\n');
}

/** Names a rules file itself produces via `record:`. */
export function recordedNames(dir, files) {
  const out = new Set();
  for (const f of files) {
    const path = resolve(dir, f);
    if (!existsSync(path)) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(/^\s*-\s*record:\s*['"]?([\w:.-]+)/gm)) {
      out.add(m[1]);
    }
  }
  return out;
}

/**
 * A name counts as produced if the haystack contains it, or contains the
 * histogram/summary family it belongs to. A rule may legitimately reference
 * `foo_bucket` where the emitter writes `foo`, and the reverse.
 */
export function isProduced(name, haystack, recorded, declaredAbsent) {
  if (isForeign(name)) return true;
  if (recorded.has(name)) return true;
  if (declaredAbsent.has(name)) return true;
  const candidates = [name];
  const base = name.replace(/_(bucket|sum|count)$/, '');
  if (base !== name) candidates.push(base);
  for (const suffix of ['_bucket', '_sum', '_count', '_total']) candidates.push(name + suffix);
  // Word boundaries, not substring. `haystack.includes('m')` is true of every
  // source tree ever written, and `poker_foo` is a substring of
  // `poker_foobar`: either would report a metric as produced by a file that
  // never mentions it.
  return candidates.some((c) =>
    new RegExp(`(^|[^A-Za-z0-9_:])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_:]|$)`).test(haystack)
  );
}

/** Names allowed to have no producer, each with a reason, one per line. */
export function readDeclaredAbsent(dir) {
  const path = resolve(dir, 'metrics-without-a-producer.txt');
  const out = new Map();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(t);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Metric names named by Grafana dashboard panels, as {file, metrics}.
 *
 * A panel whose metric has no series renders an empty graph, which is the
 * dashboard version of an alert that cannot fire: not an error, not a warning,
 * just nothing, and the people who look at it learn to stop looking.
 */
export function dashboardsWithMetrics(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    let doc;
    try { doc = JSON.parse(readFileSync(resolve(dir, file), 'utf8')); } catch { continue; }
    const exprs = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node.expr === 'string') exprs.push(node.expr);
      Object.values(node).forEach(walk);
    };
    walk(doc);
    const metrics = new Set();
    for (const e of exprs) for (const m of metricsIn(e)) metrics.add(m);
    // Grafana template variables are not metrics.
    out.push({ file, metrics: [...metrics].filter((m) => !m.startsWith('__')) });
  }
  return out;
}

export { isForeign, RESERVED, FOREIGN_PREFIXES };
