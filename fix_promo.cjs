const fs = require('fs');
const file = 'src/components/wallet/PromoWalletCashierModal.tsx';
let code = fs.readFileSync(file, 'utf8');

const newRender = `  return (
    <div className="cbc-overlay" role="dialog" aria-modal="true" aria-label="Promo Wallet Cashier" onClick={() => !sending && onClose()}>
      <div className="cbc-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cbc-head">
          <div className="cbc-title">PROMO WALLET CASHIER</div>
          <button className="cbc-x" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="cbc-bank">
          <span>Promo Wallet Balance</span>
          <strong>{promoBalance === null ? '...' : promoBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
        </div>

        <div className="cbc-body">
          <div className="cbc-field">
            <label className="cbc-label">Recipient Type</label>
            <div className="cbc-seg">
              <button className={recipientType === 'member' ? 'cbc-seg-btn cbc-seg-btn--active' : 'cbc-seg-btn'} onClick={() => { setRecipientType('member'); setDestination('player_wallet'); }}>
                Member
              </button>
              {unionId && (
                <button className={recipientType === 'club' ? 'cbc-seg-btn cbc-seg-btn--active' : 'cbc-seg-btn'} onClick={() => { setRecipientType('club'); setDestination('club_bank'); }}>
                  Club
                </button>
              )}
            </div>
          </div>

          {recipientType === 'member' && (
            <div className="cbc-field">
              <label className="cbc-label">Destination Wallet</label>
              <div className="cbc-seg">
                <button className={destination === 'player_wallet' ? 'cbc-seg-btn cbc-seg-btn--active' : 'cbc-seg-btn'} onClick={() => setDestination('player_wallet')}>
                  Player Wallet
                </button>
                <button className={destination === 'agent_wallet' ? 'cbc-seg-btn cbc-seg-btn--active' : 'cbc-seg-btn'} onClick={() => setDestination('agent_wallet')}>
                  Agent Wallet
                </button>
                <button className={destination === 'promo_wallet' ? 'cbc-seg-btn cbc-seg-btn--active' : 'cbc-seg-btn'} onClick={() => setDestination('promo_wallet')}>
                  Promo Wallet
                </button>
              </div>
            </div>
          )}

          <div className="cbc-field">
            <label className="cbc-label">Search</label>
            <input type="text" placeholder={\`Search \${recipientType === 'member' ? 'members' : 'clubs'}...\`} value={search} onChange={(e) => setSearch(e.target.value)} className="cbc-input" />
            <div className="cbc-list" style={{ maxHeight: '150px' }}>
              {recipientType === 'member'
                ? filteredMembers.map((m) => (
                    <div key={m.user_id} className="cbc-member" style={{ background: recipientMember?.user_id === m.user_id ? 'var(--blue-dim)' : '' }} onClick={() => setRecipientMember(m)}>
                      <div className="cbc-member-info">
                        <span className="cbc-member-name">{m.name}</span>
                        <span className="cbc-member-role">{m.role}</span>
                      </div>
                    </div>
                  ))
                : filteredClubs.map((c) => (
                    <div key={c.id} className="cbc-member" style={{ background: recipientClub?.id === c.id ? 'var(--blue-dim)' : '' }} onClick={() => setRecipientClub(c)}>
                      <div className="cbc-member-info">
                        <span className="cbc-member-name">{c.name}</span>
                      </div>
                    </div>
                  ))}
            </div>
          </div>

          <div className="cbc-field">
            <label className="cbc-label">Amount</label>
            <input type="number" min="0.01" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className="cbc-input" />
          </div>

          <div className="cbc-field">
            <label className="cbc-label">Reason (Optional)</label>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Promo Distribution" className="cbc-input" />
          </div>

          {error && <div className="cbc-empty cbc-empty--bad">{error}</div>}

          <div className="cbc-actions">
            <button className="cbc-confirm" onClick={onSend} disabled={sending || !amount || (recipientType === 'member' ? !recipientMember : !recipientClub)}>
              {sending ? 'Sending...' : 'Send Promo Chips'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
`;

const startIndex = code.indexOf('  return (');
if (startIndex !== -1) {
  code = code.substring(0, startIndex) + newRender;
  fs.writeFileSync(file, code);
  console.log('Fixed render in PromoWalletCashierModal.tsx');
} else {
  console.error('Could not find render block');
}
