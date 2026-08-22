function u(n,l){const t=URL.createObjectURL(n),e=document.createElement("a");e.href=t,e.download=l,document.body.appendChild(e),e.click(),document.body.removeChild(e),URL.revokeObjectURL(t)}function p(n,l,t){if(n.length===0)return;const e=t||Object.keys(n[0]).map(o=>({key:o,label:o})),s=e.map(o=>o.label).join(","),r=n.map(o=>e.map(i=>{const b=o[i.key],c=String(b??"");return c.includes(",")||c.includes('"')?`"${c.replace(/"/g,'""')}"`:c}).join(",")),a=[s,...r].join(`
`),d=new Blob([a],{type:"text/csv;charset=utf-8;"});u(d,l)}export{p as e};
//# sourceMappingURL=export-BUCK7xun-v6.js.map
