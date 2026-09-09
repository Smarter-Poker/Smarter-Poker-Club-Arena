import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ignoredSourceFile = /\.(?:test|spec)\.[^.]+$/;

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile() && !ignoredSourceFile.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

export function runtimeFilesMatching(directories: readonly string[], pattern: RegExp): string[] {
  return directories.flatMap((directory) =>
    walk(directory).filter((path) => pattern.test(readFileSync(path, 'utf8')))
  );
}
