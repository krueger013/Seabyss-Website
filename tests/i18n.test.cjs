'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test'),{JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..'),runtime=fs.readFileSync(path.join(root,'js/i18n.js'),'utf8');
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
const testPack={source:'fr',strings:{'Bonjour':{en:'Hello',es:'Hola'},'Jouer':{en:'Play',es:'Jugar'},'Nouvelle partie':{en:'New game',es:'Nueva partida'},'Lune':{en:'Moon',es:'Luna'},'un objet':{en:'an object',es:'un objeto'}},templates:[{source:'Le joueur {0} a trouvé {1}',en:'Player {0} found {1}',es:'El jugador {0} encontró {1}',opaque:[0]},{source:'Objets : {0} / {1}',en:'Objects: {0} / {1}',es:'Objetos: {0} / {1}'}]};
function make(html,url='https://site.test/index.html',opts={}){
 const dom=new JSDOM(html,{url,runScripts:'outside-only'}),w=dom.window;
 if(opts.blockStorage)Object.defineProperty(w,'localStorage',{configurable:true,get(){throw new Error('Storage unavailable')}});
 else if(opts.saved)w.localStorage.setItem('seabyss.language.v1',opts.saved);
 if(opts.canvas){class CanvasMock{constructor(){this.calls=[]}fillText(...args){this.calls.push(['fill',...args]);return 7}strokeText(...args){this.calls.push(['stroke',...args]);return 8}measureText(text){this.calls.push(['measure',text]);return {width:text.length}}};w.CanvasRenderingContext2D=CanvasMock;}
 w.eval(runtime);return dom;
}
async function ready(w){if(w.document.readyState==='loading')await new Promise(resolve=>w.document.addEventListener('DOMContentLoaded',resolve,{once:true}));await pause();}
test('shared language runtime and portal preserve presentation state across French, English and Spanish', async () => {
 let assertions=0;
 const dom=make('<title>Bonjour</title><meta name="description" content="Bonjour"><body><h1> Bonjour </h1><button aria-label="Jouer" title="Nouvelle partie">Jouer</button><input value="Bonjour" placeholder="Bonjour"><textarea>Bonjour</textarea><div contenteditable>Bonjour</div><span data-no-translate title="Bonjour">Bonjour</span><p id="name">Le joueur Jouer a trouvé un objet</p><div data-language-picker></div><iframe></iframe><a id="local" href="games/test/index.html#play">Jouer</a><a id="foreign" href="https://other.test/index.html">Jouer</a>',undefined,{saved:'es',canvas:true});
 const w=dom.window,doc=w.document;w.SeabyssI18n.register(testPack);await ready(w);
 assert.equal(w.SeabyssI18n.language,'es');assert.equal(doc.documentElement.lang,'es');assert.equal(doc.querySelector('h1').textContent,' Hola ');assert.equal(doc.title,'Hola');assert.equal(doc.querySelector('meta').content,'Hola');assertions+=5;
 assert.equal(doc.querySelector('button').getAttribute('title'),'Nueva partida');assert.equal(doc.querySelector('input').placeholder,'Hola');assert.equal(doc.querySelector('input').value,'Bonjour');assert.equal(doc.querySelector('textarea').value,'Bonjour');assert.equal(doc.querySelector('[contenteditable]').textContent,'Bonjour');assert.equal(doc.querySelector('[data-no-translate]').textContent,'Bonjour');assert.equal(doc.querySelector('[data-no-translate]').title,'Bonjour');assert.equal(doc.querySelector('#name').textContent,'El jugador Jouer encontró un objeto');assertions+=8;
 assert.equal(doc.querySelectorAll('.seabyss-language').length,1);assert.equal(doc.querySelector('.seabyss-language select').value,'es');let keys=0;doc.addEventListener('keydown',()=>keys++);doc.querySelector('.seabyss-language select').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));assert.equal(keys,0);assertions+=3;
 let observed=0;const countObserver=new w.MutationObserver(records=>observed+=records.length);countObserver.observe(doc.body,{subtree:true,childList:true,characterData:true,attributes:true});
 for(const lang of ['en','fr','es','en','fr','en']){w.SeabyssI18n.setLanguage(lang);await pause();assert.equal(doc.querySelector('h1').textContent,{fr:' Bonjour ',en:' Hello ',es:' Hola '}[lang]);assert.equal(doc.querySelector('input').value,'Bonjour');assertions+=2;}
 const settled=observed;await pause();await pause();assert.equal(observed,settled);assert(observed<300);assertions+=2;
 doc.querySelector('h1').firstChild.nodeValue='Nouvelle partie';doc.querySelector('button').setAttribute('aria-label','Nouvelle partie');const dynamic=doc.createElement('p');dynamic.textContent='Objets : 2 / 8';doc.body.append(dynamic);const mount=doc.createElement('div');mount.setAttribute('data-language-picker','');doc.body.append(mount);await pause();
 assert.equal(doc.querySelector('h1').textContent,'New game');assert.equal(doc.querySelector('button').getAttribute('aria-label'),'New game');assert.equal(dynamic.textContent,'Objects: 2 / 8');assert.equal(doc.querySelectorAll('.seabyss-language').length,2);assertions+=4;
 w.SeabyssI18n.setLanguage('es');await pause();assert.equal(dynamic.textContent,'Objetos: 2 / 8');assert.equal(doc.querySelector('h1').textContent,'Nueva partida');w.SeabyssI18n.setLanguage('fr');await pause();assert.equal(doc.querySelector('h1').textContent,'Nouvelle partie');assert.equal(dynamic.textContent,'Objets : 2 / 8');assertions+=4;
 w.SeabyssI18n.setLanguage('en');assert.equal(w.localStorage.getItem('seabyss.language.v1'),'en');assert.equal(new URL(w.location.href).searchParams.get('lang'),'en');assert(w.SeabyssI18n.url('games/test/index.html#play').endsWith('/games/test/index.html?lang=en#play'));assert.equal(w.SeabyssI18n.url('https://other.test/test'),'https://other.test/test');assertions+=4;
 w.dispatchEvent(new w.StorageEvent('storage',{key:'seabyss.language.v1',newValue:'es'}));assert.equal(w.SeabyssI18n.language,'es');w.dispatchEvent(new w.StorageEvent('storage',{key:'seabyss.language.v1',newValue:'de'}));assert.equal(w.SeabyssI18n.language,'es');assertions+=2;
 const sent=[];const frame=doc.querySelector('iframe');frame.contentWindow.postMessage=(value,origin)=>sent.push({value,origin});w.SeabyssI18n.setLanguage('en');assert(sent.some(e=>e.origin==='https://site.test'&&e.value.type==='seabyss-language'&&e.value.language==='en'));assertions++;
 doc.addEventListener('click',event=>event.preventDefault());doc.querySelector('#local').click();assert.equal(new URL(doc.querySelector('#local').href).searchParams.get('lang'),'en');assert.equal(new URL(doc.querySelector('#local').href).hash,'#play');doc.querySelector('#foreign').click();assert.equal(doc.querySelector('#foreign').href,'https://other.test/index.html');assertions+=3;
 const download=doc.createElement('a');download.href='save.html';download.download='save.html';doc.body.append(download);download.click();assert.equal(new URL(download.href).searchParams.has('lang'),false);assertions++;
 const beforeLoad=sent.length;frame.dispatchEvent(new w.Event('load'));assert(sent.length>beforeLoad);assertions++;
 const parent={};Object.defineProperty(w,'parent',{configurable:true,value:parent});
 w.dispatchEvent(new w.MessageEvent('message',{origin:'https://evil.test',source:parent,data:{type:'seabyss-language',language:'es'}}));assert.equal(w.SeabyssI18n.language,'en');
 w.dispatchEvent(new w.MessageEvent('message',{origin:w.location.origin,source:{},data:{type:'seabyss-language',language:'es'}}));assert.equal(w.SeabyssI18n.language,'en');
 w.dispatchEvent(new w.MessageEvent('message',{origin:w.location.origin,source:parent,data:{type:'seabyss-language',language:'es'}}));assert.equal(w.SeabyssI18n.language,'es');assertions+=3;
 w.SeabyssI18n.setLanguage('en');const canvas=new w.CanvasRenderingContext2D();assert.equal(canvas.fillText('Jouer',10,20),7);assert.deepEqual(canvas.calls[0],['fill','Play',10,20]);assert.equal(canvas.measureText('Nouvelle partie').width,8);assert.deepEqual(canvas.calls[1],['measure','New game']);canvas.strokeText('Lune',1,2);assert.deepEqual(canvas.calls[2],['stroke','Moon',1,2]);assertions+=5;
 countObserver.disconnect();dom.window.close();
 for(const [url,opts,expected] of [['https://site.test/game.html?lang=en',{saved:'es'},'en'],['https://site.test/game.html?lang=es',{blockStorage:true},'es'],['https://site.test/game.html?lang=de',{saved:'en'},'en'],['https://site.test/game.html',{blockStorage:true},'fr']]){
 const test=make('<body><p>Bonjour</p><div data-language-picker></div>',url,opts);test.window.SeabyssI18n.register(testPack);await ready(test.window);assert.equal(test.window.SeabyssI18n.language,expected);test.window.SeabyssI18n.setLanguage('en');assert.equal(test.window.document.querySelector('p').textContent,'Hello');assertions+=2;test.window.close();}
 // Portal integration with the real dictionary and a mocked same-origin catalogue fetch.
 const portal=make(fs.readFileSync(path.join(root,'index.html'),'utf8'),'https://site.test/?lang=en');const pw=portal.window;const games=JSON.parse(fs.readFileSync(path.join(root,'data/games.json')));pw.fetch=async()=>({ok:true,json:async()=>games});pw.HTMLDialogElement.prototype.showModal=function(){this.open=true};pw.HTMLDialogElement.prototype.close=function(){this.open=false};
 pw.eval(fs.readFileSync(path.join(root,'js/portal-translations.js'),'utf8'));pw.eval(fs.readFileSync(path.join(root,'js/catalog.js'),'utf8'));await ready(pw);await pause();
 assert.equal(pw.document.querySelectorAll('.game-card').length,games.length);assert.equal(pw.document.getElementById('results-count').textContent,games.length+' games');assert.equal(pw.document.querySelector('[data-game=jungle-felins] .game-title').textContent,'Jungle Felines');assertions+=3;
 pw.SeabyssI18n.setLanguage('es');await pause();assert.equal(pw.document.getElementById('results-count').textContent,games.length+' juegos');assert.equal(pw.document.querySelector('[data-game=jungle-felins] .game-title').textContent,'Felinos de la jungla');assertions+=2;
 pw.SeabyssI18n.setLanguage('fr');await pause();assert.equal(pw.document.getElementById('results-count').textContent,games.length+' jeux');assert.equal(pw.document.querySelector('[data-game=jungle-felins] .game-title').textContent,'Jungle Félins');assertions+=2;
 const rawDom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'));
 const rawNodes=new Set(),walker=rawDom.window.document.createTreeWalker(rawDom.window.document,rawDom.window.NodeFilter.SHOW_TEXT);let rawNode;
 while(rawNode=walker.nextNode()){if(rawNode.parentElement?.closest('script,style,noscript,[aria-hidden=true]'))continue;const value=rawNode.nodeValue.trim().replace(/\s+/g,' ');if(/\p{L}/u.test(value))rawNodes.add(value);}
 for(const el of rawDom.window.document.querySelectorAll('[title],[aria-label],[alt],[placeholder],meta[name=description],meta[property="og:title"],meta[property="og:description"]'))for(const name of ['title','aria-label','alt','placeholder','content'])if(el.hasAttribute(name))rawNodes.add(el.getAttribute(name).trim().replace(/\s+/g,' '));
 const unchanged= [...rawNodes].filter(text=>{pw.SeabyssI18n.setLanguage('en',false);const en=pw.SeabyssI18n.t(text);pw.SeabyssI18n.setLanguage('es',false);return en===text&&pw.SeabyssI18n.t(text)===text;}).filter(text=>text&&!['SEABYSS','Castle War','Mario’s','Ghost','© 2026 Seabyss','CASINO','COLLECTION / 07'].includes(text));
 assert.deepEqual(unchanged,[],'All visible portal copy needs French, English and Spanish translations');rawDom.window.close();
 const untranslated=[],frPack={};const dictionaryDom=new JSDOM('<body>',{runScripts:'outside-only'});dictionaryDom.window.SeabyssI18n={register:pack=>{frPack.strings={...frPack.strings,...pack.strings};frPack.templates=[...(frPack.templates||[]),...(pack.templates||[])];}};dictionaryDom.window.eval(fs.readFileSync(path.join(root,'js/portal-translations.js'),'utf8'));
 for(const game of games)for(const key of ['title','description','controls','coverLabel'])if(game[key]&&!frPack.strings[game[key]])untranslated.push(game.id+': '+key+' = '+game[key]);
 // Proper titles may intentionally stay the same, but descriptions/controls must be mapped.
 const important=untranslated.filter(s=>!s.includes(': title = ')&&!s.endsWith('coverLabel = Station 77'));
 assert.deepEqual(important,[]);assertions++;
 dictionaryDom.window.close();portal.window.close();
 assert(assertions >= 74);
 
});
