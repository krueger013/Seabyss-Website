const {chromium} = require('playwright-core');
const assert=require('node:assert/strict'), crypto=require('node:crypto');
const meta=require('./release.json'), origin='https://www.seabyss.com/';
const stamp='?check='+meta.release.slice(0,12)+'-'+Date.now();
const sha=(b)=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
async function request(url){
 const transient=new Set([429,500,502,503,504]);
 for(let attempt=0;attempt<6;attempt++){
   const key=new URL(url);
   if(attempt)key.searchParams.set('retry',String(attempt)+'-'+Date.now());
   const res=await fetch(key);
   if(!transient.has(res.status)||attempt===5)return res;
   await res.arrayBuffer();
   await new Promise(done=>setTimeout(done,1500*Math.pow(2,attempt)));
 }
}
async function run(){
 let current;
 for(let i=0;i<18;i++){
   const r=await request(origin+stamp+'&try='+i); const b=Buffer.from(await r.arrayBuffer());current=sha(b);
   if(r.ok&&current===meta.files['index.html'])break;
   await new Promise(done=>setTimeout(done,10000));
 }
 assert.equal(current,meta.files['index.html'],'HTML de production avant ouverture');
 const entries=Object.entries(meta.files);
 for (let i=0;i<entries.length;i+=6) await Promise.all(entries.slice(i,i+6).map(async ([file,expected])=>{
   const res=await request(new URL(file+stamp,origin));assert.equal(res.status,200,file);
   const bytes=Buffer.from(await res.arrayBuffer());assert.equal(sha(bytes),expected,file);
 }));
 for(const path of [...meta.retired,"games/castle-war/"]){
   const res=await request(new URL(path+stamp,origin));await res.arrayBuffer();assert.equal(res.status,404,path);
 }
 console.log(entries.length+' fichiers identiques au lancement, '+meta.retired.length+' anciennes routes en 404.');
 const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH,args:['--no-sandbox']}:{args:['--no-sandbox']});
 try{
   for(const [width,height] of [[320,568],[390,844],[568,320],[844,390],[768,1024],[1024,768],[1366,768]]){
     const touch=width!==1366,ctx=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch,reducedMotion:'reduce'});
     const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));const act=async l=>touch?l.tap():l.click();
     await page.goto(origin+stamp,{waitUntil:'domcontentloaded'});await act(page.locator('#atlas-open'));await act(page.locator('[data-atlas-view="discover"]'));await act(page.locator('[data-experience="phase"]'));
     const lab=page.locator('#phase-workspace');await lab.locator('[data-phase-sky]').waitFor();const text=await lab.locator('[data-phase-viewpoint]').innerText();await act(lab.locator('[data-phase-swap]'));assert.notEqual(await lab.locator('[data-phase-viewpoint]').innerText(),text);
     const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
     await act(lab.locator('[data-phase-exit]'));await lab.waitFor({state:'hidden'});assert.deepEqual(errors,[]);
     console.log('PASS '+width+'x'+height+' '+(touch?'touch':'mouse'));await ctx.close();
   }
 }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1});