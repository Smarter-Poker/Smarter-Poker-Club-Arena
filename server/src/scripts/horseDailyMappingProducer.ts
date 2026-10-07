/** P14.3 explicit private mapping producer CLI. Read-only service RPCs and a
 * read-only journal; it writes only new private files into a new empty private
 * directory. No database write, journal write, lease, signer or policy effect.
 * The manifest it writes carries no authority: that stays a missing input. */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { utcDay } from '../services/horseDailyCorrectiveReview/validation.js';
import type { DailySource } from '../services/horseDailyCorrectiveReview/contract.js';
import type { AcceptedSourceRowsReader } from '../services/horseDailyCorrectiveReview/source.js';
import type { JournalHandReader } from '../services/horseDailyCorrectiveReview/mapping.js';
export interface DailyMappingExecutionDependencies {
  source?: DailySource;
  rows?: AcceptedSourceRowsReader;
  readJournalHand?: JournalHandReader;
}
const USAGE =
  'Usage: horseDailyMappingProducer <YYYY-MM-DD> <absolute-private-journal> <new-empty-absolute-private-output-directory>\n';
export async function runHorseDailyMappingProducer(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  injected: DailyMappingExecutionDependencies = {}
): Promise<{ code: number; output: string }> {
  if (args.length !== 3 || !utcDay(args[0]) || !isAbsolute(args[1]!) || !isAbsolute(args[2]!))
    return { code: 64, output: USAGE };
  const [day, journalDirectory, outputDirectory] = [args[0]!, args[1]!, args[2]!];
  const capturedEnvironment = Object.freeze({
    SUPABASE_URL: environment.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: environment.SUPABASE_SERVICE_ROLE_KEY,
  });
  const supplied = { ...injected };
  try {
    // A fresh, empty, private, non-aliased directory: nothing can be overwritten
    // and no earlier mapping can be mistaken for this one.
    const s = lstatSync(outputDirectory);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (s.mode & 0o077) !== 0 ||
      (process.getuid && s.uid !== process.getuid()) ||
      realpathSync(outputDirectory) !== outputDirectory ||
      readdirSync(outputDirectory).length !== 0 ||
      realpathSync(journalDirectory) === outputDirectory
    )
      throw Error('daily_mapping_output_invalid');
    const [{ produceDailyMapping, readOnlyJournalHandReader }, sourceModule, files] =
      await Promise.all([
        import('../services/horseDailyCorrectiveReview/mapping.js'),
        import('../services/horseDailyCorrectiveReview/source.js'),
        import('../services/horseCorrectiveReview/privateFiles.js'),
      ]);
    const result = await produceDailyMapping(
      { day, after: null, journalDirectory, outputDirectory },
      {
        source: supplied.source ?? sourceModule.createDailyReviewSource(capturedEnvironment),
        rows: supplied.rows ?? sourceModule.createAcceptedSourceRowsReader(capturedEnvironment),
        readJournalHand: supplied.readJournalHand ?? (await readOnlyJournalHandReader()),
      }
    );
    for (const file of result.files)
      files.writePrivateCorrectiveResult(file.path, file.json, file.maximumBytes);
    files.writePrivateCorrectiveResult(
      `${outputDirectory}/report.json`,
      JSON.stringify(result.report) + '\n'
    );
    return {
      code: result.report.status === 'mapped_selection' ? 0 : 2,
      output:
        JSON.stringify({
          status: result.report.status,
          scope: result.report.scope,
          pages: result.report.pages,
          hands: result.report.hands.length,
          mapped: result.report.hands.filter((h) => h.status === 'mapped').length,
          outputWritten: true,
          authority: 'missing_input',
          databaseWrites: false,
          fullWindow: false,
          sourcePopulationVerified: false,
          gtoVerified: false,
          activationAllowed: false,
        }) + '\n',
    };
  } catch {
    return {
      code: 3,
      output: 'Private daily Horse mapping unavailable; no mapping, review or authority claimed.\n',
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runHorseDailyMappingProducer(process.argv.slice(2), process.env);
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
