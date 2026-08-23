const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf-8');

// 1. Move COL_STARTS in 'MTT'
code = code.replace(
  '        COL_TNAME,\n        COL_VARIANT,\n        COL_BUYIN,\n        COL_GTD,\n        COL_PLAYERS,\n        COL_STARTS,\n        COL_SPEED,\n        COL_STATUS,',
  '        COL_TNAME,\n        COL_VARIANT,\n        COL_STARTS,\n        COL_BUYIN,\n        COL_GTD,\n        COL_PLAYERS,\n        COL_SPEED,\n        COL_STATUS,'
);

// 2. Add LiveCountdown component
const countdownCode = `
function LiveCountdown({ time }: { time: string | number | Date }) {
  const [mins, setMins] = useState(() => Math.max(0, Math.floor((new Date(time).getTime() - Date.now()) / 60000)));

  useEffect(() => {
    const t = new Date(time).getTime();
    if (isNaN(t)) return;
    const update = () => {
      setMins(Math.max(0, Math.floor((t - Date.now()) / 60000)));
    };
    update();
    const interval = setInterval(update, 10000); // Check every 10s to ensure it updates close to the minute mark
    return () => clearInterval(interval);
  }, [time]);

  if (mins <= 0 || mins > 60) return null;
  return <span className="lt-countdown" style={{ fontSize: '0.65rem', color: '#ef4444', fontWeight: 600, marginRight: '8px', fontStyle: 'italic' }}>Starts in {mins} min...</span>;
}
`;

// Insert it above LobbyStatusBadge
code = code.replace('export function LobbyStatusBadge', countdownCode + '\nexport function LobbyStatusBadge');

// 3. Update COL_STATUS to include LiveCountdown if it's a registering tournament
code = code.replace(
  '<LobbyStatusBadge status={e.status} label={e.statusLabel} />',
  '{e.kind === \'tourn\' && e.status === \'registering\' && e.startTime && <LiveCountdown time={e.startTime} />}\n      <LobbyStatusBadge status={e.status} label={e.statusLabel} />'
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
