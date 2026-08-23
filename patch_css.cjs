const fs = require('fs');
let css = fs.readFileSync('src/components/wallet/ClubBankCashierModal.css', 'utf8');

// Update cbc-panel to have more depth
css = css.replace(
  /\.cbc-panel \{[\s\S]*?\}/,
  `.cbc-panel {
  width: 100%;
  max-width: 480px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(165deg, rgba(42, 42, 54, 0.95) 0%, rgba(24, 24, 32, 0.95) 100%);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  box-shadow: 
    0 24px 48px -12px rgba(0, 0, 0, 0.7),
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    inset 0 -1px 0 rgba(0, 0, 0, 0.5),
    inset 0 0 20px rgba(0, 0, 0, 0.2);
  overflow: hidden;
  backdrop-filter: blur(12px);
  transform: translateZ(0);
}`
);

// Update cbc-bank to pop
css = css.replace(
  /\.cbc-bank \{[\s\S]*?\}/,
  `.cbc-bank {
  margin: 16px 20px 0;
  padding: 18px 20px;
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(20, 20, 30, 0.6) 0%, rgba(10, 10, 15, 0.8) 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    inset 0 2px 4px rgba(0, 0, 0, 0.4),
    0 1px 0 rgba(255, 255, 255, 0.05);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}`
);

// Add avatar and info styles for member
css += `
.cbc-member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background-size: cover;
  background-position: center;
  background-color: #2a2a36;
  border: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}

.cbc-member-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.cbc-member-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}

.cbc-member-id {
  font-size: 0.6rem;
  color: #6b7686;
  font-family: monospace;
}
`;

fs.writeFileSync('src/components/wallet/ClubBankCashierModal.css', css);
