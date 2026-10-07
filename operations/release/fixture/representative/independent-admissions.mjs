export async function admitIndependentGroups(groups, admit) {
 let firstFailure;
 const outcomes=await Promise.all(groups.map(group=>Promise.resolve().then(()=>admit(group)).then(value=>({ok:true,value}),error=>{firstFailure??=error;return {ok:false,error};})));
 if(firstFailure)throw firstFailure;return outcomes.map(o=>o.value);
}
export async function admitIndependentBatches(groups,width,admit){
 if(!Number.isSafeInteger(width)||width<1||width>8)throw new Error('Independent admission width exceeds finite ceiling');
 const results=[];for(let offset=0;offset<groups.length;offset+=width)results.push(...await admitIndependentGroups(groups.slice(offset,offset+width),admit));return results;
}
