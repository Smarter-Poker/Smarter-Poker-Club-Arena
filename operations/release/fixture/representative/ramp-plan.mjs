import assert from 'node:assert/strict';
export function mixedPlan(size){
 const mixes={100:{six:6,nine:4,sng:[6],mtt:[22]},300:{six:30,nine:10,sng:[6],mtt:[24]},600:{six:60,nine:20,sng:[6,6],mtt:[24,24]},1000:{six:96,nine:34,sng:[6,6,6,6],mtt:[22,24,24,24]}};
 const mix=mixes[size];assert.ok(mix,'unsupported finite stage');
 const groups=[...Array.from({length:mix.six},()=>({kind:'cash',count:6})),...Array.from({length:mix.nine},()=>({kind:'cash',count:9})),...mix.sng.map(count=>({kind:'sng',count})),...mix.mtt.map(count=>({kind:'mtt',count}))].map((g,index)=>({...g,index}));
 assert.equal(groups.reduce((n,g)=>n+g.count,0),size);
 return {size,groups,engineeringAssumption:true,product_certificate:false,durationMs:180000,actorCeilingMs:240000,sustained15MinuteSLOQualified:false};
}

export function assertCashSetupComplete(groups, admittedGroupIds){
 const expected=groups.filter(g=>g.kind==='cash').map(g=>g.index);
 assert.equal(new Set(expected).size,expected.length,'Planned cash groups must be unique');
 const actual=[...admittedGroupIds];
 assert.equal(actual.length,expected.length,'Every planned cash setup must complete');
 assert.equal(new Set(actual).size,actual.length,'Cash setup identities must be unique');
 assert.ok(actual.every(id=>expected.includes(id)),'Foreign setup cannot stand in for a planned cash group');
 return expected.length;
}
