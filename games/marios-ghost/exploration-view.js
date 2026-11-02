(function(root){
 'use strict';
 function walk(ctx,assets,name,distance,x,feet,height,dir=1,alpha=1,squash=0){
  const img=assets[name],atlas=root.GhostArt?.[name];if(!img||!atlas)return false;
  const stride=name==='wolf-walk-v3'?116:name==='vampire-walk-v3'?108:132,frame=Math.floor(distance/stride*8)%8,f=atlas[frame],row=frame<4?0:4;
  const mean=atlas.slice(row,row+4).reduce((n,v)=>n+v.box[3],0)/4,s=height/mean;
  ctx.save();ctx.globalAlpha*=alpha;ctx.translate(x,feet);ctx.scale(dir*(1+squash*.08),1-squash*.08);
  ctx.drawImage(img,f.sx,f.sy,f.sw,f.sh,(f.sx-f.anchor)*s,-(f.baseline-f.sy)*s,f.sw*s,f.sh*s);ctx.restore();return true;
 }
 function draw(v){
  const {ctx,assets,world,camera,viewW,glow,time}=v,room=world.level.secret,p=world.player;
  const visible=x=>x-camera>-170&&x-camera<viewW+170;
  const prop=(i,x,feet,w,alpha=1)=>{if(!visible(x))return;const img=assets['secret-props-v3'],b=root.GhostArt['secret-props-v3'][i].box,h=b[3]/b[2]*w;ctx.save();ctx.globalAlpha*=alpha;ctx.drawImage(img,...b,x-camera-w/2,feet-h,w,h);ctx.restore();};
  function portal(x,feet,open,tree=false){
   if(!visible(x))return;const xx=x-camera;
   if(open){glow(xx,feet-52,85,'#b0e3da',.4+.1*Math.sin(time*2));ctx.fillStyle='#061a22';ctx.beginPath();ctx.ellipse(xx,feet-48,25,48,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#c2e5cd88';ctx.lineWidth=1.5;ctx.stroke();
    for(let i=0;i<8;i++){const a=time*.6+i*Math.PI/4;glow(xx+Math.cos(a)*24,feet-48+Math.sin(a)*44,10,'#f4d19b',.5);}}
   prop(tree?1:0,x,feet+2,tree?94:78,open?.5:1);
   if(!open){glow(xx,feet-57,18,'#d5deae',.11+.08*Math.sin(time*1.5));ctx.save();ctx.strokeStyle='#e5d9b94d';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(xx-2,feet-89);ctx.lineTo(xx+5,feet-61);ctx.lineTo(xx-3,feet-40);ctx.stroke();ctx.restore();}
   else{ctx.fillStyle='#cce8dc';ctx.font='9px Georgia';ctx.textAlign='center';ctx.fillText(world.secret.claimed?'RACCOURCI':'PASSAGE',xx,feet-122);}
  }
  function sign(x,feet,label){if(!visible(x))return;const xx=x-camera;prop(0,x,feet+2,42,.9);glow(xx,feet-30,17,'#dac58d',.17);ctx.fillStyle='#dccda8';ctx.textAlign='center';ctx.font='10px Georgia';ctx.fillText(label,xx,feet-65);}
  if(world.zone==='main'){portal(room.entry.x,room.entry.feet,world.secret.revealed,world.level.id===1);sign(world.level.sign.x,620,'☾');}
  else{
   portal(room.exit.x,620,true,world.level.id===1||world.level.id===2);sign(room.origin+185,620,'✦');
   for(const t of room.torches){const lit=world.secret.torches.includes(t.index);prop(lit?7:6,t.x,t.feet,48);if(lit)glow(t.x-camera,t.y-12,65,'#edc480',.5+.06*Math.sin(time*8+t.index));ctx.font='13px Georgia';ctx.textAlign='center';ctx.fillStyle=lit?'#f2d697':'#afbfbe';ctx.fillText(['I','II','III'][t.index],t.x-camera,t.feet-91);}
   if(room.lever){const xx=room.lever.x-camera,feet=room.lever.feet;ctx.save();ctx.translate(xx,feet);ctx.fillStyle='#495457';ctx.beginPath();ctx.roundRect(-20,-15,40,15,4);ctx.fill();ctx.strokeStyle='#c7af80';ctx.lineWidth=5;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(0,-13);ctx.lineTo(world.secret.lever?20:-20,-52);ctx.stroke();glow(world.secret.lever?20:-20,-52,20,world.secret.lever?'#a5dfd0':'#e3b58b',.6);ctx.restore();ctx.textAlign='center';ctx.font='9px Georgia';ctx.fillStyle='#b9d8cf';ctx.fillText(world.secret.lever?'PONT ÉVEILLÉ':'LEVIER',xx,feet-77);}
   const chest=room.chest;prop(world.secret.claimed?3:2,chest.x,chest.feet+2,82);
   if(world.chestReady()||world.secret.claimed)glow(chest.x-camera,chest.feet-45,75,'#efcc83',.3+.1*Math.sin(time*2));
   if(world.secret.claimed){ctx.save();ctx.translate(chest.x-camera,chest.feet-102+Math.sin(time*2)*3);ctx.strokeStyle='#ead7a5';ctx.fillStyle='#dcbe7c';ctx.lineWidth=1.4;ctx.rotate(Math.PI/4);ctx.strokeRect(-8,-8,16,16);ctx.fillRect(-3,-3,6,6);ctx.restore();}
   for(const s of world.level.platforms.filter(s=>s.zone==='secret'&&s.crumble)){
    const xx=s.x-camera;if(!visible(s.x+s.w/2))continue;
    if(s.collapse>0){ctx.save();ctx.setLineDash([5,6]);ctx.strokeStyle='#a2a8bb50';ctx.strokeRect(xx,s.y,s.w,5);ctx.restore();}
    else{ctx.strokeStyle='#d5becd88';ctx.lineWidth=1.2;for(let j=0;j<3;j++){const sx=xx+20+j*s.w/3;ctx.beginPath();ctx.moveTo(sx,s.y);ctx.lineTo(sx+9,s.y+9);ctx.lineTo(sx+3,s.y+16);ctx.stroke();}if(s.stress>0)glow(xx+s.w/2,s.y+5,50,'#e5af9e',s.stress*.7);}
   }
  }
  for(const u of world.level.urns)if(u.zone===world.zone)prop(u.broken?5:4,u.x+15,u.feet+2,u.broken?44:31,u.broken?.65:1);
  for(const pad of world.level.pads){if(pad.zone!==world.zone||!visible(pad.x))continue;const xx=pad.x-camera;glow(xx,pad.y-12,45+(pad.pulse||0)*70,'#97e5df',.36);for(let k=-1;k<=1;k++){const size=k===0?1:.7,x=xx+k*22,y=pad.y-(k===0?0:1);ctx.save();ctx.translate(x,y);ctx.scale(size,1-(pad.pulse||0)*.5);ctx.fillStyle='#91c4bd';ctx.fillRect(-3,-18,6,18);const g=ctx.createRadialGradient(0,-19,1,0,-18,18);g.addColorStop(0,'#c3fbeb');g.addColorStop(.4,'#75bdb8');g.addColorStop(1,'#174655');ctx.fillStyle=g;ctx.beginPath();ctx.ellipse(0,-18,18,9,0,Math.PI,Math.PI*2);ctx.lineTo(18,-17);ctx.quadraticCurveTo(0,-10,-18,-17);ctx.fill();ctx.fillStyle='#c5f6db';ctx.fillRect(-6,-24,3,2);ctx.fillRect(6,-22,2,2);ctx.restore();}}
 }
 root.GhostExplorationView={walk,draw};
})(window);

