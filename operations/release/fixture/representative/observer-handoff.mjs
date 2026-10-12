import assert from 'node:assert/strict';
export async function handoffObservers(handles,{readFailure=()=>undefined,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),budgetMs=20000}={}){
 const values=[...handles.values()];for(const h of values)h.quiesce();const deadline=now()+budgetMs;
 while(values.some(h=>h.pendingActions()>0)&&now()<deadline&&!readFailure())await wait(20);
 if(readFailure())throw readFailure();assert.ok(values.every(h=>h.pendingActions()===0),'Original setup action still pending at handoff');
 await Promise.all(values.map(h=>h.close()));handles.clear();
}
