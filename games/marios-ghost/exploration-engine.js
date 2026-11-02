(function(root){
'use strict';
const fresh=()=>({revealed:false,visited:false,claimed:false,torches:[],lever:false});
function normalize(raw,level,indexes){
 if(raw.version===1)return {zone:'main',secret:fresh(),broken:[]};
 const s=raw.secret;if(!s||!['main','secret'].includes(raw.zone)||!['revealed','visited','claimed','lever'].every(k=>typeof s[k]==='boolean')||!indexes(s.torches,level.secret.torches.length)||!indexes(raw.broken,level.urns.length))return null;
 if((s.visited&&!s.revealed)||(s.claimed&&!s.visited)||(raw.zone==='secret'&&!s.visited))return null;
 if(!s.visited&&(s.torches.length||s.lever||raw.taken.some(i=>level.coins[i].zone==='secret')||raw.defeated.some(i=>level.enemies[i].zone==='secret')))return null;
 if(raw.taken.some(i=>level.coins[i].urn!==undefined&&!raw.broken.includes(level.coins[i].urn)))return null;
 if(s.claimed){if(['torches','ordered'].includes(level.secret.kind)&&s.torches.length!==level.secret.torches.length)return null;if(level.secret.kind==='lever'&&!s.lever)return null;if(level.secret.kind==='guardian'&&level.enemies.some((e,i)=>e.zone==='secret'&&!raw.defeated.includes(i)))return null;}
 return {zone:raw.zone,secret:{revealed:s.revealed,visited:s.visited,claimed:s.claimed,lever:s.lever,torches:[...s.torches]},broken:[...raw.broken]};
}
function attach(World){Object.assign(World.prototype,{
 initExploration(){this.zone='main';this.secret=fresh();this.interactCooldown=0;this.player.walkDistance=0;},
 restoreExploration(snap){this.zone=snap.zone;this.secret={...snap.secret,torches:[...snap.secret.torches]};snap.broken.forEach(i=>this.level.urns[i].broken=true);this.lights+=this.secret.claimed?25:0;},
 explorationSave(){return {zone:this.zone,secret:{...this.secret,torches:[...this.secret.torches]},broken:this.level.urns.flatMap((u,i)=>u.broken?[i]:[])};},
 bounds(){return this.level.zoneBounds[this.zone];},
 platformActive(p){return p.zone===this.zone&&(!p.leverBridge||this.secret.lever)&&!(p.collapse>0);},
 activePlatforms(){return this.level.platforms.filter(p=>this.platformActive(p));},
 coinVisible(c){return c.zone===this.zone&&(c.urn===undefined||this.level.urns[c.urn].broken);},
 spawnPoint(){return this.zone==='secret'?this.level.secret.spawn:this.checkpoint;},
 chestReady(){const r=this.level.secret;return ['torches','ordered'].includes(r.kind)?this.secret.torches.length===r.torches.length:r.kind==='lever'?this.secret.lever:r.kind==='guardian'?!this.level.enemies.some(e=>e.zone==='secret'&&!e.dead):true;},
 interaction(){
  const p=this.player,r=this.level.secret,near=(x,feet,d=65)=>Math.abs(p.x+p.w/2-x)<d&&Math.abs(p.y+p.h-feet)<72;
  if(this.zone==='main'){
   if(near(r.entry.x,r.entry.feet,100))return this.secret.revealed?{kind:'enter',key:'E',label:'Explorer le passage secret'}:{kind:'reveal',key:'X',label:'Une fissure laisse passer la lumière…'};
   if(near(this.level.sign.x,this.level.sign.feet,55))return {kind:'sign',key:'E',label:'Lire l’indice du voyageur'};
  }else{
   if(near(r.chest.x,r.chest.feet,72))return {kind:'chest',key:'E',label:this.secret.claimed?'Relique retrouvée · retourne au portail':this.chestReady()?'Ouvrir le coffre oublié':'Le coffre est encore scellé'};
   if(r.lever&&near(r.lever.x,r.lever.feet,60))return {kind:'lever',key:'E',label:this.secret.lever?'Le pont est éveillé':'Réveiller le pont'};
   if(near(r.exit.x,r.exit.feet,65))return {kind:'exit',key:'E',label:this.secret.claimed?'Prendre le raccourci':'Revenir au royaume'};
   if(near(r.origin+185,620,45))return {kind:'clue',key:'E',label:'Lire la stèle'};
  }return null;
 },
 useInteraction(){
  if(this.interactCooldown>0)return false;const it=this.interaction();if(!it)return false;this.interactCooldown=.35;const r=this.level.secret;
  if(it.kind==='enter'){this.secret.visited=true;this.zone='secret';this.teleport(r.spawn.x,r.spawn.y);this.emit('secret-enter',{text:r.name});return true;}
  if(it.kind==='exit'){this.zone='main';const d=this.secret.claimed?r.shortcut:{x:r.entry.x-55,feet:r.entry.feet};this.teleport(d.x,d.feet-this.player.h);this.emit('secret-exit',{text:this.secret.claimed?'Le passage te dépose plus loin dans le royaume.':'Tu retrouves le chemin principal.'});return true;}
  if(it.kind==='lever'){if(!this.secret.lever){this.secret.lever=true;this.burst(r.lever.x,r.lever.feet-30,'#a8e9df',30);this.emit('mechanism',{text:'Le pont ancien s’éveille.'});}return false;}
  if(it.kind==='chest'){
   if(this.secret.claimed){this.emit('clue',{text:'La relique est à toi. Le portail ouvre maintenant un raccourci.'});return false;}
   if(!this.chestReady()){this.emit('clue',{text:r.clue});return false;}
   this.secret.claimed=true;this.lights+=25;this.player.health=3;this.burst(r.chest.x,r.chest.feet-40,'#f5dc9d',45);this.popup(r.chest.x,r.chest.feet-60,'RELIQUE · +25');this.emit('relic',{text:r.relic});return false;
  }
  this.emit('clue',{text:it.kind==='sign'?r.hint:it.kind==='reveal'?'Éclaire la fissure avec ta lanterne (X).':r.clue});return false;
 },
 teleport(x,y){const p=this.player;Object.assign(p,{x,y,vx:0,vy:0,grounded:false,groundId:null,jumps:0,coyote:0,jumpBuffer:0,attackTime:0,swordTime:0,swordChain:0,swordCombo:0,invulnerable:1.5,knockback:0});this.projectiles=[];this.particles=[];this.popups=[];this.burst(x+17,y+30,'#bde9df',24);},
 attackScenery(){
  const p=this.player;if(p.attackTime<=0)return;const r=this.level.secret,near=(x,y)=>Math.abs(x-p.x-17)<115&&Math.abs(y-p.y-28)<95&&(x-p.x-17)*p.dir>-20;
  if(this.zone==='main'&&!this.secret.revealed&&near(r.entry.x,r.entry.feet-45)){this.secret.revealed=true;this.burst(r.entry.x,r.entry.feet-45,'#cbd6b2',35);this.emit('secret-revealed',{text:'Un passage secret ! Approche-toi et appuie sur E.'});}
  for(const u of this.level.urns)if(u.zone===this.zone&&!u.broken&&near(u.x+15,u.y+18)){u.broken=true;this.burst(u.x+15,u.y+18,'#9bb6c1',18);this.emit('urn');}
  if(this.zone==='secret')for(const t of r.torches){if(t.lastAttack===this.attackId||!near(t.x,t.y)||this.secret.torches.includes(t.index))continue;t.lastAttack=this.attackId;
   if(r.kind==='ordered'&&t.index!==this.secret.torches.length){this.secret.torches=[];this.emit('mechanism',{text:'Les runes se sont éteintes. Commence par I, puis II, puis III.'});this.burst(t.x,t.y,'#a4b6d5',14);}
   else{this.secret.torches.push(t.index);this.burst(t.x,t.y,'#ecd39b',22);this.emit('mechanism',{text:this.chestReady()?'Le coffre est descellé.':'Une nouvelle flamme s’éveille.'});}
  }
 },
 updateExploration(dt,input){
  this.interactCooldown=Math.max(0,this.interactCooldown-dt);this.attackScenery();const p=this.player;
  for(const s of this.level.platforms){if(s.zone!==this.zone||!s.crumble)continue;if(s.collapse>0){s.collapse=Math.max(0,s.collapse-dt);s.stress=0;}else if(p.grounded&&p.groundId===s.id){s.stress=(s.stress||0)+dt;if(s.stress>.65){s.collapse=2.5;this.burst(s.x+s.w/2,s.y,'#a2a2b7',16);p.grounded=false;p.groundId=null;this.emit('crumble');}}else s.stress=Math.max(0,(s.stress||0)-dt*.3);}
  for(const pad of this.level.pads){if(pad.zone===this.zone&&p.grounded&&Math.abs(p.x+17-pad.x)<37&&Math.abs(p.y+p.h-pad.y)<8){p.vy=-850;p.grounded=false;p.groundId=null;p.jumps=1;pad.pulse=.45;this.burst(pad.x,pad.y-8,'#b7ece7',20);this.emit('spring');}pad.pulse=Math.max(0,(pad.pulse||0)-dt);}
  if(input.interactPressed)return this.useInteraction();return false;
 }
});}
root.GhostExplorationRules={attach,normalize};if(typeof module!=='undefined')module.exports={attach,normalize};
})(typeof globalThis!=='undefined'?globalThis:this);

