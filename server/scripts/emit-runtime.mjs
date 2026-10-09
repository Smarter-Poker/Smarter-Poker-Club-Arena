#!/usr/bin/env node
// Release CI independently typechecks the complete runtime and compares every
// output byte. This is only its bounded, sequential image-emission step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

export const HEAP_FLAGS = ['--max-old-space-size=512', '--max-semi-space-size=4'];
export const MAX_BATCH_FILES = 64;
export const MAX_BATCH_BYTES = 1024 * 1024;

export function planBatches(files, sizeOf = (file) => fs.statSync(file).size) {
  if (!files.length || new Set(files).size !== files.length) {
    throw new Error('Runtime roots must be nonempty and unique');
  }
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const file of [...files].sort()) {
    const size = sizeOf(file);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BATCH_BYTES) {
      throw new Error(`Runtime source exceeds the qualified per-batch bound: ${file}`);
    }
    if (batch.length && (batch.length === MAX_BATCH_FILES || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function failDiagnostics(diagnostics) {
  if (diagnostics.length) {
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      })
    );
  }
}

export function readProject() {
  const project = path.resolve('tsconfig.emit.json');
  const config = ts.readConfigFile(project, ts.sys.readFile);
  failDiagnostics(config.error ? [config.error] : []);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  failDiagnostics(parsed.errors);
  const options = parsed.options;
  if (
    options.noCheck !== true ||
    options.noResolve !== true ||
    !Array.isArray(options.types) ||
    options.types.length !== 0 ||
    options.declaration !== false ||
    options.declarationMap !== false ||
    options.noEmit ||
    options.outFile ||
    options.incremental ||
    options.composite ||
    options.rootDir !== path.resolve('src') ||
    options.outDir !== path.resolve('dist')
  ) {
    throw new Error('Runtime emit project changed its qualified independent-output profile');
  }
  return { options, batches: planBatches(parsed.fileNames), roots: parsed.fileNames.length };
}

export function emitBatch(files, options) {
  // noResolve keeps each program bounded to these roots plus the standard lib.
  // A fresh child per batch releases its ASTs before the next program begins.
  const program = ts.createProgram(files, options);
  failDiagnostics(program.getOptionsDiagnostics());
  failDiagnostics(program.getSyntacticDiagnostics());
  const result = program.emit();
  failDiagnostics(result.diagnostics);
  if (result.emitSkipped) throw new Error('Runtime emission was skipped');
}

export function emitRuntime(args = process.argv.slice(2)) {
  if (JSON.stringify(process.execArgv) !== JSON.stringify(HEAP_FLAGS)) {
    throw new Error('Runtime emitter requires the exact 512 MiB old / 4 MiB semi-space profile');
  }
  const { options, batches, roots } = readProject();
  if (args.length === 2 && args[0] === '--batch-index' && /^(0|[1-9][0-9]*)$/.test(args[1])) {
    const index = Number(args[1]);
    if (index >= batches.length) throw new Error('Unknown runtime emission batch');
    emitBatch(batches[index], options);
    console.log(
      JSON.stringify({
        runtimeEmitBatch: index,
        roots: batches[index].length,
        maxRssKiB: process.resourceUsage().maxRSS,
      })
    );
    return;
  }
  if (args.length !== 2 || args[0] !== '--project' || args[1] !== 'tsconfig.emit.json') {
    throw new Error('Expected --project tsconfig.emit.json');
  }
  // Sequential children share the original Docker build cgroup and deadline.
  // No parallel workers, fallback compiler, retries or enlarged heap.
  for (let index = 0; index < batches.length; index += 1) {
    const result = spawnSync(
      process.execPath,
      [...HEAP_FLAGS, fileURLToPath(import.meta.url), '--batch-index', String(index)],
      { stdio: 'inherit' }
    );
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(
        `Runtime emission batch ${index} failed (${result.signal || result.status})`,
        { cause: result.error }
      );
    }
  }
  console.log(JSON.stringify({ runtimeEmitComplete: true, roots, batches: batches.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  emitRuntime();
}
