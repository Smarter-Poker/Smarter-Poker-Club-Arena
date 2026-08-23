const fs = require('fs');
let css = fs.readFileSync('src/components/wallet/ClubBankCashierModal.css', 'utf8');

css = css.replace(
  /\.cbc-member \{[\s\S]*?\}/,
  `.cbc-member {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(60, 60, 80, 0.4) 0%, rgba(40, 40, 60, 0.4) 100%);
  color: #e8eaf0;
  font-size: 0.78rem;
  cursor: pointer;
  text-align: left;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  transition: all 0.2s ease;
}`
);

fs.writeFileSync('src/components/wallet/ClubBankCashierModal.css', css);
