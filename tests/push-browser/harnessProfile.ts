/** Local profile-read adapter for the real phone-verification prompt gate.
 * No production Supabase client or project is loaded by this browser fixture.
 */
export const supabase = {
  from(table: string) {
    if (table !== 'profiles') throw new Error('Unexpected Harness Table');
    return {
      select(columns: string) {
        if (columns !== 'phone_verified') throw new Error('Unexpected Harness Columns');
        return {
          eq(column: string, userId: string) {
            if (column !== 'id') throw new Error('Unexpected Harness Profile Filter');
            return {
              async maybeSingle() {
                const response = await fetch(
                  `/__harness/profile?uid=${encodeURIComponent(userId)}`
                );
                if (!response.ok)
                  return { data: null, error: { message: 'Harness Profile Read Failed' } };
                return { data: await response.json(), error: null };
              },
            };
          },
        };
      },
    };
  },
};
