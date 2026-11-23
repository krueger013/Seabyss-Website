const assert=require('node:assert/strict'),meta=require('./release.json');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const retired=[...new Set(['games/castle-war/','games/castle-war/index.html','games/dames/index.html','games/seabyss-casino/index.html',...meta.retired])];
 const unclear=[];
 for(const path of retired){
   const address=new URL(path,'https://www.seabyss.com/');
   let get;let head;
   for(let i=0;i<3;i++){
     const url=new URL(address);if(i)url.searchParams.set('probe',Date.now());
     const h=await fetch(url,{method:'HEAD'});head=h.status;await h.arrayBuffer();
     await wait(650);const g=await fetch(url);get=g.status;const body=await g.text();
     console.log(path,'HEAD',head,'GET',get,body.match(/<title[^>]*>([^<]*)/i)?.[1]?.slice(0,90)||body.slice(0,50));
     if(get===404)break;
     await wait(2500);
   }
   if(get!==404)unclear.push([path,head,get]);
   await wait(1200);
 }
 console.log('Incertain',JSON.stringify(unclear));assert.deepEqual(unclear,[]);
})().catch(e=>{console.error(e.message);process.exitCode=1});
