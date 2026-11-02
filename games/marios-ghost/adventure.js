(function(root){
 'use strict';
 const trials=[
  {name:'Les feux du veilleur',seconds:32,beacons:[[470,510],[720,420],[1230,350]]},
  {name:'La course des lucioles',seconds:34,beacons:[[450,510],[720,440],[1190,310]]},
  {name:'Les lueurs sous la pluie',seconds:38,beacons:[[430,510],[1110,500],[1420,405]]},
  {name:'Le chant des trois cloches',seconds:36,beacons:[[440,510],[710,400],[1210,305]]},
  {name:'La veille de l’éclipse',seconds:36,beacons:[[450,510],[740,400],[1280,290]]}
 ];
 function attach(World){
  const originalInteraction=World.prototype.interaction,originalUse=World.prototype.useInteraction,originalRespawn=World.prototype.respawn,originalTeleport=World.prototype.teleport;
  Object.assign(World.prototype,{
   initAdventure(){this.level.trialSpec={...trials[this.level.id],altar:{x:350,feet:620},beacons:trials[this.level.id].beacons.map(([x,feet],i)=>({x,feet,index:i}))};this.trial={active:false,complete:false,lit:0,remaining:0,notice:0};this.echoes=[];this.impacts=[];this.echoAt=0;Object.assign(this.player,{dashTime:0,dashCooldown:0,dashDir:1,dashAirUsed:false});},
   restoreAdventure(snap){this.trial.complete=snap.trial===true;if(this.trial.complete){this.trial.lit=3;this.lights+=20;}},
   cancelTrial(reason='trial-cancelled'){if(!this.trial?.active)return;Object.assign(this.trial,{active:false,lit:0,remaining:0,notice:2.8});this.emit(reason);},
   resetDash(){Object.assign(this.player,{dashTime:0,dashAirUsed:false,swordBuffer:0});this.echoes=[];},
   startDash(input={}){const p=this.player;if(this.state!=='playing'||p.dashCooldown>0||p.knockback>0||(!p.grounded&&p.dashAirUsed))return false;p.dashDir=input.left&&!input.right?-1:input.right&&!input.left?1:p.dir;p.dashTime=.16;p.dashCooldown=1.15;if(!p.grounded)p.dashAirUsed=true;p.swordTime=0;p.swordChain=0;p.swordCombo=0;p.swordBuffer=0;p.attackTime=0;this.echoAt=0;this.emit('dash');this.burst(p.x+17,p.y+32,'#b6e0dc',10);return true;},
   tickAdventure(dt,input){
    const p=this.player;p.dashTime=Math.max(0,p.dashTime-dt);p.dashCooldown=Math.max(0,p.dashCooldown-dt);if(p.grounded)p.dashAirUsed=false;if(input.dashPressed)this.startDash(input);
    for(const e of this.echoes)e.life-=dt;this.echoes=this.echoes.filter(e=>e.life>0);
    this.echoAt-=dt;if(p.dashTime>0&&this.echoAt<=0){this.echoAt=.027;this.echoes.push({player:{...p},life:.19,character:this.character});if(this.echoes.length>7)this.echoes.shift();}
    for(const h of this.impacts)h.life-=dt;this.impacts=this.impacts.filter(h=>h.life>0).slice(-12);
    this.trial.notice=Math.max(0,this.trial.notice-dt);
   },
   updateTrial(dt){
    const t=this.trial,p=this.player;if(!t.active)return;if(this.zone!=='main'){this.cancelTrial();return;}
    t.remaining=Math.max(0,t.remaining-dt);if(t.remaining<=0){this.cancelTrial('trial-expired');return;}
    const b=this.level.trialSpec.beacons[t.lit];if(p.attackTime>0&&Math.abs(b.x-p.x-17)<115&&Math.abs(b.feet-48-p.y-28)<95&&(b.x-p.x-17)*p.dir>-20){
     t.lit++;this.burst(b.x,b.feet-48,'#e8dc9a',28);this.emit('trial-flame',{index:t.lit});
     if(t.lit===3){Object.assign(t,{active:false,complete:true,notice:4});this.lights+=20;p.health=Math.min(3,p.health+1);this.popup(p.x+17,p.y-18,'VEILLEUR · +20','#f3d79c');this.emit('trial-complete',{text:this.level.trialSpec.name});}
    }
   },
   interaction(){
    if(this.zone==='main'){const a=this.level.trialSpec.altar,p=this.player;if(!this.trial.active&&Math.abs(p.x+17-a.x)<57&&Math.abs(p.y+p.h-a.feet)<60)return {kind:'trial',key:'E',label:this.trial.complete?'Défi du veilleur accompli':'Défi facultatif · trois feux de lune'};}
    return originalInteraction.call(this);
   },
   useInteraction(){const it=this.interaction();if(it?.kind!=='trial')return originalUse.call(this);if(this.interactCooldown>0)return false;this.interactCooldown=.35;if(this.trial.complete){this.emit('clue',{text:'Les trois feux veillent sur ton passage. Ta médaille est dans le carnet.'});return false;}Object.assign(this.trial,{active:true,lit:0,remaining:this.level.trialSpec.seconds,notice:0});this.emit('trial-start');return false;},
   respawn(){this.cancelTrial();this.resetDash();originalRespawn.call(this);},
   teleport(x,y){this.cancelTrial();this.resetDash();originalTeleport.call(this,x,y);}
  });
 }
 const api={trials,attach};root.GhostAdventure=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

