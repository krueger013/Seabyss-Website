(function(root){
 'use strict';
 const list=[
  {id:'hailie',name:'Hailie',title:'La porteuse de lumière',description:'Sa lanterne éclaire les chemins oubliés. Sa nouvelle lame veille sur ses aventures.',accent:'#e8c68b',asset:null,symbol:'☾'},
  {id:'luna',name:'Luna',title:'La gardienne de la lune',description:'Une jeune sorcière aux couleurs de la nuit, guidée par les étoiles et les lueurs anciennes.',accent:'#a5dfd7',asset:'luna-v4',symbol:'✧'},
  {id:'vlad',name:'Vlad',title:'Le vampire voyageur',description:'Cape écarlate et sourire malicieux : ce vampire a choisi de défendre les royaumes.',accent:'#dda0b3',asset:'vlad-v4',symbol:'♢'},
  {id:'fen',name:'Fen',title:'Le loup des brumes',description:'Un loup-garou courageux qui explore les bois hantés, les oreilles toujours aux aguets.',accent:'#c3d4a0',asset:'fen-v4',symbol:'❧'}
 ];
 const valid=id=>list.some(h=>h.id===id),get=id=>list.find(h=>h.id===id)||list[0];
 function attach(World){Object.assign(World.prototype,{
  initHero(id){this.character=valid(id)?id:'hailie';this.swordId=0;Object.assign(this.player,{swordBuffer:0,swordTime:0,swordDuration:.32,swordCooldown:0,swordCombo:0,swordChain:0,swordDir:1});},
  setCharacter(id){if(!valid(id))return false;this.character=id;return true;},
  tickSword(dt,input){const p=this.player;p.swordTime=Math.max(0,p.swordTime-dt);p.swordCooldown=Math.max(0,p.swordCooldown-dt);p.swordChain=Math.max(0,p.swordChain-dt);if(!p.swordChain&&!p.swordTime)p.swordCombo=0;p.swordBuffer=Math.max(0,p.swordBuffer-dt);if(input.swordPressed)p.swordBuffer=.16;if(input.sword||p.swordBuffer>0){if(this.swingSword(input))p.swordBuffer=0;}},
  swingSword(input={}){const p=this.player;if(this.state!=='playing'||p.swordCooldown>0||p.dashTime>0||p.attackTime>0||p.swordTime>0)return false;p.swordCombo=p.swordChain>0?p.swordCombo%3+1:1;p.swordDuration=p.swordCombo===3?.38:.32;p.swordTime=p.swordDuration;p.swordCooldown=p.swordCombo===3?.56:.43;p.swordChain=.95;p.swordDir=input.left&&!input.right?-1:input.right&&!input.left?1:p.dir;this.swordId++;this.emit('sword',{combo:p.swordCombo});return true;},
  swordActive(){const p=this.player,t=p.swordDuration-p.swordTime;return p.swordTime>0&&t>=(p.swordCombo===3?.09:.065)&&t<=(p.swordCombo===3?.265:.205);},
  swordRange(){return this.player.swordCombo===3?94:80;},
  swordContact(x,y,w=0,h=0){if(!this.swordActive())return false;const p=this.player,dx=(x-p.x-17)*p.swordDir;return dx>=-10-w*.2&&dx<=this.swordRange()+w*.35&&Math.abs(y-p.y-28)<36+h*.3;},
  strikeEnemy(e){if(e.dead||e.hit>0||e.lastSword===this.swordId||!this.swordContact(e.x+e.w/2,e.y+e.h/2,e.w,e.h))return;e.lastSword=this.swordId;this.hitEnemy(e,this.player.swordCombo===3?2:1);const direction=this.player.swordDir;e.x=Math.max(e.min,Math.min(e.max,e.x+direction*(this.player.swordCombo===3?48:25)));this.impacts.push({x:e.x+e.w/2,y:e.y+e.h/2,life:.24,power:this.player.swordCombo===3?2:1,color:get(this.character).accent});this.shake=this.player.swordCombo===3?.14:.09;this.burst(e.x+e.w/2,e.y+e.h/2,get(this.character).accent,15);this.emit('sword-hit',{combo:this.player.swordCombo});},
  strikeScenery(){if(!this.swordActive())return;for(const u of this.level.urns)if(u.zone===this.zone&&!u.broken&&this.swordContact(u.x+15,u.y+18,30,36)){u.broken=true;this.burst(u.x+15,u.y+18,'#b4c9d5',18);this.emit('urn');}}
 });}
 const api={list,get,valid,attach};root.GhostHeroes=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

