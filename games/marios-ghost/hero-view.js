(function(root){
 'use strict';
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 function sheet(ctx,assets,name,index,x,feet,height,dir=1,alpha=1,squash=0){
  const data=root.HeroArt?.[name],img=assets[name];if(!data||!img)return false;const f=data.frames[index],s=height/(f.bodyHeight||data.bodyHeight);
  ctx.save();ctx.globalAlpha*=alpha;ctx.translate(x,feet);ctx.scale(dir*(1+squash*.08),1-squash*.08);ctx.drawImage(img,f.sx,f.sy,f.sw,f.sh,(f.sx-f.anchor)*s,-(f.baseline-f.sy)*s,f.sw*s,f.sh*s);ctx.restore();return true;
 }
 function sheath(ctx,assets,x,feet,dir=1,size=1,alpha=1){
  const img=assets['moonblade-v4'],f=root.HeroArt?.['moonblade-v4']?.frames[1];if(!img||!f)return;const b=f.box,s=37*size/b[3];ctx.save();ctx.globalAlpha*=alpha*.9;ctx.translate(x-9*dir*size,feet-44*size);ctx.rotate(-.34*dir);ctx.drawImage(img,...b,-b[2]*s/2,0,b[2]*s,b[3]*s);ctx.restore();
 }
 function draw(ctx,assets,id,p,time,x,feet,height=67,alpha=1,soft=false){
  const hero=root.GhostHeroes.get(id),sword=p.swordTime>0,dir=sword?p.swordDir:p.dir,squash=soft?0:(p.landTime||0)/.16;
  if(!sword)sheath(ctx,assets,x,feet,dir,height/67,alpha);
  if(id==='hailie'&&!sword){
   if(p.grounded&&Math.abs(p.vx)>15)return root.GhostExplorationView.walk(ctx,assets,'hailie-walk-v3',p.walkDistance||0,x,feet,height,dir,alpha,squash);
   const img=assets['hailie-v2'];if(!img)return;let row=0,frame=Math.floor(time*2)%4;
   if(p.attackTime>0){row=3;frame=clamp(Math.floor((.24-p.attackTime)/.06),0,3);}else if(p.landTime>.07&&Math.abs(p.vx)<120){row=2;frame=3;}else if(!p.grounded){row=2;frame=p.vy<-300?0:p.vy<80?1:2;}
   const sy=[0,.271,.511,.749,1],base=[.258,.504,.746,.98],cw=img.width/4,y=sy[row]*img.height,h=(sy[row+1]-sy[row])*img.height,s=.247*(1254/img.height)*(height/67);
   ctx.save();ctx.globalAlpha*=alpha;ctx.translate(x,feet);ctx.scale(dir*(1+squash*.08),1-squash*.08);ctx.drawImage(img,frame*cw,y,cw,h,-cw*.61*s,-(base[row]*img.height-y)*s,cw*s,h*s);ctx.restore();return;
  }
  let index=Math.floor(time*1.5)%2;
  if(sword){const progress=1-p.swordTime/p.swordDuration;index=clamp(Math.floor(progress*4),0,3);if(id==='hailie')index+=(p.swordCombo===1?0:4);else index+=12;}
  else if(p.attackTime>0)index=16+clamp(Math.floor((.24-p.attackTime)/.06),0,3);
  else if(!p.grounded)index=p.vy<0?2:3;
  else if(Math.abs(p.vx)>15)index=4+Math.floor((p.walkDistance||0)/132*8)%8;
  sheet(ctx,assets,id==='hailie'?'hailie-sword-v4':hero.asset,index,x,feet,height,dir,alpha,squash);
 }
 function trail(ctx,p,x,y,accent,soft=false){
  if(!p.swordTime)return;const progress=1-p.swordTime/p.swordDuration;if(progress<.16||progress>.87)return;
  const q=(progress-.16)/.71,r=p.swordCombo===3?94:80,alpha=Math.sin(q*Math.PI)*.85,reverse=p.swordCombo===2;
  ctx.save();ctx.translate(x,y);ctx.scale(p.swordDir,reverse?-1:1);ctx.globalAlpha=alpha;ctx.strokeStyle=p.swordCombo===3?'#f4d79b':accent;ctx.lineWidth=p.swordCombo===3?6:4;ctx.shadowColor=accent;ctx.shadowBlur=soft?0:12;ctx.beginPath();ctx.arc(0,0,r,-1.22+q*.25,.55+q*.7);ctx.stroke();ctx.shadowBlur=0;ctx.lineWidth=1.2;ctx.strokeStyle='#f0fcff';ctx.beginPath();ctx.arc(0,0,r-6,-1+q*.2,.4+q*.65);ctx.stroke();ctx.restore();
 }
 root.GhostHeroView={draw,sheet,sheath,trail};
})(window);

