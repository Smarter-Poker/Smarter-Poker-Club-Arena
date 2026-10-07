export async function admitIndependentGroups(groups, admit) {
 let firstFailure;
 const outcomes=await Promise.all(groups.map(group=>Promise.resolve().then(()=>admit(group)).then(value=>({ok:true,value}),error=>{firstFailure??=error;return {ok:false,error};})));
 if(firstFailure)throw firstFailure;return outcomes.map(o=>o.value);
}
export async function admitIndependentBatches(groups,width,admit){
 if(!Number.isSafeInteger(width)||width<1||width>8)throw new Error('Independent admission width exceeds finite ceiling');
 const results=[];for(let offset=0;offset<groups.length;offset+=width)results.push(...await admitIndependentGroups(groups.slice(offset,offset+width),admit));return results;
}

// Keep the original observer promise owned immediately and inside the admission
// batch. Its real first frame, not only its purchase, spends the width slot.
export async function admitTrackedSeed(group,tasks,admit){
 const task=Promise.resolve().then(()=>admit(group)).then(value=>({ok:true,value}),error=>({ok:false,error}));
 tasks.push(task);
 const outcome=await task;
 if(!outcome.ok)throw outcome.error;
 return outcome.value;
}
