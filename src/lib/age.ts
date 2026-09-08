/**
 * Age arithmetic shared by the age gate (src/components/legal/AgeGate.tsx)
 * and the sign-up form (src/pages/AuthPage.tsx, native build). Pure and
 * dependency-free so AuthPage can validate a date of birth without pulling
 * the gate's component and stylesheet into its chunk.
 */

export const MINIMUM_AGE = 18;

/** Pure: whole years between a birthday and a reference date. Exported for tests. */
export function ageOn(birthday: string, today: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const b = new Date(Date.UTC(y, mo - 1, d));
  if (b.getUTCFullYear() !== y || b.getUTCMonth() !== mo - 1 || b.getUTCDate() !== d) return null;
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/** The latest date of birth that is 18 today, for the input's max. */
export function latestAdultBirthday(today: Date): string {
  const d = new Date(
    Date.UTC(today.getUTCFullYear() - MINIMUM_AGE, today.getUTCMonth(), today.getUTCDate())
  );
  return d.toISOString().slice(0, 10);
}
