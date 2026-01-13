/**
 * 🔴 SYSTEM OFFLINE — Fail-Closed Screen
 * ═══════════════════════════════════════════════════════════════════════════════
 * This component renders when AntiGravity boot fails.
 * It displays exactly what is missing for debugging.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { BootStatus } from './AntiGravityBoot';

interface Props {
    status: BootStatus;
}

export default function SystemOffline({ status }: Props) {
    return (
        <div style={{
            minHeight: '100vh',
            background: 'linear-gradient(135deg, #1a1a2e 0%, #0f0f1a 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'Inter, system-ui, sans-serif',
            color: '#fff',
            padding: '2rem'
        }}>
            <div style={{
                maxWidth: '600px',
                textAlign: 'center'
            }}>
                {/* Status Icon */}
                <div style={{
                    fontSize: '4rem',
                    marginBottom: '1.5rem',
                    animation: 'pulse 2s infinite'
                }}>
                    🔴
                </div>

                {/* Title */}
                <h1 style={{
                    fontSize: '2rem',
                    fontWeight: 700,
                    marginBottom: '0.5rem',
                    background: 'linear-gradient(90deg, #ff6b6b, #ee5a24)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent'
                }}>
                    SYSTEM OFFLINE
                </h1>

                <p style={{
                    color: 'rgba(255,255,255,0.6)',
                    marginBottom: '2rem'
                }}>
                    Anti-Gravity failed to initialize. Missing configuration detected.
                </p>

                {/* Status Grid */}
                <div style={{
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '12px',
                    padding: '1.5rem',
                    marginBottom: '2rem',
                    border: '1px solid rgba(255,255,255,0.1)'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <span>ANTIGRAVITY_OK</span>
                        <span style={{ color: status.antigravityOk ? '#2ecc71' : '#e74c3c' }}>
                            {status.antigravityOk ? '✅ true' : '❌ false'}
                        </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>SUPABASE_OK</span>
                        <span style={{ color: status.supabaseOk ? '#2ecc71' : '#e74c3c' }}>
                            {status.supabaseOk ? '✅ true' : '❌ false'}
                        </span>
                    </div>
                </div>

                {/* Error List */}
                {status.errors.length > 0 && (
                    <div style={{
                        background: 'rgba(231, 76, 60, 0.1)',
                        borderRadius: '12px',
                        padding: '1.5rem',
                        textAlign: 'left',
                        border: '1px solid rgba(231, 76, 60, 0.3)'
                    }}>
                        <h3 style={{ color: '#e74c3c', marginBottom: '1rem', fontSize: '0.9rem' }}>
                            ⚠️ MISSING CONFIGURATION
                        </h3>
                        <ul style={{ margin: 0, paddingLeft: '1.5rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.85rem' }}>
                            {status.errors.map((err, i) => (
                                <li key={i} style={{ marginBottom: '0.5rem' }}>{err}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Timestamp */}
                <p style={{
                    marginTop: '2rem',
                    fontSize: '0.75rem',
                    color: 'rgba(255,255,255,0.3)'
                }}>
                    Boot Attempt: {status.timestamp}
                </p>
            </div>

            {/* Pulse Animation */}
            <style>{`
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            `}</style>
        </div>
    );
}
