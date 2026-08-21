const fs = require('fs');
const file = 'src/pages/ClubHomePage.tsx';
let content = fs.readFileSync(file, 'utf8');

// Replace the bbj_pools query
const bbjQueryBlock = `const q = supabase.from('bbj_pools').select('id, main_balance');
            const scoped = unionId ? q.eq('union_id', unionId) : q.eq('club_id', resolvedId);
            return await scoped.limit(1).maybeSingle();`;

const replacement = `const q = supabase.from('bbj_pools').select('id, main_balance');
            if (unionId) {
              const allIds = [resolvedId, ...(unionClubIds || [])];
              const filter = \`union_id.eq.\${unionId},club_id.in.(\${allIds.join(',')})\`;
              return await q.or(filter);
            } else {
              return await q.eq('club_id', resolvedId).limit(1).maybeSingle();
            }`;

content = content.replace(bbjQueryBlock, replacement);

// Replace the result handler
const resultHandler = `if (bbjResult?.data && !(bbjResult as any).error) {
        const initial = Number((bbjResult.data as any)?.main_balance);
        setJackpotAmount(Number.isFinite(initial) ? initial : 0);
        setBbjPoolId((bbjResult.data as any)?.id || null);
      }`;

const handlerReplacement = `if (bbjResult?.data && !(bbjResult as any).error) {
        if (Array.isArray(bbjResult.data)) {
          let sum = 0;
          let unionPoolId = null;
          for (const row of bbjResult.data) {
            const bal = Number(row.main_balance);
            if (Number.isFinite(bal)) sum += bal;
            // Prefer the first pool ID we find (or we could specifically find the union's)
            if (!unionPoolId) unionPoolId = row.id;
          }
          setJackpotAmount(sum);
          setBbjPoolId(unionPoolId);
        } else {
          const initial = Number((bbjResult.data as any)?.main_balance);
          setJackpotAmount(Number.isFinite(initial) ? initial : 0);
          setBbjPoolId((bbjResult.data as any)?.id || null);
        }
      }`;

content = content.replace(resultHandler, handlerReplacement);

fs.writeFileSync(file, content);
