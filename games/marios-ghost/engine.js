(function(root){
  'use strict';
  const levelApi=root.GhostLevels||(typeof require!=='undefined'?require('./levels.js'):null);
  const exploration=root.GhostExplorationRules||(typeof require!=='undefined'?require('./exploration-engine.js'):null);
  const heroes=root.GhostHeroes||(typeof require!=='undefined'?require('./heroes.js'):null);
  const adventure=root.GhostAdventure||(typeof require!=='undefined'?require('./adventure.js'):null);
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const overlaps=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  const toward=(a,b,d)=>a<b?Math.min(a+d,b):Math.max(a-d,b);
  class World{
    constructor(id,resume=null,character='hailie'){
      this.level=levelApi.buildLevel(id);this.time=0;this.state='playing';this.events=[];this.particles=[];this.projectiles=[];this.popups=[];this.shake=0;this.lights=0;this.shards=0;this.defeated=0;this.deaths=0;this.checkpoint={x:100,y:562};this.attackId=0;
      this.player={x:100,y:562,w:34,h:58,vx:0,vy:0,dir:1,health:3,grounded:true,groundId:'g0',jumps:0,coyote:.1,jumpBuffer:0,invulnerable:0,cooldown:0,attackTime:0,anim:0,landTime:0,damageTime:0,knockback:0,stepAt:0};
      this.initExploration();this.initHero(character);this.initAdventure();const snap=normalizeCheckpoint(resume,id);if(snap){
        this.time=snap.time;this.deaths=snap.deaths;
        snap.taken.forEach(i=>this.level.coins[i].taken=true);
        snap.defeated.forEach(i=>{this.level.enemies[i].dead=true;this.level.enemies[i].hp=0;});
        snap.activated.forEach(i=>this.level.checkpoints[i].active=true);
        this.lights=snap.taken.filter(i=>this.level.coins[i].type==='light').length+snap.defeated.length*3;
        this.shards=snap.taken.filter(i=>this.level.coins[i].type==='shard').length;this.defeated=snap.defeated.length;this.restoreExploration(snap);this.restoreAdventure(snap);
        if(snap.checkpoint>=0)this.checkpoint={x:this.level.checkpoints[snap.checkpoint].x+15,y:562};
        this.respawn();
      }
    }
    checkpointSave(){return {version:3,level:this.level.id,checkpoint:this.level.checkpoints.findIndex(c=>c.x+15===this.checkpoint.x),activated:this.level.checkpoints.flatMap((c,i)=>c.active?[i]:[]),taken:this.level.coins.flatMap((c,i)=>c.taken?[i]:[]),defeated:this.level.enemies.flatMap((e,i)=>e.dead?[i]:[]),time:this.time,deaths:this.deaths,...this.explorationSave(),trial:this.trial.complete};}
    popup(x,y,text,color='#ecd49b'){this.popups.push({x,y,text,color,life:1.1});}
    emit(type,data={}){this.events.push({type,...data});}
    burst(x,y,color,count=12){for(let i=0;i<count;i++){const angle=(i/count)*Math.PI*2+this.time*7;const speed=35+((i*73)%130);this.particles.push({x,y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-45,life:.5+(i%4)*.13,maxLife:.89,color,size:2+(i%3)});}}
    respawn(){const p=this.player,point=this.spawnPoint();Object.assign(p,{x:point.x,y:point.y,vx:0,vy:0,grounded:false,groundId:null,jumps:0,coyote:0,jumpBuffer:0,invulnerable:2,attackTime:0,swordTime:0,swordChain:0,swordCombo:0,damageTime:0,knockback:0,landTime:0});this.projectiles=[];this.burst(p.x+17,p.y+32,'#bde9df',24);}
    retry(){if(this.state!=='dead')return;this.player.health=3;this.state='playing';this.respawn();this.emit('retry');}
    hurt(sourceX,fall=false){
      const p=this.player;if(this.state!=='playing'||(!fall&&p.invulnerable>0))return;
      p.health--;p.dashTime=0;p.swordBuffer=0;p.swordTime=0;p.swordChain=0;p.damageTime=.45;this.shake=.22;this.emit('hurt');this.burst(p.x+17,p.y+30,'#df9e9c',15);
      if(p.health<=0){this.state='dead';this.deaths++;this.emit('death');return;}
      if(fall){this.respawn();this.emit('fall');}else{p.invulnerable=1.5;p.knockback=.16;p.vx=p.x<sourceX?-270:270;p.vy=-350;p.grounded=false;p.groundId=null;}
    }
    hitEnemy(e,damage=1){if(e.dead||e.hit>0)return;e.hp=Math.max(0,e.hp-damage);e.hit=.4;this.shake=.08;this.burst(e.x+e.w/2,e.y+e.h/2,e.type==='ghost'?'#b1eee5':'#d6c393',15);this.emit('hit');if(e.hp<=0){e.dead=true;e.deathTime=.45;this.defeated++;this.lights+=3;this.popup(e.x+e.w/2,e.y,'+3');this.burst(e.x+e.w/2,e.y+e.h/2,'#d6e8d6',24);this.emit(e.type==='boss'?'boss-defeated':'enemy-defeated');}}
    attack(){const p=this.player;if(p.cooldown>0||p.swordTime>0||p.dashTime>0)return;p.cooldown=.55;p.attackTime=.24;this.attackId++;this.emit('attack');this.burst(p.x+p.w/2+p.dir*35,p.y+28,'#ecd39b',9);}
    step(dt,input={}){
      if(this.state!=='playing')return;dt=clamp(dt,0,1/30);this.time+=dt;this.shake=Math.max(0,this.shake-dt);const p=this.player;
      const oldGround=p.groundId,wasGrounded=p.grounded;
      for(const plat of this.level.platforms){if(plat.zone!==this.zone||!plat.moving)continue;const ox=plat.x,oy=plat.y;plat.x=plat.baseX+Math.sin(this.time*plat.speed)*plat.ampX;plat.y=plat.baseY+Math.sin(this.time*plat.speed)*plat.ampY;if(oldGround===plat.id){p.x+=plat.x-ox;p.y+=plat.y-oy;}}
      p.invulnerable=Math.max(0,p.invulnerable-dt);p.cooldown=Math.max(0,p.cooldown-dt);p.attackTime=Math.max(0,p.attackTime-dt);p.coyote=p.grounded?.11:Math.max(0,p.coyote-dt);p.jumpBuffer=Math.max(0,p.jumpBuffer-dt);
      p.landTime=Math.max(0,p.landTime-dt);p.damageTime=Math.max(0,p.damageTime-dt);p.knockback=Math.max(0,p.knockback-dt);
      this.tickAdventure(dt,input);this.tickSword(dt,input);
      if(input.jumpPressed)p.jumpBuffer=.13;
      if(p.jumpBuffer>0&&(p.coyote>0||p.jumps<2)){
        const first=p.coyote>0||p.jumps===0;p.jumps=first?1:2;p.vy=first?-640:-600;p.grounded=false;p.groundId=null;p.coyote=0;p.jumpBuffer=0;
        this.burst(p.x+17,p.y+58,first?'#9cc4bf':'#e1cf9b',first?7:14);this.emit(first?'jump':'double-jump');
      }
      if(input.jumpReleased&&p.vy<-240)p.vy=-240;
      if(input.attack)this.attack();
      const move=(input.right?1:0)-(input.left?1:0);const target=move*(input.sprint?345:275);if(p.dashTime>0){p.vx=p.dashDir*650;p.dir=p.dashDir;}else{if(p.knockback<=0)p.vx=toward(p.vx,target,dt*(p.grounded?2100:1250));if(move)p.dir=move;}
      const prevX=p.x,prevY=p.y;p.x=clamp(p.x+p.vx*dt,this.bounds().min,this.bounds().max-p.w);
      for(const s of this.activePlatforms()){if(!s.solid||!overlaps(p,s)||p.y+p.h<=s.y+3)continue;if(prevX+p.w<=s.x){p.x=s.x-p.w;p.vx=0;}else if(prevX>=s.x+s.w){p.x=s.x+s.w;p.vx=0;}}
      p.vy=Math.min(p.vy+1700*dt,1000);p.y+=p.vy*dt;p.grounded=false;p.groundId=null;
      if(p.vy>=0){let landing=null;for(const s of this.activePlatforms()){if(p.x+p.w>s.x+2&&p.x<s.x+s.w-2&&prevY+p.h<=s.y+6&&p.y+p.h>=s.y){if(!landing||s.y<landing.y)landing=s;}}if(landing){if(!wasGrounded&&p.vy>180){p.landTime=.16;this.burst(p.x+17,landing.y,'#9bbab3',6);this.emit('land');}p.y=landing.y-p.h;p.vy=0;p.grounded=true;p.groundId=landing.id;p.jumps=0;}}
      p.anim+=dt*(Math.abs(p.vx)>10?Math.abs(p.vx)/26:2);
      const previousStep=Math.floor(p.walkDistance/66);if(p.grounded)p.walkDistance+=Math.abs(p.x-prevX);
      if(p.grounded&&Math.floor(p.walkDistance/66)!==previousStep){this.emit('step');this.burst(p.x+17-p.dir*12,p.y+p.h,'#8daba3',2);}
      if(this.updateExploration(dt,input))return;this.strikeScenery();this.updateTrial(dt);
      if(p.y>830){this.hurt(p.x,true);if(this.state!=='playing')return;}
      for(const c of this.level.coins){if(!this.coinVisible(c)||c.taken||(c.type==='heart'&&p.health===3))continue;const cy=c.y+Math.sin(this.time*2.2+c.x)*4;if(Math.abs(p.x+17-c.x)<29&&Math.abs(p.y+28-cy)<40){c.taken=true;this.burst(c.x,c.y,c.type==='shard'?'#b8e9f4':'#e6c478',12);if(c.type==='light'){this.lights++;this.emit('coin');}else if(c.type==='shard'){this.shards++;this.popup(c.x,c.y,'ÉCLAT DE LUNE','#b8e9f4');this.emit('shard');}else{p.health=Math.min(3,p.health+1);this.popup(c.x,c.y,'+1 ♥','#f0baba');this.emit('heart');}}}
      for(const c of this.level.checkpoints){if(this.zone==='main'&&!c.active&&Math.abs(p.x-c.x)<55&&p.y+p.h>530){c.active=true;this.checkpoint={x:c.x+15,y:562};p.health=3;this.burst(c.x,565,'#e6ce8e',30);this.emit('checkpoint');}}
      for(const h of this.level.hazards){if(h.zone!==this.zone)continue;const inner={x:p.x+7,y:p.y+6,w:p.w-14,h:p.h-7};if(overlaps(inner,h))this.hurt(h.x+h.w/2);}
      for(const e of this.level.enemies){
        if(e.zone!==this.zone)continue;const previousEnemyX=e.x;
        if(e.dead){e.deathTime=Math.max(0,(e.deathTime||0)-dt);continue;}e.hit=Math.max(0,e.hit-dt);
        const dist=Math.abs(p.x-e.x);let speed=e.type==='wolf'?(dist<240?140:70):e.type==='vampire'?64:e.type==='boss'?85:e.type==='bat'?90:43;
        if(e.type==='wolf'){
          e.rushCooldown=Math.max(0,(e.rushCooldown||0)-dt);
          if(e.windup>0){e.windup-=dt;speed=0;if(e.windup<=0){e.rush=.38;this.emit('wolf-rush');}}
          else if(e.rush>0){e.rush-=dt;speed=220;}
          else if(dist<230&&Math.abs(p.y-e.y)<85&&e.rushCooldown===0){e.windup=.48;e.rushCooldown=2.8;e.dir=p.x<e.x?-1:1;speed=0;}
        }
        if(e.type==='boss'&&dist<620){e.dir=p.x<e.x?-1:1;const phase=e.hp<=4?2:1;e.attackAt-=dt;
          if(e.attackAt<.68){speed=0;e.windup=Math.max(0,.68-e.attackAt);}
          if(e.attackAt<=0){e.attackAt=phase===2?2:2.6;e.windup=0;const aim=Math.atan2(p.y+30-(e.y+40),p.x+17-(e.x+e.w/2));for(const spread of phase===2?[-.23,0,.23]:[0])this.projectiles.push({x:e.x+e.w/2,y:e.y+40,vx:Math.cos(aim+spread)*(phase===2?200:175),vy:Math.sin(aim+spread)*(phase===2?200:175),life:5});this.emit('orb');}
          if(phase===2&&!e.enraged){e.enraged=true;this.emit('boss-phase');this.burst(e.x+e.w/2,e.y+40,'#de8fa7',25);}
        }
        if(e.hit>0)speed*=.18;e.x+=e.dir*speed*dt;if(e.x<=e.min){e.x=e.min;e.dir=1;}if(e.x>=e.max){e.x=e.max;e.dir=-1;}
        e.walkDistance+=Math.abs(e.x-previousEnemyX);
        if(e.type==='ghost'||e.type==='bat')e.y=e.baseY+Math.sin(this.time*(e.type==='bat'?2.7:1.8)+e.phase)*(e.type==='bat'?32:20);
        if(p.attackTime>0&&Math.abs((e.x+e.w/2)-(p.x+17))<115&&Math.abs((e.y+e.h/2)-(p.y+28))<95&&((e.x+e.w/2-p.x-17)*p.dir)>-20&&e.lastAttack!==this.attackId){e.lastAttack=this.attackId;this.hitEnemy(e);}
        this.strikeEnemy(e);
        if(!e.dead&&overlaps({x:p.x+5,y:p.y+4,w:p.w-10,h:p.h-5},{x:e.x+5,y:e.y+5,w:e.w-10,h:e.h-6})){
          if(p.vy>70&&prevY+p.h<e.y+20){this.hitEnemy(e);p.vy=-450;p.jumps=Math.min(p.jumps,1);p.grounded=false;p.groundId=null;}else if(e.hit<=0&&p.dashTime<=0)this.hurt(e.x+e.w/2);
        }
      }
      for(const orb of this.projectiles){orb.x+=orb.vx*dt;orb.y+=orb.vy*dt;orb.life-=dt;if(orb.life>0&&this.swordContact(orb.x,orb.y)){orb.life=0;this.burst(orb.x,orb.y,'#c5edee',16);this.emit('sword-parry');}else if(p.attackTime>0&&Math.hypot(orb.x-p.x-17,orb.y-p.y-28)<110){orb.life=0;this.burst(orb.x,orb.y,'#e8c883',10);}else if(orb.life>0&&p.dashTime<=0&&Math.hypot(orb.x-p.x-17,orb.y-p.y-28)<27){this.hurt(orb.x);orb.life=0;}}
      this.projectiles=this.projectiles.filter(o=>o.life>0);
      for(const q of this.particles){q.life-=dt;q.x+=q.vx*dt;q.y+=q.vy*dt;q.vy+=130*dt;}this.particles=this.particles.filter(q=>q.life>0);if(this.particles.length>350)this.particles.splice(0,this.particles.length-350);
      for(const t of this.popups){t.life-=dt;t.y-=25*dt;}this.popups=this.popups.filter(t=>t.life>0).slice(-20);
      if(this.state==='playing'&&this.zone==='main'&&p.x>this.level.goal-25&&Math.abs(p.y+p.h-620)<110){
        const guardian=this.level.enemies.find(e=>e.type==='boss'&&!e.dead);
        if(guardian){if(!this.gateWarned){this.emit('gate-locked');this.gateWarned=true;}}else{this.state='won';this.emit('win',{lights:this.lights,shards:this.shards,time:this.time});}
      }
    }
  }
  exploration.attach(World);heroes.attach(World);adventure.attach(World);
  function normalizeCheckpoint(raw,id){
    if(!raw||![1,2,3].includes(raw.version)||raw.level!==id||!Number.isInteger(id)||id<0||id>4)return null;
    const level=levelApi.buildLevel(id);const cp=raw.checkpoint;
    if(!Number.isInteger(cp)||cp< -1||cp>=level.checkpoints.length||!Number.isFinite(raw.time)||raw.time<0||raw.time>86400)return null;
    const indexes=(value,count)=>Array.isArray(value)&&value.length<=count&&value.every(i=>Number.isInteger(i)&&i>=0&&i<count)&&new Set(value).size===value.length;
    if(!indexes(raw.taken,raw.version===1?level.legacyCounts.coins:level.coins.length)||!indexes(raw.defeated,raw.version===1?level.legacyCounts.enemies:level.enemies.length)||!indexes(raw.activated,level.checkpoints.length)||(cp>=0&&!raw.activated.includes(cp)))return null;
    if(raw.version===3&&typeof raw.trial!=='boolean')return null;
    const extra=exploration.normalize(raw,level,indexes);if(!extra)return null;
    return {version:3,trial:raw.version===3?raw.trial:false,...extra,level:id,checkpoint:cp,time:raw.time,deaths:clamp(Number.isInteger(raw.deaths)?raw.deaths:0,0,9999),taken:[...raw.taken],defeated:[...raw.defeated],activated:[...raw.activated]};
  }
  function cleanSave(raw){
    const save={version:1,character:'hailie',trials:[false,false,false,false,false],completed:[false,false,false,false,false],best:[null,null,null,null,null],sound:true,volume:.5,softEffects:false,discoveries:Array.from({length:5},()=>({found:false,relic:false})),runs:[null,null,null,null,null]};
    if(!raw||raw.version!==1)return save;save.character=heroes.valid(raw.character)?raw.character:'hailie';save.sound=raw.sound!==false;save.volume=Number.isFinite(raw.volume)?clamp(raw.volume,0,1):.5;save.softEffects=raw.softEffects===true;
    for(let i=0;i<5;i++){
      // A later chapter cannot be unlocked by a corrupt or incomplete save chain.
      save.completed[i]=(i===0||save.completed[i-1])&&raw.completed?.[i]===true;
      const b=raw.best?.[i];if(save.completed[i]&&b&&typeof b==='object')save.best[i]={lights:clamp(Number.isFinite(b.lights)?Math.floor(b.lights):0,0,9999),shards:clamp(Number.isFinite(b.shards)?Math.floor(b.shards):0,0,3),time:clamp(Number.isFinite(b.time)?b.time:0,0,86400)};
    }for(let i=0;i<5;i++){if(i===0||save.completed[i-1]){save.runs[i]=normalizeCheckpoint(raw.runs?.[i],i);const d=raw.discoveries?.[i],run=save.runs[i];save.trials[i]=raw.trials?.[i]===true||run?.trial===true;save.discoveries[i]={found:d?.found===true||run?.secret?.visited===true||d?.relic===true,relic:d?.relic===true||run?.secret?.claimed===true};}}return save;
  }
  const unlocked=(save,id)=>Number.isInteger(id)&&id>=0&&id<5&&(id===0||save.completed[id-1]===true);
  function recordWin(save,id,result){if(!unlocked(save,id))return false;save.completed[id]=true;if(save.runs)save.runs[id]=null;const old=save.best[id];save.best[id]={lights:Math.max(old?.lights||0,result.lights),shards:Math.max(old?.shards||0,result.shards),time:old?Math.min(old.time,result.time):result.time};return true;}
  const api={World,clamp,overlaps,cleanSave,unlocked,recordWin,normalizeCheckpoint};root.GhostEngine=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
