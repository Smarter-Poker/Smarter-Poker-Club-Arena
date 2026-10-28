/** Parse only the maintained scalar or typed opt-in certificate budget. */
export function timeoutBudgetMinutes(value: string): { ordinary: number; optIn: number } {
  if (/^\d+$/.test(value)) return { ordinary: Number(value), optIn: Number(value) };
  const selected = value.match(
    /^\$\{\{ github\.event_name == 'repository_dispatch' && toJSON\(github\.event\.client_payload\.mobile_multirun\) == 'true' && (\d+) \|\| (\d+) \}\}$/
  );
  const sharedObservation = value.match(
    /^\$\{\{ github\.event_name == 'repository_dispatch' && \(toJSON\(github\.event\.client_payload\.mobile_multirun\) == 'true' \|\| toJSON\(github\.event\.client_payload\.horse_social\) == 'true'\) && (\d+) \|\| (\d+) \}\}$/
  );
  const admitted = selected || sharedObservation;
  if (!admitted) throw new Error(`Unrecognized Fixture Job Budget: ${value}`);
  return { ordinary: Number(admitted[2]), optIn: Number(admitted[1]) };
}

export function workflowJobBudget(source: string, job: string) {
  const marker = `\n  ${job}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing Fixture Job: ${job}`);
  const remaining = source.slice(start + marker.length);
  const next = remaining.search(/\n {2}[a-z0-9-]+:\n/);
  const body = next < 0 ? remaining : remaining.slice(0, next);
  const value = body.match(/^ {4}timeout-minutes: (.+)$/m)?.[1];
  if (!value) throw new Error(`Missing Fixture Job Budget: ${job}`);
  return timeoutBudgetMinutes(value);
}
