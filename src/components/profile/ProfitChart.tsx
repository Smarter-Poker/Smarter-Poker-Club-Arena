/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROFIT CHART — Lazy-loaded Recharts component (#5 Performance, v1.1)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Extracted from ProfilePage to enable React.lazy() code-splitting.
 * The 387KB Recharts bundle is only downloaded when the user opens the History tab.
 *
 * v1.1: Added premium empty state when no transactions exist.
 */

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface ProfitChartProps {
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    created_at: string;
    description?: string;
  }>;
}

export default function ProfitChart({ transactions }: ProfitChartProps) {
  // #12: Empty state
  if (!transactions || transactions.length === 0) {
    return (
      <div
        style={{
          width: '100%',
          height: 200,
          marginBottom: 16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0, 20, 40, 0.4)',
          borderRadius: 12,
          border: '1px solid rgba(255, 255, 255, 0.05)',
        }}
      >
        <div
          style={{
            fontSize: '2rem',
            opacity: 0.3,
            marginBottom: 8,
            animation: 'animationsProfitChartPulse 3s ease-in-out infinite',
          }}
        >
          ▦
        </div>
        <div
          style={{
            fontSize: '0.75rem',
            color: '#5a6a7a',
            fontWeight: 600,
          }}
        >
          No Transaction History Yet
        </div>
        <div
          style={{
            fontSize: '0.65rem',
            color: '#3a4a5a',
            marginTop: 4,
          }}
        >
          Start Playing To See Your P/L Chart
        </div>
        <style>{`
                    @keyframes profitChartPulse {
                        0%, 100% { opacity: 0.3; transform: scale(1); }
                        50% { opacity: 0.5; transform: scale(1.05); }
                    }
                `}</style>
      </div>
    );
  }

  const data = (() => {
    let cumulative = 0;
    const grouped: Record<string, number> = {};
    transactions.forEach((tx) => {
      const day = new Date(tx.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      const amt = tx.type === 'credit' ? tx.amount || 0 : -(tx.amount || 0);
      grouped[day] = (grouped[day] || 0) + amt;
    });
    return Object.entries(grouped).map(([day, net]) => {
      cumulative += net;
      return { day, profit: Math.round(cumulative) };
    });
  })();

  return (
    <div style={{ width: '100%', height: 200, marginBottom: 16 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#00d4ff" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#00d4ff" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="day"
            tick={{ fill: '#6a7a8a', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#6a7a8a', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={50}
          />
          <Tooltip
            contentStyle={{
              background: '#1a2332',
              border: '1px solid #2a3a4a',
              borderRadius: 8,
              color: '#fff',
              fontSize: 12,
            }}
            formatter={(value: any) => [Number(value).toLocaleString(), 'Cumulative P/L']}
          />
          <Area
            type="monotone"
            dataKey="profit"
            stroke="#00d4ff"
            fill="url(#profitGrad)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
