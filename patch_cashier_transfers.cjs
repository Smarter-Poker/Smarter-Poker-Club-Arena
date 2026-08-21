const fs = require('fs');
const file = 'src/pages/CashierTradePage.tsx';
let code = fs.readFileSync(file, 'utf8');

const runTransfersTarget = `    let ok = 0;
    let skipped = 0;
    try {
      for (const t of targets) {
        try {`;

const runTransfersReplacement = `    const successes: string[] = [];
    const failures: { name: string; error: string }[] = [];
    let skipped = 0;
    try {
      // Execute transfers in parallel batches to speed up bulk sending (up to 50 players)
      const BATCH_SIZE = 5;
      for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        const batch = targets.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (t) => {
          try {`;

code = code.replace(runTransfersTarget, runTransfersReplacement);

const transferCatchTarget = `          ok++;
        } catch (e) {
          reportError(e, 'CashierTradePage.' + kind);
          toast?.error?.(\`\${t.name}: \${(e as Error).message || 'Transfer Failed'}\`);
        }
      }
    } finally {`;

const transferCatchReplacement = `          successes.push(t.name);
        } catch (e) {
          reportError(e, 'CashierTradePage.' + kind);
          failures.push({ name: t.name, error: (e as Error).message || 'Transfer Failed' });
        }
      }));
    }
    } finally {`;

code = code.replace(transferCatchTarget, transferCatchReplacement);

const transferEndTarget = `    if (ok > 0) {
      toast?.success?.(
        kind === 'send'
          ? \`Sent \${fmt(value)} To \${ok} Player\${ok === 1 ? '' : 's'}\`
          : kind === 'ticket'
            ? \`Issued \${ok} Ticket\${ok === 1 ? '' : 's'} Worth \${fmt(value)} Each\`
            : \`Claimed Back From \${ok} Player\${ok === 1 ? '' : 's'}\`
      );
      // The bus event is already wired to reload this page, so calling
      // loadClub() as well fired two identical loads at once.
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade', userId: user.id });
    } else if (skipped > 0) {
      toast?.info?.(
        \`Nothing To Claim Back: \${skipped} Player\${skipped === 1 ? ' Has' : 's Have'} No Chips\`
      );
    }`;

const transferEndReplacement = `    if (successes.length > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade', userId: user.id });
    }
    
    // If it's a bulk operation or there were failures, show the Bulk Results modal
    if (targets.length > 1 || failures.length > 0) {
      setTransferResults({ successes, failures });
    } else if (successes.length > 0) {
      // Single success, just toast
      toast?.success?.(
        kind === 'send'
          ? \`Sent \${fmt(value)} To \${successes[0]}\`
          : kind === 'ticket'
            ? \`Issued Ticket Worth \${fmt(value)} To \${successes[0]}\`
            : \`Claimed Back From \${successes[0]}\`
      );
    } else if (skipped > 0) {
      toast?.info?.('Nothing To Claim Back: Player Has No Chips');
    }`;

code = code.replace(transferEndTarget, transferEndReplacement);
fs.writeFileSync(file, code);
