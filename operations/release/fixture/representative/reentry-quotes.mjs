import assert from 'node:assert/strict';
import {admitIndependentBatches} from './independent-admissions.mjs';
// Read-only admission runs before any original input lifetime starts.
// A quote never substitutes for the native atomic purchase validation.
export async function prepareReentryQuotes(groups,readQuote){
 const entries=groups.filter(g=>g.kind==='cash').flatMap(group=>group.users.filter(user=>!user.buyinEntered).map(user=>({group,user})));
 await admitIndependentBatches(entries,8,async({group,user})=>{
  assert.ok(user.originalBuyinOp&&user.buyinOp!==user.originalBuyinOp);
  const quote=await readQuote(group,user);assert.equal(quote.ok,true);assert.ok(Number.isFinite(quote.min)&&Number.isFinite(quote.max)&&quote.max>=quote.min);
  user.buyinAmount=Math.min(quote.max,Math.max(200,quote.min));
  user.buyinQuote={tableId:group.tableId,buyinOp:user.buyinOp,min:quote.min,max:quote.max,observedAt:new Date().toISOString()};
 });
}
