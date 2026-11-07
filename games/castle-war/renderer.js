(function (root) {
  'use strict';

  const W = 1000, H = 700;
  const COLORS = ['#72eedb', '#ff887d', '#f8c76a', '#bc9dff'];
  const DARK = ['#176b71', '#943c48', '#9b6b32', '#66518f'];
  const terrainCache = new WeakMap();
  const THEMES={
    abyss:{sea:['#061c2a','#0a3740','#061c28'],glow:'#1aa99a25',rim:'#3ba999',land:'#28594d',edge:'#486e58',road:'#3c5551',stone:['#405b53','#4b6657','#35544c','#3b5552'],crack:'#172f31',arena:'#31574d',trim:'#7ea776',rune:'#9ac690',accent:'#65e6c4'},
    ember:{sea:['#241423','#692d25','#221320'],glow:'#ff6b252a',rim:'#e58a49',land:'#39333b',edge:'#6e4c42',road:'#4d3e42',stone:['#55464a','#614a4b','#453b45','#4c3b40'],crack:'#201d2c',arena:'#46383f',trim:'#ad7652',rune:'#e5a172',accent:'#ffad5b'},
    frost:{sea:['#151b3e','#283d69','#181c39'],glow:'#9593ff24',rim:'#88b6db',land:'#4b5975',edge:'#9caec0',road:'#5d6887',stone:['#69768f','#718098','#566681','#60718c'],crack:'#303c60',arena:'#4f607b',trim:'#a8bcce',rune:'#c5d8ed',accent:'#bdb6ff'}
  };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const color = team => COLORS[team] || COLORS[0];
  const finite = n => Number.isFinite(n);

  function path(c, points, fill, stroke, width = 1) {
    c.beginPath();
    points.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  function circle(c, x, y, r, fill, stroke, lineWidth = 1) {
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lineWidth; c.stroke(); }
  }
  function ellipse(c, x, y, rx, ry, fill) {
    c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
  }
  function rounded(c, x, y, width, height, radius, fill, stroke) {
    c.beginPath();
    c.moveTo(x + radius, y); c.lineTo(x + width - radius, y);
    c.quadraticCurveTo(x + width, y, x + width, y + radius);
    c.lineTo(x + width, y + height - radius);
    c.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    c.lineTo(x + radius, y + height);
    c.quadraticCurveTo(x, y + height, x, y + height - radius);
    c.lineTo(x, y + radius); c.quadraticCurveTo(x, y, x + radius, y);
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1; c.stroke(); }
  }
  function line(c, points, stroke, width = 1) {
    c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.strokeStyle = stroke; c.lineWidth = width; c.stroke();
  }
  function seed(n) { return (Math.sin(n * 127.1 + 42.73) * 43758.5453) % 1; }
  function rand(n) { return Math.abs(seed(n)); }
  function glow(c, x, y, radius, inner, outer = 'transparent') {
    const gradient = c.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, inner); gradient.addColorStop(1, outer);
    circle(c, x, y, radius, gradient);
  }
  function crystal(c, x, y, size, tint = '#70e9d8') {
    path(c, [[x,y-size],[x+size*.5,y-size*.2],[x+size*.3,y+size*.5],[x-size*.25,y+size*.5],[x-size*.5,y-size*.2]], tint, '#0f555c', 1);
    path(c, [[x,y-size],[x+size*.1,y+size*.35],[x-size*.4,y-size*.2]], '#c0fff0');
    line(c, [[x+size*.1,y+size*.35],[x+size*.48,y-size*.2]], '#3cb6ba', 1);
  }
  function rock(c, x, y, r, n = 0) {
    ellipse(c,x+3,y+6,r*1.1,r*.45,'#04242c');
    const points = [[x-r,y],[x-r*.7,y-r*.55],[x+r*.15,y-r*.7],[x+r,y-r*.1],[x+r*.7,y+r*.4],[x-r*.35,y+r*.5]];
    path(c, points, n % 2 ? '#26565a' : '#294b54', '#36656a');
    path(c, [points[0],points[1],points[2],[x+r*.2,y]], '#3b6767');
    line(c, [[x-r*.5,y+r*.1],[x+r*.25,y+r*.1],[x+r*.6,y-r*.12]], '#407677', 1);
  }
  function grass(c, x, y, size, tint = '#38766b') {
    line(c, [[x-size*.7,y],[x-size*.5,y-size*.65],[x,y],[x+size*.1,y-size],[x+size*.25,y],[x+size*.8,y-size*.5]], tint, 2);
  }
  function coral(c, x, y, size, tint) {
    c.lineCap = 'round';
    line(c,[[x,y],[x,y-size],[x-size*.25,y-size*1.3]],tint,3);
    line(c,[[x,y-size*.3],[x-size*.55,y-size*.7],[x-size*.55,y-size]],tint,3);
    line(c,[[x,y-size*.6],[x+size*.45,y-size],[x+size*.65,y-size*.9]],tint,3);
    c.lineCap='butt';
  }

  function baseTerrain(c, mode, mapId='abyss') {
    const theme=THEMES[mapId]||THEMES.abyss;
    const sea = c.createLinearGradient(0,0,1000,700);
    sea.addColorStop(0,theme.sea[0]); sea.addColorStop(.5,theme.sea[1]); sea.addColorStop(1,theme.sea[2]);
    c.fillStyle=sea; c.fillRect(0,0,W,H);
    glow(c,500,340,520,theme.glow);

    // Quiet seabed contours and scattered sunken stones.
    for(let i=0;i<85;i++) {
      const x=rand(i*4+1)*W, y=rand(i*4+2)*H;
      const rx=14+rand(i*4+3)*58;
      c.beginPath(); c.ellipse(x,y,rx,rx*.3, -.25, .2, Math.PI*1.3);
      c.strokeStyle = i%3===0 ? theme.accent+'18' : '#04131e29'; c.lineWidth=1.5; c.stroke();
    }
    for(let i=0;i<42;i++) {
      const x=rand(i*7+5)*W,y=rand(i*9+7)*H;
      if(Math.abs(x-500)<245 || (mode===4&&Math.abs(y-350)<155)) continue;
      ellipse(c,x,y,4+rand(i+3)*12,2+rand(i+4)*7,theme.sea[0]);
    }
    // Each biome changes its surrounding geography, not only its palette.
    if(mapId==='ember'){
      for(const mirrored of [false,true]){
        c.save();if(mirrored){c.translate(1000,0);c.scale(-1,1);}
        const lava=[[116,0],[148,90],[111,169],[180,232],[137,302],[184,359],[121,427],[153,505],[95,581],[121,700]];
        line(c,lava,'#c5532e55',48);line(c,lava,'#d95d32',23);line(c,lava,'#ffa25b',9);
        line(c,[[180,232],[269,204],[293,128]],'#dd743e',12);
        line(c,[[121,427],[66,471],[0,457]],'#e07b43',9);
        for(let j=0;j<4;j++){const y=82+j*168;glow(c,140,y,43,'#ff733c36');}
        c.restore();
      }
    }else if(mapId==='frost'){
      for(const [x,y,s] of [[121,98,70],[818,84,62],[102,547,82],[847,568,80],[239,185,29],[760,516,35]]){
        path(c,[[x-s,y],[x-s*.3,y-s*.45],[x+s*.65,y-s*.3],[x+s,y+s*.15],[x+s*.1,y+s*.5],[x-s*.8,y+s*.28]],'#425c804d','#739fc54d',2);
        line(c,[[x-s*.2,y-s*.2],[x+s*.15,y],[x-s*.1,y+s*.28]],'#9ecce160',2);
      }
    }

    // A single cross-shaped stone island keeps every route visible.
    const island = mode===4 ? [[397,30],[602,30],[644,72],[650,218],[686,236],[933,236],[974,281],[976,416],[931,462],[683,462],[649,486],[646,631],[601,674],[395,674],[353,632],[351,484],[317,462],[69,462],[24,418],[24,282],[67,237],[317,237],[353,217],[355,74]]
      : [[392,26],[603,26],[657,76],[656,222],[701,271],[724,350],[701,430],[655,479],[652,628],[605,675],[392,675],[344,628],[346,479],[298,430],[275,350],[299,272],[344,222],[344,75]];
    c.save(); c.translate(0,16); path(c,island,'#101f2b','#07151f',12); c.restore();
    path(c,island,theme.edge,theme.rim,5);
    c.save(); c.translate(0,-5); path(c,island,theme.land,'#101e29',3); c.restore();
    path(c,island,null,theme.rim+'80',1);
    c.save();
    c.beginPath();island.forEach((p,i)=>i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]));c.closePath();c.clip();
    for(let i=0;i<135;i++) {
      const x=rand(i*3+30)*W,y=rand(i*5+11)*H;
      const s=3+rand(i+1)*6;
      ellipse(c,x,y,s*2,s,theme.crack+'38');
      if(i%3===0) grass(c,x,y,s,theme.trim+'4c');
    }
    c.restore();

    // Cobblestone routes, with raised borders and a circular meeting place.
    rounded(c,423,48,154,602,18,theme.crack,theme.trim);
    rounded(c,435,49,130,601,12,theme.road,theme.trim+'59');
    if(mode===4) {
      rounded(c,44,281,912,138,17,theme.crack,theme.trim);
      rounded(c,45,292,910,115,12,theme.road,theme.trim+'59');
    }
    c.save();
    c.beginPath();c.rect(436,49,128,600); if(mode===4)c.rect(45,293,910,113);c.clip();
    for(let row=0;row<19;row++) for(let col=0;col<24;col++){
      const x=col*44+(row%2)*22-20,y=row*37+15;
      const shade=theme.stone[Math.floor(rand(row*100+col)*4)];
      rounded(c,x+2,y+2,40,33,4,shade,theme.crack);
      line(c,[[x+6,y+4],[x+35,y+4]],theme.trim+'4d');
    }
    c.restore();
    ellipse(c,500,357,153,137,'#0c1b27');
    circle(c,500,350,144,theme.land,theme.trim,3);
    circle(c,500,350,133,theme.arena,theme.crack,4);
    circle(c,500,350,120,theme.arena,theme.trim,2);
    circle(c,500,350,104,null,theme.trim+'4a',1);
    for(let i=0;i<12;i++) {
      const a=i*Math.PI/6;
      line(c,[[500+Math.cos(a)*121,350+Math.sin(a)*121],[500+Math.cos(a)*132,350+Math.sin(a)*132]],theme.crack,2);
      const x=500+Math.cos(a)*111,y=350+Math.sin(a)*111;
      path(c,[[x,y-3],[x+3,y],[x,y+3],[x-3,y]],theme.rune+'7a');
    }
    // The engraved trident at the heart of the arena.
    c.save();c.translate(500,350);c.rotate(-.15);c.globalAlpha=.24;
    line(c,[[0,45],[0,-42]],theme.rune,7);
    line(c,[[-27,-35],[-27,-9],[0,8],[27,-9],[27,-35]],theme.rune,7);
    path(c,[[-35,-28],[-27,-49],[-19,-28]],theme.rune);
    path(c,[[19,-28],[27,-49],[35,-28]],theme.rune);
    path(c,[[-8,-35],[0,-57],[8,-35]],theme.rune);
    c.restore();

    // Low ancient pillars and bioluminescent reefs frame the playable space.
    const decor=[[369,178],[630,184],[366,526],[632,522],[307,324],[694,383],[336,408],[665,280]];
    if(mode===4) decor.push([239,255],[763,437],[239,437],[765,253]);
    decor.forEach(([x,y],i)=>{
      rock(c,x,y,13+i%3*3,i);
      if(mapId==='ember'){
        path(c,[[x-18,y+7],[x-13,y-20],[x+2,y-30],[x+18,y+7]],'#36313d','#161925',3);
        line(c,[[x+2,y-23],[x-4,y-8],[x+3,y+5]],'#fa9a52',2);
      }else if(mapId==='frost'){
        crystal(c,x-8,y-10,24,'#82a9d0');crystal(c,x+10,y-5,18,'#aaafe8');
        ellipse(c,x,y+10,24,5,'#d3ddea');
      }else{
        grass(c,x-13,y+7,12,'#6a956b');
        if(i%2===0) crystal(c,x+4,y-9,15,'#59bdb7');
      }
    });
    [[389,74],[614,73],[389,628],[616,631]].forEach(([x,y])=>{
      ellipse(c,x+2,y+8,15,7,'#173d3d');
      path(c,[[x-9,y+5],[x-9,y-25],[x+9,y-25],[x+9,y+5]],'#6f8270','#284c49',2);
      path(c,[[x-14,y-25],[x-14,y-33],[x+14,y-33],[x+14,y-25]],'#8d9b7d','#344f47',1);
      line(c,[[x-4,y-20],[x-4,y+1]],'#a0ad86',2);
      crystal(c,x,y-38,8,theme.accent);
    });
    [[77,85,28],[852,103,24],[124,571,25],[854,594,35],[229,181,19],[756,524,22]].forEach(([x,y,s],i)=>{
      rock(c,x,y,s,i);
      if(mapId==='ember'){
        path(c,[[x-s,y+9],[x-s*.7,y-s],[x-s*.2,y-s*.8],[x,y-s*1.6],[x+s*.5,y-s],[x+s,y+9]],'#352d3b','#171822',4);
        path(c,[[x-5,y-s],[x+3,y-s*.4],[x-7,y+4],[x+7,y-s*.3],[x+1,y-s]],'#fcac58');
        glow(c,x,y-s*.5,s,'#ff864d27');
      }else if(mapId==='frost'){
        crystal(c,x-10,y-8,s*1.3,'#799ecb');crystal(c,x+14,y-5,s*.8,'#b4b2e6');
        ellipse(c,x,y+10,s,7,'#b0c8da');
      }else{
        coral(c,x-8,y+2,s*.8,i%2?'#397c7a':'#557987');coral(c,x+13,y+6,s*.5,i%2?'#80a292':'#679699');
        if(i%2) crystal(c,x-7,y-4,12,'#558f9a');
        // Giant cartoon mushrooms glow along the cursed reef.
        line(c,[[x+31,y+9],[x+31,y-11]],'#518a89',6);
        ellipse(c,x+31,y-10,17,9,'#57b6b1');ellipse(c,x+31,y-11,13,6,'#9de2bd');
        circle(c,x+27,y-13,2,'#e4f2bf');circle(c,x+36,y-10,2,'#e4f2bf');
      }
    });
    // Thin map frame and navigational ornaments.
    rounded(c,12,12,976,676,20,null,'#8bb3a21c');
    for(const [x,y] of [[27,27],[973,27],[27,673],[973,673]]){
      const sx=x<500?1:-1,sy=y<350?1:-1;
      line(c,[[x+sx*23,y],[x,y],[x,y+sy*23]],'#7eac9f62',2);
      circle(c,x,y,3,'#7eac9f');
    }
  }

  function healthBar(c, x, y, width, fraction, tint, height=5) {
    const hp=clamp(fraction||0,0,1);
    rounded(c,x-width/2-1,y-1,width+2,height+2,2,'#071b22');
    rounded(c,x-width/2,y,width,height,2,'#233c40');
    if(hp>0) rounded(c,x-width/2,y,width*hp,height,Math.min(2,width*hp/2),tint);
  }
  function material(c,x1,y1,x2,y2,stops){
    const g=c.createLinearGradient(x1,y1,x2,y2);
    stops.forEach((stop,i)=>g.addColorStop(i/(stops.length-1),stop));
    return g;
  }
  function ease(value){const t=clamp(value,0,1);return t*t*(3-2*t);}
  function attackPose(countdown){
    if(!countdown)return 0;
    const phase=1-clamp(countdown/.25,0,1);
    if(phase<.2)return -.3*ease(phase/.2);
    if(phase<.6)return -.3+1.3*ease((phase-.2)/.4);
    return 1-ease((phase-.6)/.4);
  }
  function sigil(c,x,y,team,size=5){
    c.save();c.translate(x,y);c.scale(size/5,size/5);
    const gold='#f2dfad';
    if(team===1){path(c,[[-4,4],[-5,-1],[-1,0],[1,-7],[5,0],[3,5]],gold);}
    else if(team===2){circle(c,0,0,3,gold);for(let i=0;i<8;i++){const a=i*Math.PI/4;line(c,[[Math.cos(a)*4,Math.sin(a)*4],[Math.cos(a)*6,Math.sin(a)*6]],gold,.8);}}
    else if(team===3){c.beginPath();c.moveTo(2,-6);c.bezierCurveTo(-6,-5,-6,5,2,6);c.bezierCurveTo(-2,2,-2,-2,2,-6);c.fillStyle=gold;c.fill();path(c,[[4,-2],[5,0],[4,2],[3,0]],gold);}
    else{line(c,[[0,5],[0,-5]],gold,1.4);line(c,[[-4,-4],[-4,-1],[0,2],[4,-1],[4,-4]],gold,1.4);}
    c.restore();
  }
  function torch(c,x,y,time,scale=1,tint='#ffad64'){
    c.save();c.translate(x,y);c.scale(scale,scale);
    const flicker=Math.sin(time*13+x)*2+Math.sin(time*19+y);
    glow(c,0,-5,24,tint+'20');
    path(c,[[-4,0],[-3,9],[3,9],[4,0]],'#25313d','#111b28',1.5);
    c.beginPath();c.moveTo(0,0);c.bezierCurveTo(-10,-3,-6,-11,-3,-14);c.bezierCurveTo(-4,-6,4,-9,2+flicker,-21-flicker);c.bezierCurveTo(13,-8,8,1,0,0);
    c.fillStyle='#e9673e';c.fill();
    c.beginPath();c.moveTo(-3,-1);c.quadraticCurveTo(-6,-7,1,-13-flicker);c.quadraticCurveTo(8,-3,1,0);c.closePath();c.fillStyle='#ffd28a';c.fill();
    path(c,[[-1,0],[1,-8],[3,-1]],'#fff1b6');c.restore();
  }
  function smoke(c,x,y,time,seedValue,scale=1){
    for(let i=0;i<3;i++){
      const p=(time*.32+i*.32+seedValue)%1;
      const sx=x+Math.sin(p*4+seedValue)*10*scale,sy=y-p*44*scale;
      c.save();c.globalAlpha=(1-p)*.2;
      ellipse(c,sx,sy,(5+p*12)*scale,(7+p*10)*scale,'#181c2c');c.restore();
    }
  }
  function snowflake(c,x,y,size,tint='#d8f8ff'){
    for(let j=0;j<6;j++){
      const a=j*Math.PI/3,dx=Math.cos(a),dy=Math.sin(a),px=-dy,py=dx;
      line(c,[[x,y],[x+dx*size,y+dy*size]],tint,1.2);
      for(const side of [-1,1])line(c,[[x+dx*size*.6,y+dy*size*.6],[x+dx*size*.42+px*size*.22*side,y+dy*size*.42+py*size*.22*side]],tint,1);
    }
  }
  function statusAura(c,entity,time,reducedMotion,radius=19,centerY=-9){
    if((entity.wardTime||0)>0){
      const pulse=reducedMotion?0:Math.sin(time*3+radius)*.04;
      c.save();c.globalAlpha=.26+pulse;
      const g=c.createRadialGradient(0,centerY,radius*.4,0,centerY,radius*1.1);
      g.addColorStop(0,'#7cf3e300');g.addColorStop(.8,'#8eeade18');g.addColorStop(1,'#c8f9ff');
      c.beginPath();c.ellipse(0,centerY,radius,radius*.85,0,0,Math.PI*2);c.fillStyle=g;c.fill();c.strokeStyle='#d1fff3';c.lineWidth=1.4;c.stroke();
      c.beginPath();c.ellipse(0,centerY,radius*.4,radius*.85,-.3,0,Math.PI*2);c.strokeStyle='#b1fff25c';c.lineWidth=1;c.stroke();c.restore();
      path(c,[[-4,centerY-radius*.85-3],[4,centerY-radius*.85-3],[4,centerY-radius*.85+2],[0,centerY-radius*.85+5],[-4,centerY-radius*.85+2]],'#afe9dc','#256c78',1);
    }
    if((entity.slowTime||0)>0){
      for(const side of [-1,1]){
        const ix=side*radius*.72;
        path(c,[[ix-4,7],[ix-3,-3],[ix+1,-8],[ix+5,7]],'#8fc9e481','#dcf5ff',.7);
      }
      snowflake(c,radius*.6,centerY-radius*.65,5,'#e3faff');
    }
    if((entity.burnTime||0)>0){
      for(const side of [-1,1]){
        const fx=side*radius*.6,fy=4,flutter=reducedMotion?0:Math.sin(time*14+side)*3;
        glow(c,fx,fy,12,'#ff9b4345');
        path(c,[[fx-4,fy],[fx-6,fy-7],[fx-1,fy-4],[fx+1,fy-16-flutter],[fx+7,fy-6],[fx+4,fy+2]],'#ee713c');
        path(c,[[fx-2,fy],[fx+1,fy-8],[fx+3,fy]],'#ffe49e');
      }
    }
  }
  function treasure(c,x,y,kind,scale=1){
    c.save();c.translate(x,y);c.scale(scale,scale);
    if(kind==='gold'){
      // Rounded oak chest, brass bands and three clearly visible coins.
      path(c,[[-16,-2],[-16,10],[14,10],[18,6],[18,-5]],material(c,-16,-5,18,12,['#b48155','#77513f','#483744']),'#172638',1.6);
      c.beginPath();c.moveTo(-17,-3);c.bezierCurveTo(-18,-18,16,-18,18,-5);c.lineTo(18,0);c.lineTo(-17,0);c.closePath();c.fillStyle=material(c,-16,-13,18,1,['#d6a56b','#a7784d','#6a4a40']);c.strokeStyle='#172638';c.lineWidth=1.6;c.fill();c.stroke();
      for(const xx of [-10,9]){line(c,[[xx,-10],[xx,10]],'#e3c18a',3.1);line(c,[[xx-.5,-9],[xx-.5,9]],'#fff1ba',.7);}
      rounded(c,-3,-2,7,8,1.2,'#f1cd85','#6e624d');circle(c,.5,1.5,1.2,'#4b4845');
      for(const [cx,cy] of [[-11,12],[-1,14],[10,13]]){ellipse(c,cx,cy,5,2.3,'#99744d');ellipse(c,cx,cy-2,5,2.3,'#f3d18a');line(c,[[cx-2,cy-2],[cx+2,cy-2]],'#fff0b7',.8);}
    }else{
      path(c,[[-11,3],[0,-19],[12,2],[4,16],[-7,14]],material(c,-10,-18,13,14,['#e5fff0','#9bede4','#468ab4']),'#23435a',1.5);
      path(c,[[0,-19],[2,13],[12,2]],'#7ab8d7');
      path(c,[[0,-19],[-11,3],[2,13]],'#c2fff0');
      line(c,[[0,-16],[2,10]],'#f0fff7',1);
      path(c,[[-15,9],[-12,4],[-8,6],[-7,13]],'#d5b984','#39475c',1);
      path(c,[[9,7],[13,4],[16,9],[8,14]],'#d5b984','#39475c',1);
    }
    c.restore();
  }
  function relic(c,bonus,time,reducedMotion){
    if(!bonus||!finite(bonus.x)||!finite(bonus.y))return;
    const kind=bonus.kind,gold=kind==='gold',tint=gold?'#ffd28a':'#a5fff0';
    const pulse=reducedMotion?0:Math.sin(time*3)*.08,bob=reducedMotion?0:Math.sin(time*2.5)*3;
    c.save();c.translate(bonus.x,bonus.y);
    ellipse(c,4,13,36,13,'#0b1c2a75');
    c.save();c.globalAlpha=.55+pulse;
    const beam=material(c,0,-104,0,10,[gold?'#ffdc8b00':'#88eceb00',gold?'#ffd28a08':'#a5fff008',gold?'#ffd28a38':'#a5fff038']);
    path(c,[[-13,-104],[13,-104],[31,6],[-31,6]],beam);c.restore();
    glow(c,0,-8,58,gold?'#efb65a26':'#71efda25');
    c.beginPath();c.ellipse(0,9,43+pulse*14,21+pulse*7,0,0,Math.PI*2);c.strokeStyle=tint+'a0';c.lineWidth=1.6;c.stroke();
    c.save();c.setLineDash([4,9]);c.lineDashOffset=reducedMotion?0:-time*8;
    c.beginPath();c.ellipse(0,9,35,16,0,0,Math.PI*2);c.strokeStyle=tint+'77';c.lineWidth=1.2;c.stroke();c.restore();
    path(c,[[-25,5],[-15,-6],[16,-6],[26,5],[26,13],[16,20],[-15,20],[-25,13]],material(c,-25,-5,28,22,['#8b9f99','#607a86','#31475e']),'#162638',1.5);
    path(c,[[-25,5],[-15,-6],[16,-6],[26,5],[15,12],[-15,12]],'#82988e','#bed0b391',1);
    ellipse(c,0,4,19,8,'#284954');
    treasure(c,0,-13+bob,kind,1.22);
    // Large neutral reward badge remains recognizable on a narrow phone map.
    rounded(c,-25,-68+bob,50,28,8,'#142a38eb',tint+'a8');
    c.fillStyle=tint;c.textAlign='center';c.textBaseline='middle';c.font='800 23px system-ui,sans-serif';
    c.fillText(gold?'+40':'×2',0,-53+bob);
    for(let j=0;j<3;j++){
      const phase=reducedMotion?j*.33:(time*.35+j*.33)%1;
      const px=Math.sin(j*2.4)*26,py=3-phase*70;
      c.save();c.globalAlpha=(1-phase)*.75;path(c,[[px,py-2],[px+2,py],[px,py+2],[px-2,py]],tint);c.restore();
    }
    c.restore();
  }
  function castle(c, entity, state, time, reducedMotion) {
    const {x,y,team}=entity, tint=color(team), side=DARK[team]||DARK[0];
    c.save(); c.translate(x,y);
    ellipse(c,12,31,76,26,'#07131c45');
    ellipse(c,6,24,66,25,'#07131c99');
    ellipse(c,0,17,54,17,'#070d19a0');
    if(entity.alive===false||entity.hp<=0){
      ellipse(c,0,17,59,24,'#263c3e');
      for(let i=0;i<12;i++)rock(c,(rand(i+team*16)-.5)*89,rand(i+team*40)*28-5,9+rand(i+3)*10,i);
      line(c,[[-26,-3],[-11,-42]],'#708880',3);
      path(c,[[-11,-42],[7,-33],[-18,-24]],'#475b57');
      if(!reducedMotion)smoke(c,-5,0,time,team*.21,1.2);
      c.font='600 12px system-ui,sans-serif';c.textAlign='center';c.fillStyle='#a2b6ae';c.fillText('RUINS',0,51);
      c.restore();return;
    }
    if(state.targetTeam===team&&team!==0){
      c.setLineDash([8,7]);c.lineDashOffset=-time*7;
      c.beginPath();c.ellipse(0,10,76,39,0,0,Math.PI*2);c.strokeStyle=tint+'b0';c.lineWidth=2;c.stroke();c.setLineDash([]);
    }
    const outline='#17212e',attack=reducedMotion?0:clamp((entity.attackAnim||0)/.25,0,1);
    const wall=material(c,-65,-60,60,38,['#b9b6a6','#8b9492','#64747d','#374b60']);
    const shaded=material(c,-20,-50,55,20,['#71828a','#445a70','#293c53']);
    const trim=material(c,-60,-60,60,20,['#e3d7b8','#a4b0a5','#697d88']);
    const warm='#cbbf9d';
    // The fortress uses a single elevated, three-quarter perspective. Rear
    // walls, keep, front curtain and turrets are painted in depth order.
    path(c,[[-66,8],[-42,-20],[43,-20],[67,8],[67,29],[47,44],[-47,44],[-66,29]],shaded,outline,2);
    path(c,[[-66,8],[-42,-20],[43,-20],[67,8],[46,31],[-46,31]],trim,outline,1.6);
    path(c,[[-57,8],[-36,-13],[38,-13],[57,8],[40,26],[-40,26]],'#626e6d','#c8c3a080',1);
    line(c,[[-65,27],[-46,40],[46,40],[65,27]],'#b5b9a260',1);
    // Courtyard paving is visible behind the gatehouse.
    for(let row=0;row<3;row++)for(let col=0;col<5;col++){
      const bx=-31+col*14+(row%2)*5,by=-1+row*7;
      path(c,[[bx,by],[bx+12,by],[bx+8,by+5],[bx-4,by+5]],row%2?'#6d7977':'#77827c','#465a63',.6);
    }
    function stoneCourses(x0,y0,w,h,step=8){
      for(let row=0;row<h/step;row++){
        const yy=y0+row*step;
        line(c,[[x0,yy],[x0+w,yy]],'#243a4e70',.8);
        line(c,[[x0+.5,yy+1],[x0+w-.5,yy+1]],'#e2d9bc2a',.6);
        for(let xx=x0+((row%2)?5:12);xx<x0+w;xx+=14)line(c,[[xx,yy],[xx,yy+step]],'#2b40546b',.7);
      }
    }
    function archedWindow(wx,wy,scale=1){
      c.save();c.translate(wx,wy);c.scale(scale,scale);
      c.beginPath();c.moveTo(-3,7);c.lineTo(-3,-2);c.quadraticCurveTo(0,-7,3,-2);c.lineTo(3,7);c.closePath();c.fillStyle='#15283c';c.strokeStyle='#ccd1b4';c.lineWidth=1;c.fill();c.stroke();
      line(c,[[0,-2],[0,6]],'#edb76c',1);line(c,[[-2,2],[2,2]],'#677d83',.7);c.restore();
    }
    function banner(bx,by,len=21){
      const sway=reducedMotion?0:Math.sin(time*2.8+team+bx)*1.3;
      path(c,[[bx-5,by],[bx+5,by],[bx+5+sway,by+len-5],[bx+sway,by+len],[bx-5+sway,by+len-5]],material(c,bx-6,by,bx+7,by+len,[tint,side]),outline,1);
      line(c,[[bx-5,by],[bx+5,by]],'#e4cf99',1.7);
      sigil(c,bx,by+9,team,3);
    }
    function turret(tx,ty,r,h,rear=false){
      c.save();c.translate(tx,ty);
      ellipse(c,2,3,r+3,r*.43,'#15283d6b');
      const stone=material(c,-r,0,r,0,['#697b88','#bcbda8','#9ca89e','#52697e']);
      c.beginPath();c.moveTo(-r,-h);c.lineTo(-r,-2);c.quadraticCurveTo(-r,8,0,9);c.quadraticCurveTo(r,8,r,-2);c.lineTo(r,-h);c.closePath();c.fillStyle=stone;c.strokeStyle=outline;c.lineWidth=1.7;c.fill();c.stroke();
      for(let row=0;row<Math.floor(h/7);row++){
        const yy=-h+7+row*7;
        c.beginPath();c.moveTo(-r+.5,yy);c.quadraticCurveTo(0,yy+5,r-.5,yy);c.strokeStyle='#3f526b80';c.lineWidth=.8;c.stroke();
        const seam=row%2?-r*.35:r*.35;line(c,[[seam,yy+1],[seam,yy+8]],'#455c6d78',.7);
      }
      // Stepped corbels support a circular parapet with true depth.
      ellipse(c,0,-h+3,r+1.5,r*.43,'#596c79');
      ellipse(c,0,-h,r+3,r*.44,trim);
      ellipse(c,0,-h-1,r-.8,r*.32,'#394f63');
      for(let j=0;j<7;j++){
        const a=Math.PI+j*Math.PI/6,xx=Math.cos(a)*(r+1),yy=-h+Math.sin(a)*r*.34;
        path(c,[[xx-3,yy],[xx-3,yy-7],[xx+3,yy-7],[xx+3,yy]],trim,outline,.8);
        line(c,[[xx-2.5,yy-6.6],[xx+2.5,yy-6.6]],'#f4e2bc',.7);
      }
      path(c,[[-r-3,-h],[-r-3,-h+7],[-r*.5,-h+10],[r*.5,-h+10],[r+3,-h+7],[r+3,-h]],trim,outline,1);
      for(const xx of [-r+1,0,r-1]){
        path(c,[[xx-3,-h+7],[xx-3,-h-1],[xx+3,-h-1],[xx+3,-h+7]],stone,outline,.8);
        line(c,[[xx-2.5,-h],[xx+2.5,-h]],'#e7d8b7',1);
      }
      archedWindow(-r*.2,-h+21,rear?.65:.9);
      if(!rear)banner(1,-12,20);
      path(c,[[-r-1,1],[-r-1,6],[-r*.6,11],[r*.6,11],[r+1,6],[r+1,1]],shaded,outline,1);
      line(c,[[-r+1,2],[-r*.5,6],[r*.5,6],[r-1,2]],'#bec7b19c',1);
      c.restore();
    }
    // Rear curtain wall and two lower rear towers anchor the depth.
    path(c,[[-39,-20],[-39,-56],[39,-56],[39,-20]],shaded,outline,1.7);
    stoneCourses(-36,-53,72,28,7);
    for(let bx=-32;bx<39;bx+=12)path(c,[[bx,-54],[bx,-61],[bx+7,-61],[bx+7,-54]],trim,outline,1);
    turret(-38,-23,10,41,true);turret(38,-23,10,41,true);
    // Side curtains recede to the rear; their top surfaces catch warm light.
    path(c,[[-48,20],[-48,-17],[-38,-53],[-30,-48],[-34,15]],wall,outline,1.7);
    path(c,[[48,20],[48,-17],[38,-53],[30,-48],[34,15]],shaded,outline,1.7);
    line(c,[[-45,-17],[-36,-48]],warm,2);line(c,[[45,-17],[36,-48]],'#adbaa7',2);
    for(let i=0;i<4;i++){
      const yy=-21-i*8,xx=47-i*2.3;
      path(c,[[-xx-3,yy],[-xx-3,yy-7],[-xx+3,yy-8],[-xx+3,yy]],trim,outline,.8);
      path(c,[[xx-3,yy],[xx-3,yy-8],[xx+3,yy-7],[xx+3,yy]],trim,outline,.8);
    }
    // Tall central keep: facade, shaded return, cornice and slate hip roof.
    path(c,[[-24,-58],[17,-58],[29,-68],[29,-13],[17,-4],[-24,-4]],wall,outline,1.8);
    path(c,[[17,-58],[29,-68],[29,-13],[17,-4]],shaded,outline,1.1);
    stoneCourses(-22,-54,37,45,8);
    line(c,[[19,-52],[27,-58]],'#98aaa47a',.8);line(c,[[19,-40],[27,-46]],'#98aaa47a',.8);line(c,[[19,-28],[27,-34]],'#98aaa47a',.8);
    path(c,[[-27,-58],[17,-58],[32,-69],[32,-73],[17,-62],[-27,-62]],trim,outline,1.2);
    // Slate rows follow each roof plane instead of floating across faces.
    path(c,[[-29,-62],[-5,-91],[34,-72],[18,-60]],material(c,-20,-85,20,-60,['#687a87','#374c61','#20364e']),outline,1.8);
    path(c,[[-5,-91],[34,-72],[18,-60]],material(c,-5,-91,30,-58,['#7e8c90',side,'#2b3e54']),outline,1.3);
    for(let row=1;row<4;row++){
      const p=row/4;
      line(c,[[-5-24*p,-91+29*p],[-5+23*p,-91+31*p],[34-39*(1-p),-72-19*(1-p)]],'#b4c2b54d',1);
    }
    line(c,[[-28,-62],[18,-60],[33,-72]],'#c7cab7',1.3);
    // Three lancet windows and a heraldic shield identify the great hall.
    archedWindow(-12,-42,.95);archedWindow(6,-42,.95);archedWindow(23,-43,.65);
    banner(-3,-23,22);
    path(c,[[-8,-57],[-8,-48],[-3,-44],[2,-48],[2,-57]],side,outline,1);
    sigil(c,-3,-51,team,3.2);
    // Front curtain and its castellated walkway.
    path(c,[[-45,0],[-45,24],[45,24],[45,0],[35,-8],[-35,-8]],wall,outline,1.8);
    path(c,[[-45,0],[-35,-8],[35,-8],[45,0],[35,5],[-35,5]],trim,outline,1);
    stoneCourses(-43,7,86,18,7);
    for(let bx=-36;bx<43;bx+=12){
      path(c,[[bx,3],[bx,-6],[bx+7,-6],[bx+7,3]],wall,outline,1);
      line(c,[[bx+.7,-5.3],[bx+6.3,-5.3]],'#e3d6b7',.9);
    }
    // A substantial arched gate with individually cut wedge stones.
    c.save();c.translate(0,13);
    c.beginPath();c.moveTo(-14,15);c.lineTo(-14,-3);c.bezierCurveTo(-14,-24,14,-24,14,-3);c.lineTo(14,15);c.closePath();c.fillStyle=trim;c.strokeStyle=outline;c.lineWidth=1.5;c.fill();c.stroke();
    c.beginPath();c.moveTo(-10,15);c.lineTo(-10,-3);c.bezierCurveTo(-10,-18,10,-18,10,-3);c.lineTo(10,15);c.closePath();c.fillStyle='#15263a';c.fill();
    for(let j=0;j<7;j++){
      const a=Math.PI+j*Math.PI/6;
      line(c,[[Math.cos(a)*10,-3+Math.sin(a)*13],[Math.cos(a)*14,-3+Math.sin(a)*18]],'#586a77',.8);
    }
    for(let gx=-7;gx<=8;gx+=3.5)line(c,[[gx,-6],[gx,14]],'#aa9271',1.2);
    line(c,[[-9,0],[9,0]],'#c5b083',1.4);line(c,[[-9,9],[9,9]],'#c5b083',1.4);
    circle(c,-3,6,1.3,'#e0cb96');circle(c,3,6,1.3,'#e0cb96');c.restore();
    path(c,[[-13,28],[13,28],[23,45],[-23,45]],material(c,-20,28,20,45,['#b5ae95','#687b7d','#445a6b']),outline,1.2);
    for(let sy=31;sy<=43;sy+=3)line(c,[[-13-(sy-28)*.55,sy],[13+(sy-28)*.55,sy]],'#3e5366',.9);
    // Hand-cut stone seams, moss and metal fittings add scale without noise.
    path(c,[[-57,19],[-48,23],[-44,31],[-52,31],[-58,26]],'#5b78625c');
    path(c,[[42,29],[47,23],[56,20],[54,29]],'#7e95654a');
    line(c,[[-37,27],[-34,31],[-40,35]],'#2c41576b',1);
    line(c,[[34,28],[30,33],[34,35]],'#d1c6a738',1);
    for(const side of [-1,1]){
      path(c,[[side*29,4],[side*29,20],[side*33,23],[side*34,5]],'#4b65736b');
      circle(c,side*31,8,1,'#d7c69a');circle(c,side*31,18,1,'#d7c69a');
    }
    // The front turrets complete the battlement silhouette, hiding wall seams.
    turret(-47,15,13,52);turret(47,15,13,52);
    torch(c,-22,10,time+team,.65);torch(c,22,10,time+team+1,.65);
    // Long, light cloth rather than a rigid triangular pennant.
    line(c,[[-5,-89],[-5,-101]],'#bdb79b',1.4);circle(c,-5,-101,1.8,'#ead6a2');
    const wave=reducedMotion?0:Math.sin(time*2.6+team)*2.3;
    c.beginPath();c.moveTo(-4,-100);c.bezierCurveTo(5,-103+wave,12,-96-wave,22,-99+wave);c.lineTo(18,-90+wave);c.bezierCurveTo(9,-88-wave,3,-96+wave,-4,-92);c.closePath();c.fillStyle=material(c,-4,-100,23,-90,[tint,side]);c.strokeStyle=outline;c.lineWidth=.8;c.fill();c.stroke();
    line(c,[[3,-98],[4,-93]],'#f3dfb0',1.4);
    if(attack>0){glow(c,-3,-49,20*attack,tint+'60');circle(c,-3,-49,3*attack,'#fff1c9');}
    if(entity.hp/entity.maxHp<.55){
      line(c,[[21,-22],[18,-12],[24,-4],[18,4]],'#253346',1.8);
      line(c,[[-47,-21],[-51,-12],[-46,-5]],'#344054',1.5);
      if(!reducedMotion)smoke(c,23,-33,time,team*.31,1.2);
    }
    if(entity.hp/entity.maxHp<.25){torch(c,23,-31,time+3,.75);if(!reducedMotion)smoke(c,-37,-24,time,team*.2+.3,1.1);}
    if((entity.hitFlash||0)>0){c.save();c.globalAlpha=Math.min(.22,entity.hitFlash*1.6);glow(c,0,-22,65,'#fff5ca');c.restore();}
    statusAura(c,entity,time,reducedMotion,67,-14);
    if((entity.aetherBoostTime||0)>0){
      c.save();
      c.beginPath();c.ellipse(0,19,72,30,0,0,Math.PI*2);c.strokeStyle='#9cf7e678';c.lineWidth=1.4;c.stroke();
      for(let j=0;j<4;j++){
        const a=j*Math.PI/2+(reducedMotion?0:time*.4),px=Math.cos(a)*70,py=19+Math.sin(a)*29;
        path(c,[[px,py-4],[px+3,py],[px,py+4],[px-3,py]],'#baffeb');
      }
      rounded(c,55,-65,36,21,7,'#173b47e8','#b8ffdf');
      c.textAlign='center';c.fillStyle='#c3ffe7';c.font='800 15px system-ui,sans-serif';c.fillText('×2',73,-49);
      c.restore();
    }
    healthBar(c,0,55,100,entity.hp/entity.maxHp,tint,6);
    c.font='600 13px system-ui,sans-serif';c.textAlign='center';c.fillStyle='#e3edda';
    c.fillText(Math.max(0,Math.ceil(entity.hp))+' / '+entity.maxHp,0,78);
    // Owner labels are part of the world and remain attached on rotation.
    c.font='700 11px system-ui,sans-serif';c.fillStyle=tint;c.fillText((entity.name||(team===0?'Your citadel':'Enemy citadel')).toLocaleUpperCase('en'),0,team===1?97:-126);
    c.restore();
  }

  function runnerRoute(c,u,home,time,reducedMotion){
    if(!u||!home)return;
    const returning=Boolean(u.carrying),target=returning?home:{x:500,y:350};
    const dx=target.x-u.x,dy=target.y-u.y,dist=Math.hypot(dx,dy);
    if(dist<8)return;
    c.save();c.setLineDash([8,8]);c.lineDashOffset=reducedMotion?0:-time*16;
    line(c,[[u.x,u.y],[target.x,target.y]],returning?'#ffe1a599':'#a6f4eaa6',2.8);c.setLineDash([]);
    const angle=Math.atan2(dy,dx);
    for(const portion of [.42,.75]){
      if(dist*portion<28)continue;
      c.save();c.translate(u.x+dx*portion,u.y+dy*portion);c.rotate(angle);
      path(c,[[-6,-5],[1,0],[-6,5],[3,0]],returning?'#ffe7b4':'#c8fff1','#203b4b',.8);c.restore();
    }
    c.restore();
  }
  function runnerMarker(c,u,state,time,reducedMotion,spriteScale,markerScale){
    if(!u||u.hp<=0)return;
    const tint=color(u.team),friendly=u.team===0,collecting=u.task==='collecting';
    const carrying=u.carrying==='aether'||u.carrying==='gold';
    const reward=u.carrying==='gold'?'+40':'×2';
    c.save();c.translate(u.x,u.y);
    // Tactical ring and pointer stay above buildings and crowds. They identify
    // the living courier without changing its position or combat footprint.
    c.beginPath();c.ellipse(0,8*spriteScale,22*spriteScale,11*spriteScale,0,0,Math.PI*2);c.strokeStyle='#0b2032e0';c.lineWidth=5;c.stroke();
    c.strokeStyle=tint;c.lineWidth=2.5;c.stroke();
    const home=(state.castles||[]).find(castle=>castle.team===u.team);
    const target=carrying&&home?home:{x:500,y:350};
    const angle=Math.atan2(target.y-u.y,target.x-u.x);
    c.save();c.translate(Math.cos(angle)*27*spriteScale,8*spriteScale+Math.sin(angle)*16*spriteScale);c.rotate(angle);
    path(c,[[-5,-5],[5,0],[-5,5],[-2,0]],tint,'#162b3f',1);c.restore();
    if(collecting){
      const progress=clamp(1-(u.pickupTime||0)/.65,0,1);
      c.beginPath();c.arc(0,-9*spriteScale,24*spriteScale,-Math.PI/2,-Math.PI/2+Math.PI*2*progress);c.strokeStyle='#ffe0a4';c.lineWidth=2.5;c.stroke();
    }
    const badgeScale=friendly?markerScale:markerScale*.77;
    const label=friendly?(collecting?'PICK UP':carrying?'RETURN':'OUT'):(collecting?'…':carrying?reward:'↗');
    const hasReward=friendly&&carrying&&!collecting;
    const badgeWidth=hasReward?77:label==='PICK UP'?60:label==='RETURN'?64:friendly?45:31;
    const badgeBottom=-33*spriteScale-10;
    c.save();c.translate(0,badgeBottom-19*badgeScale);c.scale(badgeScale,badgeScale);
    rounded(c,-badgeWidth/2,0,badgeWidth,19,6,'#102b3eec',carrying?'#f4d394':tint);
    c.textAlign='center';c.textBaseline='middle';c.fillStyle='#f0fff2';c.font='800 11.5px system-ui,sans-serif';
    c.fillText(label,hasReward?-12:0,10);
    if(hasReward){line(c,[[16,4],[16,15]],'#b6c9b34a',1);c.font='800 12px system-ui,sans-serif';c.fillStyle=u.carrying==='gold'?'#ffdda3':'#a6ffed';c.fillText(reward,28,10);}
    c.restore();
    if(u.hp<u.maxHp)healthBar(c,0,badgeBottom+4,30*spriteScale,u.hp/u.maxHp,tint,3.5);
    c.restore();
  }
  function unit(c,u,time,reducedMotion,runnerScale=1){
    if(!finite(u.x)||!finite(u.y))return;
    const tint=color(u.team), dark=DARK[u.team]||DARK[0], id=u.cardId||u.kind||'sentinel';
    const isGolem=id==='golem', size=isGolem?21:14;
    c.save();c.translate(u.x,u.y);
    if(id==='runner')c.scale(runnerScale,runnerScale);
    const phase=String(u.id||'').split('').reduce((n,s)=>n+s.charCodeAt(0),0)*.37;
    const gaitSpeed=isGolem?6:id==='runner'?14:id==='swarm'?15:id==='archer'?9:id==='frostwarden'?8:10;
    const moving=Boolean(u.moving),cycle=reducedMotion?0:time*gaitSpeed+phase;
    const stride=moving&&!reducedMotion?Math.sin(cycle):0;
    const breath=reducedMotion?0:Math.sin(time*2.4+phase)*.45;
    const bounce=moving&&!reducedMotion?(1-Math.cos(cycle*2))*.5*(isGolem?1.4:2.2):breath;
    const attack=reducedMotion?0:clamp((u.attackAnim||0)/.25,0,1);
    const swing=reducedMotion?0:attackPose(u.attackAnim||0),facing=finite(u.facing)?u.facing:-Math.PI/2;
    const faceDirection=Math.cos(facing)<-.12?-1:1,localFacing=faceDirection<0?Math.PI-facing:facing;
    const ink='#0d1b2b';
    ellipse(c,6,10,size*1.12,size*.46,'#0715223b');
    ellipse(c,2,7,size*.9,size*.44,'#071522a6');
    c.beginPath();c.ellipse(0,6,size,size*.55,0,0,Math.PI*2);c.strokeStyle=tint+'9c';c.lineWidth=2;c.stroke();
    // Contact marks and an alternating heel/toe cadence ground the characters.
    if(moving&&!reducedMotion&&id!=='swarm'){
      const heel=Math.max(0,Math.cos(cycle));
      ellipse(c,-7,16+stride*2,3.5+heel,1.4,'#c3c5a220');
      ellipse(c,8,16-stride*2,3.5+(1-heel),1.4,'#c3c5a220');
    }
    c.translate(Math.cos(facing)*swing*3,-bounce+Math.sin(facing)*swing*2);
    const steel=material(c,-14,-25,18,15,['#d4d5bd','#7c96a6','#354a64']);
    const cloth=material(c,-13,-18,15,16,[tint,dark,'#1b2b40']);
    c.save();c.scale(faceDirection,1);
    if(moving&&!reducedMotion)c.rotate(stride*(isGolem?.016:id==='swarm'?.025:.035));
    if(id==='runner'){
      const carrying=u.carrying==='aether'||u.carrying==='gold';
      const collecting=u.task==='collecting',pickupProgress=clamp(1-(u.pickupTime||0)/.65,0,1);
      const leather=material(c,3,-18,21,12,['#d2ae79','#9b7653','#59464b']);
      // Compact courier silhouette: big hood, bright eyes, heavy leather pack.
      c.save();c.translate(0,collecting?3:0);c.rotate(collecting?.14:carrying?-.07:stride*.025);
      path(c,[[-11,19],[-13,7],[-16,1],[-11,-12],[-12,-24],[-3,-32],[6,-30],[13,-22],[13,-17],[21,-15],[23,-7],[22,11],[14,14],[14,20],[5,21],[0,14],[-4,21]],'#14283ac9',tint+'d9',2.6);
      rounded(c,5,-14-(carrying?1:0),16,23,5,leather,ink);
      rounded(c,8,-16-(carrying?1:0),10,8,3,'#c2a074','#68534c');
      line(c,[[9,-11],[9,7]],'#e0c292',2);line(c,[[16,-11],[16,7]],'#75584a',2);
      rounded(c,9,-5,8,7,2,'#a77c53','#5a4a48');circle(c,13,-2,1.2,'#f2d591');
      line(c,[[7,-9],[7,5]],'#5a4b496b',.6);line(c,[[19,-9],[19,5]],'#f3d4a16b',.7);
      for(const sy of [-8,-4,0,4])line(c,[[6,sy],[8,sy]],'#e0ba8b',.6);
      path(c,[[-7,-9],[-12-stride*.5,8],[-3,13],[7,9],[8,-8]],material(c,-11,-10,11,15,['#79738b','#51475f','#2c304a']),ink,1.8);
      line(c,[[-3,7],[-7,17+stride*3.6]],ink,6);line(c,[[5,7],[9,17-stride*3.6]],ink,6);
      line(c,[[-3,7],[-6,14+stride*3.6]],'#a38c75',3.5);line(c,[[5,7],[8,14-stride*3.6]],'#a38c75',3.5);
      rounded(c,-10,14+stride*3.6,8,5,2,'#5d4850',ink);rounded(c,5,14-stride*3.6,8,5,2,'#5d4850',ink);
      // Empty hands swing or grip the pack straps: the runner carries no weapon.
      const arm=collecting?6:carrying?0:stride*4;
      line(c,[[-7,-6],[-12,2+arm],[-9,5+arm]],ink,5);
      line(c,[[-7,-6],[-12,2+arm]],'#88758a',3);
      circle(c,-9,5+arm,2.4,'#d5b59a',ink,.7);
      line(c,[[7,-6],[10,1-arm],[8,4-arm]],ink,5);
      line(c,[[7,-6],[10,1-arm]],'#88758a',3);circle(c,8,4-arm,2.4,'#d5b59a',ink,.7);
      path(c,[[-8,-8],[-5,-1],[6,-2],[9,-9],[2,-12]],cloth,ink,1.1);
      path(c,[[-6,-5],[-12,2],[-16,1],[-10,-7]],tint,ink,.7);
      // Oversized soft hood, rather than armor, keeps the small person readable.
      path(c,[[-11,-14],[-10,-24],[-3,-31],[6,-28],[11,-21],[10,-12],[5,-8],[-6,-9]],material(c,-11,-29,12,-6,['#a18ba1','#65536f','#34354e']),ink,1.8);
      path(c,[[-7,-20],[-1,-25],[6,-21],[7,-14],[2,-10],[-5,-13]],'#d6b39b',ink,1.1);
      path(c,[[-8,-19],[-3,-25],[6,-22],[7,-18],[-1,-21]],'#4b3748');
      ellipse(c,-3,-16,2,2.5,'#f6e7bf');ellipse(c,3.5,-16,2,2.5,'#f6e7bf');
      circle(c,-2.5+Math.cos(localFacing)*.4,-16,1,'#2f3042');circle(c,4+Math.cos(localFacing)*.4,-16,1,'#2f3042');
      ellipse(c,-5,-12.6,1.8,.8,'#b97e7977');ellipse(c,5,-12.2,1.6,.8,'#b97e7977');
      line(c,[[-1,-12],[2,-12]],'#84585a',.8);
      line(c,[[-10,-19],[-7,-25],[-3,-28]],'#cab2b58a',1);
      if(carrying){
        const lift=reducedMotion?0:Math.sin(time*4+phase)*1.5;
        const rewardTint=u.carrying==='gold'?'#ffda94':'#b2fff0';
        const pickLift=collecting?(1-pickupProgress)*15:0;
        glow(c,12,-15,22,rewardTint+'36');treasure(c,12,-14+lift+pickLift,u.carrying,.56);
      }
      c.restore();
    }else if(id==='embermage'||id==='tidecaller'){
      const fire=id==='embermage',energy=fire?'#ffba68':'#8feee5';
      const robe=material(c,-14,-22,13,17,fire?['#be745f','#8b3e4b','#45273f']:['#87c6bf','#36858f','#2b4c6e']);
      const cape=material(c,-16,-10,15,19,fire?['#7c394b','#3b2841']:['#396f86','#243c5d']);
      path(c,[[-9,-12],[-17-stride*1.1,14],[-5,21],[8,16],[14,-8]],cape,ink,1.9);
      path(c,[[-7,-12],[-11,14],[-3,18],[1,9],[5,18],[13,12],[7,-11]],robe,ink,1.7);
      line(c,[[-7,6],[-10,15]],'#d3b185',1.2);line(c,[[7,5],[10,13]],'#d3b185',1.2);
      line(c,[[-7,1],[8,1]],'#bba583',2);circle(c,1,1,2.3,tint,ink,1);
      circle(c,0,-17,8.5,fire?'#c9977d':'#9ec9c3',ink,1.7);
      if(fire){
        path(c,[[-9,-15],[-10,-24],[-3,-32],[4,-30],[10,-22],[10,-13],[4,-14],[5,-23],[0,-25],[-5,-21],[-5,-13]],robe,ink,1.6);
        path(c,[[-8,-25],[-12,-29],[-8,-31],[-3,-29]],'#d3b58a',ink,.8);
        path(c,[[6,-27],[12,-31],[12,-24],[9,-21]],'#d3b58a',ink,.8);
        line(c,[[-4,-17],[-1,-17]],'#ffe6a7',1.5);line(c,[[3,-17],[6,-17]],'#ffe6a7',1.5);
        line(c,[[-5,-20],[-1,-19]],'#6d3f45',1);line(c,[[3,-19],[6,-21]],'#6d3f45',1);
        path(c,[[-1,-16],[1,-12],[3,-13]],'#9b655e');
        path(c,[[-4,-10],[-1,-12],[2,-10],[6,-11],[3,-6],[-1,-5]],'#d5bc99',ink,.6);
        line(c,[[-4,-5],[-2,7],[-5,13]],'#e3b77f',1);line(c,[[5,-4],[8,10]],'#e3b77f',1);
      }else{
        path(c,[[-8,-16],[-7,-26],[0,-30],[8,-25],[11,-10],[7,-2],[4,-12],[5,-22],[-1,-24],[-5,-13],[-7,-3],[-11,-7]],material(c,-10,-26,11,0,['#d0e7dc','#82c8c7','#4d8aab']),ink,1.5);
        path(c,[[-8,-25],[-6,-31],[-1,-27],[2,-34],[5,-27],[10,-30],[9,-23]],'#9dc9ca',ink,1.2);
        circle(c,1,-27,2.5,'#7af3eb',ink,.8);line(c,[[-4,-17],[-1,-17]],'#163b55',1.3);line(c,[[3,-17],[6,-17]],'#163b55',1.3);
        circle(c,-7,-11,1.7,'#eff5d7',ink,.6);circle(c,8,-12,1.7,'#eff5d7',ink,.6);
        line(c,[[-2,-10],[2,-9],[4,-10]],'#437c84',.9);
        line(c,[[-6,-23],[-8,-13],[-7,-6]],'#e1f4db9c',.9);line(c,[[6,-25],[8,-16],[7,-7]],'#e1f4db9c',.9);
        for(let row=0;row<3;row++)for(let col=0;col<2;col++){const sx=-4+col*6,sy=3+row*4;line(c,[[sx-2,sy],[sx,sy+2],[sx+2,sy]],'#b6e0cf88',.65);}
      }
      // Staff arm turns into the cast and the raised hand holds a live element.
      c.save();c.translate(13,-5);c.rotate(-swing*.28);
      line(c,[[0,15],[0,-27]],ink,5);line(c,[[0,15],[0,-27]],fire?'#b99876':'#9fb8b9',2.5);
      if(fire){
        path(c,[[-6,-27],[-5,-35],[0,-30],[5,-35],[6,-27],[0,-23]],'#d5aa76',ink,1.2);
        const flame=reducedMotion?0:Math.sin(time*12+phase)*2;
        glow(c,0,-33,13,'#ffab4b55');
        path(c,[[-4,-29],[-6,-35],[-1,-33],[1,-45-flame],[6,-34],[3,-28]],'#f18c49');
        path(c,[[-2,-29],[1,-39],[4,-30]],'#fff0ac');
      }else{
        line(c,[[-6,-35],[-6,-27],[0,-22],[6,-27],[6,-35]],'#ccdfd1',2.3);
        line(c,[[0,-24],[0,-38]],'#d8e8da',2.3);
        path(c,[[-3,-36],[0,-42],[3,-36]],energy);glow(c,0,-31,11,'#82e8e335');
      }
      c.restore();
      const orbX=-12-swing*4,orbY=-9-swing*5;
      line(c,[[-7,-7],[orbX,orbY]],fire?'#bd7e6a':'#81bab7',4);
      glow(c,orbX,orbY,11,fire?'#ffb95e3c':'#75f7e83c');
      circle(c,orbX,orbY,4+swing*2,material(c,orbX-4,orbY-4,orbX+4,orbY+4,fire?['#fff0bb','#ffb45d','#e36648']:['#e2ffff','#82e7df','#389db4']),ink,.7);
      if(attack>.05){
        for(let j=0;j<3;j++){const a=j*2.094+time*3,rr=7+Math.max(0,swing)*5;circle(c,orbX+Math.cos(a)*rr,orbY+Math.sin(a)*rr*.7,1.2,energy);}
      }
      if(!fire){
        c.beginPath();c.ellipse(0,13,17,5,-.1,time*.7,time*.7+Math.PI*1.4);c.strokeStyle='#b4fff68a';c.lineWidth=1.3;c.stroke();
      }
    }else if(id==='frostwarden'){
      const frostMetal=material(c,-19,-30,22,17,['#d1e4e9','#87accc','#466389']);
      path(c,[[-10,-9],[-15-stride,13],[-1,19],[13,11],[9,-10]],'#405c88',ink,2);
      line(c,[[-5,7],[-8,17+stride*2.5]],ink,7);line(c,[[5,7],[8,17-stride*2.5]],ink,7);
      line(c,[[-5,7],[-8,15+stride*2.5]],frostMetal,4);line(c,[[5,7],[8,15-stride*2.5]],frostMetal,4);
      path(c,[[-11,-11],[-13,5],[0,12],[12,5],[11,-11]],frostMetal,ink,2);
      path(c,[[-6,-10],[0,-16],[6,-10],[4,5],[0,8],[-4,5]],'#9ddaf0',ink,1);
      line(c,[[-6,4],[6,4]],'#3e6895',2);
      path(c,[[-10,-14],[-8,-25],[-3,-29],[2,-27],[8,-26],[11,-15],[6,-10],[-5,-10]],frostMetal,ink,1.8);
      path(c,[[-8,-24],[-10,-32],[-4,-27],[-1,-35],[3,-27],[9,-31],[8,-23]],'#b4e3f0',ink,1.2);
      line(c,[[-7,-17],[7,-17]],'#1c3b61',3);line(c,[[-5,-17],[-1,-17]],'#d6ffff',1.3);line(c,[[2,-17],[6,-17]],'#d6ffff',1.3);
      path(c,[[-13,-12],[-18,-18],[-18,-8],[-11,-4]],'#b8ddeb',ink,1.2);
      path(c,[[13,-12],[18,-18],[19,-8],[11,-4]],'#90bddb',ink,1.2);
      line(c,[[-8,-10],[-4,-5],[-7,-1]],'#efffff',1);line(c,[[7,-10],[9,-4],[6,1]],'#d7f2ff',.8);
      line(c,[[-3,-25],[0,-19],[4,-24]],'#f0ffff',1);
      // Broad frozen shield and a long crystal spear.
      path(c,[[-23,-13],[-12,-18],[-5,-11],[-8,8],[-17,17],[-25,5]],frostMetal,ink,1.8);
      path(c,[[-19,-10],[-14,-12],[-11,-8],[-12,5],[-17,11],[-21,4]],'#567fa3',ink,.8);
      snowflake(c,-16,-2,5.5,'#d8f7ff');
      c.save();c.translate(14+Math.max(0,swing)*4,-2-Math.max(0,swing)*3);c.rotate(-.3+swing*.9);
      line(c,[[0,19],[0,-26]],ink,4);line(c,[[0,19],[0,-26]],'#9fc3d0',2);
      path(c,[[-5,-26],[0,-40],[5,-26],[0,-19]],'#a9e8ff',ink,1.2);
      path(c,[[0,-40],[5,-26],[0,-19]],'#6aafd4');line(c,[[0,-37],[0,-23]],'#ecffff',1);
      c.restore();
      if(swing>.1){c.save();c.globalAlpha=swing*.5;snowflake(c,Math.cos(localFacing)*26,Math.sin(localFacing)*26,10,'#c7f7ff');c.restore();}
      circle(c,0,1,2,tint,ink,.7);
    }else if(id==='golem'){
      const stone=material(c,-24,-28,28,17,['#a5b4a1','#68868b','#354c66']);
      // Segmented legs and armored feet stomp independently.
      path(c,[[-12,2],[-15,11+stride*3],[-17,18+stride*3],[-3,20+stride*3],[2,8]],stone,ink,2.5);
      path(c,[[5,2],[5,16-stride*3],[20,18-stride*3],[18,10-stride*3],[15,0]],stone,ink,2.5);
      line(c,[[-14,14+stride*3],[-3,16+stride*3]],'#c5c7ad',1.5);
      line(c,[[7,14-stride*3],[18,14-stride*3]],'#b5c4b4',1.5);
      path(c,[[-15,1],[-20,-13],[-12,-29],[2,-34],[17,-25],[21,-6],[12,8],[-2,10]],stone,ink,3);
      path(c,[[2,-34],[17,-25],[21,-6],[12,8],[1,3],[6,-14]],'#405e76');
      path(c,[[-12,-29],[2,-34],[14,-26],[1,-20]],'#c3c7ac',ink,1.2);
      path(c,[[-19,-17],[-30,-10+stride*2],[-28,8+stride*2],[-17,12],[-12,-4]],stone,ink,2.5);
      c.save();c.translate(16,-8);c.rotate(-swing*1.2);
      path(c,[[-1,-9],[11,-3],[15,11],[9,19],[-3,15],[-6,1]],stone,ink,2.5);
      line(c,[[0,6],[10,8]],'#bad0bc',1.5);c.restore();
      line(c,[[-9,-21],[-4,-11],[-9,-1],[0,4],[5,-7],[11,-10]],tint,2.4);
      line(c,[[-27,-7],[-21,-3],[-25,5]],tint+'b0',1.5);
      path(c,[[-10,-22],[-2,-19],[-3,-15],[-10,-17]],'#0d2839');
      path(c,[[3,-19],[10,-23],[10,-17],[4,-15]],'#0d2839');
      line(c,[[-9,-19],[-4,-17]],tint,2);line(c,[[4,-17],[9,-20]],tint,2);
      path(c,[[-5,-9],[1,-15],[7,-8],[1,1]],tint,ink,1.5);
      path(c,[[-5,-9],[1,-15],[1,1]],'#c2ffe8');
      for(const [rx,ry] of [[-25,-8],[18,-24],[-9,-29]])crystal(c,rx,ry,5,tint);
      // Coral antlers and barnacle rosettes distinguish living reef from armor.
      coral(c,-10,-27,9,'#b69194');coral(c,15,-23,7,'#8eb6b0');
      for(const [bx,by,br] of [[-23,-6,2.3],[-18,-9,1.8],[15,2,2.5],[-8,5,2]]){
        circle(c,bx,by,br,'#adbbb0','#455f70',.7);circle(c,bx,by,br*.42,'#344f65');
      }
      path(c,[[-5,-13],[0,-11],[6,-14],[4,-9],[-2,-8]],'#234357');
      line(c,[[-2,-10],[3,-11]],'#b6f7d9',.8);
      line(c,[[-14,-24],[-17,-16],[-12,-5]],'#bed5b55c',1);
      if(swing>.2){c.save();c.globalAlpha=swing*.45;circle(c,Math.cos(localFacing)*28,Math.sin(localFacing)*28,10+swing*14,null,tint,3);c.restore();}
    }else if(id==='swarm'){
      c.lineCap='round';
      for(const s of [-1,1])for(let j=0;j<3;j++){
        const step=moving?Math.sin(cycle+j*1.7+s)*3:0;
        line(c,[[s*5,0],[s*(13+j),-3+j*5+step],[s*(17+j),2+j*5-step]],ink,5);
        line(c,[[s*5,0],[s*(13+j),-3+j*5+step],[s*(17+j),2+j*5-step]],'#bb9275',2.6);
      }
      ellipse(c,0,-1,13,9,material(c,-9,-10,9,8,['#f0b18a','#b96d65','#664253']));
      c.beginPath();c.ellipse(0,-1,13,9,0,0,Math.PI*2);c.strokeStyle=ink;c.lineWidth=2;c.stroke();
      path(c,[[-9,-5],[-6,-11],[0,-13],[7,-10],[11,-4],[4,1],[-5,0]],cloth,ink,1.5);
      path(c,[[-5,-8],[0,-11],[5,-8],[1,-4]],tint);
      path(c,[[-12,-2],[-17,-5],[-13,-8],[-10,-7]],'#cf9f79',ink,.8);
      path(c,[[12,-2],[17,-5],[13,-8],[10,-7]],'#cf9f79',ink,.8);
      for(const [sx,sy] of [[-7,2],[7,2],[-3,5],[4,5]])circle(c,sx,sy,1,'#f3c798');
      for(const s of [-1,1]){
        c.save();c.translate(s*7,-4);c.rotate(s*(swing*.6+(moving?stride*.08:0)));
        line(c,[[0,0],[s*8,-8]],ink,6);line(c,[[0,0],[s*8,-8]],'#d99b79',3.5);
        path(c,[[s*4,-9],[s*6,-18],[s*12,-15],[s*10,-7],[s*16,-10],[s*14,-2]],material(c,-16,-20,16,0,['#f3c395','#c17c6b','#754655']),ink,1.8);
        c.restore();
        line(c,[[s*4,-6],[s*5,-12]],ink,3);
        circle(c,s*5,-13,3.3,'#fff1c0',ink,1);circle(c,s*5+Math.cos(localFacing)*.8,-13,1.4,'#142139');circle(c,s*5-.4,-14,.65,'#ffffff');
      }
      line(c,[[-3,-3],[0,-1],[3,-3]],ink,1.2);
    }else if(id==='archer'){
      // A streaming cape, leather boots, quiver and polished shoulder armor.
      path(c,[[-9,-8],[-14-stride,12],[-2,17],[7,11],[6,-6]],cloth,ink,2);
      line(c,[[-4,6],[-7,16+stride*3]],ink,6);line(c,[[4,6],[7,16-stride*3]],ink,6);
      line(c,[[-4,7],[-7,14+stride*3]],'#897c69',3.5);line(c,[[4,7],[7,14-stride*3]],'#897c69',3.5);
      path(c,[[-9,-7],[5,-10],[8,6],[-1,11],[-9,6]],material(c,-8,-8,10,10,['#b2a081','#695e54','#39424d']),ink,2);
      line(c,[[-8,-4],[6,6]],'#cbb896',2.5);
      path(c,[[-11,-8],[-16,-16],[-12,-19],[-6,-8]],'#8b725c',ink,1.5);
      line(c,[[-13,-13],[-17,-27]],'#e1c6a1',1);line(c,[[-10,-15],[-12,-29]],'#e1c6a1',1);
      circle(c,0,-13,9,'#cbb29a',ink,2);
      path(c,[[-9,-13],[-8,-22],[0,-27],[9,-20],[9,-11],[4,-9],[3,-18],[-1,-21],[-6,-14]],cloth,ink,2);
      path(c,[[-7,-11],[-3,-6],[5,-7],[7,-12],[2,-11]],'#5c4d4d');
      path(c,[[-5,-17],[-3,-20],[3,-20],[6,-16],[5,-10],[-1,-8],[-5,-11]],'#d9b99a');
      line(c,[[-5,-17],[-2,-18]],'#67514e',1);line(c,[[2,-18],[5,-17]],'#67514e',1);
      ellipse(c,-3,-15,1.5,1.2,'#eef3d8');ellipse(c,3.5,-15,1.5,1.2,'#eef3d8');
      circle(c,-2.5,-15,.65,'#314757');circle(c,4,-15,.65,'#314757');
      line(c,[[-1,-10],[2,-10]],'#a06b65',.8);
      path(c,[[-7,-15],[-5,-10],[-8,-6],[-10,-7]],'#927055',ink,.7);
      line(c,[[-7,-22],[-2,-25],[5,-21]],'#a4d3b27a',1);
      for(const sy of [-4,0,4])line(c,[[-5,sy],[-2,sy+2]],'#d3b894',.7);
      ellipse(c,-8,-5,5,4,steel);
      c.save();c.translate(10,-3);c.rotate(-swing*.12);
      c.beginPath();c.moveTo(6,-16);c.quadraticCurveTo(22+attack*5,0,6,16);c.strokeStyle=ink;c.lineWidth=5;c.stroke();
      c.strokeStyle='#cbae76';c.lineWidth=2.6;c.stroke();
      line(c,[[6,-16],[2-attack*8,0],[6,16]],'#eeecd2',1.2);
      line(c,[[-8,1],[2-attack*8,0]],'#c6b59a',4);
      if(attack<.6){line(c,[[1-attack*8,0],[21-attack*8,0]],'#d8c9a3',1.6);path(c,[[24-attack*8,0],[18-attack*8,-3],[18-attack*8,3]],'#e7f0db');}
      circle(c,3-attack*8,0,2.2,'#d6b89b',ink,.6);
      c.restore();
    }else{
      path(c,[[-8,-9],[-14-stride,11],[-1,16],[10,9],[7,-9]],cloth,ink,2);
      line(c,[[-4,5],[-7,16+stride*3]],ink,7);line(c,[[5,5],[8,16-stride*3]],ink,7);
      line(c,[[-4,5],[-7,14+stride*3]],steel,4);line(c,[[5,5],[8,14-stride*3]],steel,4);
      path(c,[[-9,-10],[-11,4],[0,11],[10,4],[8,-10]],steel,ink,2.2);
      path(c,[[-4,-10],[-5,6],[0,10],[5,6],[4,-10]],cloth,ink,1);
      line(c,[[-8,3],[8,3]],'#b6a27c',2.4);
      circle(c,0,3,2,'#e4d6a8');
      circle(c,0,-15,9,steel,ink,2);
      path(c,[[-9,-16],[-8,-24],[0,-29],[8,-24],[9,-16],[4,-12],[-3,-12]],steel,ink,2);
      path(c,[[-2,-29],[1,-33],[4,-29],[4,-19],[0,-17]],cloth,ink,1.2);
      line(c,[[-6,-16],[6,-16]],ink,3.3);line(c,[[-4,-16],[-1,-16]],tint,1.3);line(c,[[2,-16],[5,-16]],tint,1.3);
      path(c,[[-3,-12],[0,-8],[4,-12]],'#3c5268');
      ellipse(c,-10,-8,5,4,steel);ellipse(c,9,-8,5,4,steel);
      line(c,[[-13,-9],[-7,-10]],'#e6e8cd',1.2);line(c,[[6,-10],[12,-9]],'#d8e3d0',1);
      line(c,[[-7,-1],[-5,2]],'#eff0d7',.9);line(c,[[6,-1],[5,2]],'#a5bcb2',.9);
      path(c,[[-6,-25],[-2,-28],[5,-25],[3,-22],[-3,-21]],'#bbc7b1');
      line(c,[[0,-24],[0,-18]],'#f6f2d4',1);
      // Shield rotates through a block pose; sword swings with attack cooldown.
      c.save();c.translate(-13,-1);c.rotate(-swing*.15);
      path(c,[[-9,-10],[5,-12],[10,-5],[7,10],[0,15],[-9,8],[-12,-4]],steel,ink,2);
      path(c,[[-6,-7],[3,-9],[7,-4],[4,7],[0,11],[-6,6],[-8,-3]],cloth,ink,1);
      sigil(c,0,0,u.team,3.8);
      for(const [sx,sy] of [[-7,-7],[4,-7],[-5,6],[4,6]])circle(c,sx,sy,.9,'#e6d8af');
      c.restore();
      c.save();c.translate(10,-5);c.rotate(-.6+swing*2.0);
      line(c,[[0,8],[0,-19]],ink,6);
      path(c,[[-2,3],[-3,-21],[0,-29],[3,-21],[2,3]],steel,ink,1.2);
      line(c,[[0,-24],[0,2]],'#eef3df',1.2);line(c,[[-6,3],[6,3]],'#d6bc81',3);line(c,[[0,5],[0,11]],'#967955',4);
      c.restore();
      if(swing>.12){
        c.save();c.rotate(localFacing);c.globalAlpha=swing*.6;
        c.beginPath();c.arc(0,-5,31,-.65,.65);c.strokeStyle='#e5f6d9';c.lineWidth=3;c.stroke();
        c.beginPath();c.arc(0,-5,25,-.5,.6);c.strokeStyle=tint;c.lineWidth=1;c.stroke();c.restore();
      }
    }
    c.restore();
    statusAura(c,u,time,reducedMotion,isGolem?28:22,-10);
    if((u.hitFlash||0)>0){
      c.save();c.globalAlpha=Math.min(.65,u.hitFlash*3.4);
      line(c,[[-size*.65,-21],[-size*.8,-11],[-size*.5,1]],'#fff0cf',2.4);
      line(c,[[size*.65,-18],[size*.8,-7],[size*.55,1]],'#ffce9b',1.8);c.restore();
    }
    if(u.hp<u.maxHp&&id!=='runner')healthBar(c,0,-38,isGolem?36:29,u.hp/u.maxHp,tint,4);
    c.restore();
  }
  function artillery(c,t,state,time,reducedMotion){
    if(!finite(t.x)||!finite(t.y))return;
    const tint=color(t.team),dark=DARK[t.team]||DARK[0];
    const attack=reducedMotion?0:clamp((t.attackAnim||0)/.25,0,1);
    const recoil=attack>0?Math.sin(Math.min(1,(1-attack)*2.2)*Math.PI)*6:0;
    const ink='#101c2b';
    const metal=material(c,-22,-35,25,14,['#d2c4a5','#829491','#344a5c']);
    const bronze=material(c,-17,-32,15,13,['#e1bb7f','#9f7958','#4b4147']);
    c.save();c.translate(t.x,t.y);
    ellipse(c,8,12,29,13,'#08142145');ellipse(c,3,9,25,12,'#081421b0');
    c.beginPath();c.ellipse(0,6,25,13,0,0,Math.PI*2);c.strokeStyle=tint+'88';c.lineWidth=2;c.stroke();
    path(c,[[-23,1],[-16,-12],[15,-12],[23,1],[18,14],[-17,14]],material(c,-20,-10,22,16,['#5f7481','#38495b','#1e3046']),ink,2.5);
    path(c,[[-23,1],[-16,-12],[15,-12],[23,1],[0,10]],metal,ink,1.5);
    for(const sx of [-1,1]){
      ellipse(c,sx*18,6,5,9,'#273a4d');ellipse(c,sx*18-1,5,3,5,'#b1b79d');
      circle(c,sx*18,6,1.8,'#192a3e');
      line(c,[[sx*18-3,6],[sx*18+2,6]],'#ebdcad',.9);
      line(c,[[sx*18,1],[sx*18,11]],'#667b86',1.3);
    }
    path(c,[[-17,10],[-10,16],[10,16],[17,10]],'#273e53',ink,1.2);
    line(c,[[-12,11],[12,11]],'#b7b89b',1.2);
    for(const rx of [-13,13])circle(c,rx,-4,1.4,'#e7d0a0',ink,.6);
    if(t.cardId==='mortar'){
      c.save();c.translate(0,recoil*.7);
      path(c,[[-13,1],[-17,-30],[17,-30],[13,1],[0,7]],bronze,ink,2.5);
      path(c,[[1,-28],[17,-30],[13,1],[0,7]],'#52575d66');
      ellipse(c,0,-30,17,8,metal);ellipse(c,0,-30,12,5,'#132237');
      ellipse(c,-2,-32,9,2,'#081727');
      line(c,[[-10,-26],[-7,-5]],'#ffe4ac66',1.3);line(c,[[12,-25],[9,-6]],'#343b4f',1.6);
      line(c,[[-15,-14],[15,-14]],'#354b5d',5);line(c,[[-14,-15],[14,-15]],'#d0b587',1.5);
      for(const rx of [-10,0,10])circle(c,rx,-13,1.6,'#e9ce96');
      path(c,[[-6,-2],[0,3],[6,-2],[0,-7]],tint,ink,1);
      if(attack>.55){
        glow(c,0,-32,28*attack,'#ffba6660');
        path(c,[[-8,-33],[-14,-46],[-5,-42],[0,-63],[7,-43],[15,-49],[8,-32]],'#ffd391');
        path(c,[[-4,-33],[0,-48],[5,-33]],'#fff5cc');
      }
      if(attack>0&&attack<=.65){
        c.save();c.globalAlpha=attack*.45;
        for(let i=0;i<3;i++)ellipse(c,(i-1)*6,-40-(.65-attack)*23-i*4,4+i*2,5+i*2,'#c3b9a2');
        c.restore();
      }
      c.restore();
    }else{
      ellipse(c,0,-7,17,12,bronze);
      const target=[...(state.units||[]),...(state.towers||[]),...(state.castles||[])].find(x=>x.id===t.targetId)||
        (state.castles||[]).find(x=>x.team!==t.team&&x.alive!==false&&x.hp>0);
      const angle=finite(t.facing)?t.facing:target?Math.atan2(target.y-t.y,target.x-t.x):-.5*Math.PI;
      c.save();c.translate(0,-7);c.rotate(angle);c.translate(-recoil,0);
      rounded(c,-5,-8,38,16,4,material(c,0,-8,0,8,['#304355','#aab5a3','#e1d5ac','#46596a']),ink);
      rounded(c,21,-10,10,20,2,bronze,ink);
      rounded(c,29,-7,5,14,1,'#152638','#99ac9f');
      line(c,[[1,-5],[20,-5]],'#e9e3c5',1.8);
      rounded(c,-5,-11,12,4,1,'#576a72',ink);
      line(c,[[7,6],[20,6]],'#5c6c74',1.4);
      circle(c,3,0,2,'#d8be86',ink,.7);
      for(const rx of [23,28]){circle(c,rx,-7,1.3,'#f1d49a');circle(c,rx,7,1.3,'#b29975');}
      if(attack>.55){
        glow(c,36,0,24*attack,'#ffa95165');
        path(c,[[33,-5],[46,-12],[43,-4],[60,0],[43,4],[46,12],[33,5]],'#ffc783');
        path(c,[[34,-3],[50,0],[34,3]],'#fff2c6');
      }
      if(attack>0&&attack<=.65){
        c.save();c.globalAlpha=attack*.36;
        for(let i=0;i<3;i++)ellipse(c,39+i*8+(1-attack)*9,(i%2?1:-1)*(1-attack)*5,4+i*1.8,3+i*1.7,'#d4c5a5');
        c.restore();
      }
      c.restore();
      circle(c,0,-5,6,metal,ink,1.5);circle(c,0,-5,3,tint);line(c,[[-1,-7],[1,-5]],'#efffe9',.8);
    }
    if((t.hitFlash||0)>0){c.save();c.globalAlpha=t.hitFlash*2;ellipse(c,0,-10,21,20,'#fff1cf');c.restore();}
    if(t.hp<t.maxHp*.4&&!reducedMotion)smoke(c,5,-25,time,.35,.7);
    statusAura(c,t,time,reducedMotion,27,-11);
    healthBar(c,0,-41,37,t.hp/t.maxHp,tint,4);
    c.restore();
  }
  function effect(c,e,time,reducedMotion){
    if(!finite(e.x)||!finite(e.y))return;
    const p=clamp(e.life/(e.maxLife||1),0,1),kind=e.kind||e.type||'hit';
    const r=e.radius||25;
    c.save();c.globalAlpha=Math.min(1,p*2);
    if(kind==='relic-spawn'||kind==='relic-pickup'||kind==='relic-drop'||kind==='relic-delivery'){
      const delivered=kind==='relic-delivery',tint=delivered?'#ffdda2':kind==='relic-drop'?'#e3c4ac':'#b8ffeb';
      const spread=(1-p)*(delivered?55:34);
      circle(c,e.x,e.y,Math.max(1,spread),null,tint,2);
      for(let j=0;j<(delivered?10:6);j++){
        const a=j*Math.PI*2/(delivered?10:6),px=e.x+Math.cos(a)*spread,py=e.y+Math.sin(a)*spread*.6-(1-p)*22;
        path(c,[[px,py-3],[px+2,py],[px,py+3],[px-2,py]],tint);
      }
      if(delivered){glow(c,e.x,e.y,55,'#f5cf7e30');}
    }else if(kind==='fireball'){
      const spread=(1-p)*r;
      glow(c,e.x,e.y,r,'#ff733949');glow(c,e.x,e.y,r*.45,'#ffde9c80');
      circle(c,e.x,e.y,Math.max(1,spread),'#ffb35310','#ffdb9caf',2.5);
      for(let j=0;j<8;j++){
        const a=j*Math.PI/4,fx=e.x+Math.cos(a)*spread*.65,fy=e.y+Math.sin(a)*spread*.45;
        const h=14+p*27;
        c.save();c.translate(fx,fy);c.rotate(Math.sin(a)*.3);
        path(c,[[-8,6],[-13,-6],[-5,-4],[2,-h],[10,-13],[8,5]],'#f57a40');
        path(c,[[-4,5],[1,-h*.6],[6,3]],'#ffeab0');c.restore();
      }
      for(let j=0;j<10;j++){const a=j*.628;circle(c,e.x+Math.cos(a)*spread,e.y+Math.sin(a)*spread-(1-p)*15,1.5+p,'#ffe8ac');}
    }else if(kind==='blizzard'){
      glow(c,e.x,e.y,r,'#acd8ff35');circle(c,e.x,e.y,r*.95,'#9ad5f511','#b6eaff70',1.5);
      for(let j=0;j<3;j++){
        const rad=r*(.35+j*.23),a=time*(j%2?-.7:.7)+j*2;
        c.beginPath();c.ellipse(e.x,e.y,rad,rad*.68,-.2,a,a+Math.PI*1.25);c.strokeStyle=j%2?'#c3e7ff8c':'#95ccf277';c.lineWidth=2+j;c.stroke();
      }
      for(let j=0;j<13;j++){
        const a=j*2.399+time*.17,dist=r*(.2+rand(j+71)*.7),fx=e.x+Math.cos(a)*dist,fy=e.y+Math.sin(a)*dist-(1-p)*14;
        snowflake(c,fx,fy,3+rand(j+91)*4,'#deffffd4');
      }
      for(let j=0;j<5;j++){
        const ix=e.x+(j-2)*r*.32,iy=e.y+r*.3+Math.sin(j)*12;
        path(c,[[ix-6,iy],[ix-3,iy-14-p*15],[ix+3,iy-20-p*12],[ix+8,iy]],'#7dc6e98a','#d3f8ff',1);
      }
    }else if(kind==='tidalwave'){
      glow(c,e.x,e.y,r,'#5cdbdc2b');
      const spread=r*(.45+(1-p)*.55),rise=18+p*14;
      c.save();c.translate(e.x,e.y);
      c.beginPath();c.ellipse(0,4,spread,spread*.56,0,Math.PI,Math.PI*2);c.lineTo(spread,18);c.ellipse(0,18,spread,spread*.3,0,0,Math.PI);c.closePath();
      const waterAlpha=c.globalAlpha;c.globalAlpha*=.52;
      c.fillStyle=material(c,0,-spread*.56,0,20,['#d3fff4','#74d4d7','#3c88b3','#356287']);c.fill();c.globalAlpha=waterAlpha;
      c.beginPath();c.ellipse(0,4,spread,spread*.56,0,Math.PI,Math.PI*2);c.strokeStyle='#e4fff6';c.lineWidth=3;c.stroke();
      for(let band=0;band<3;band++){
        c.beginPath();c.moveTo(-spread*.86,8+band*10);c.bezierCurveTo(-spread*.6,-25+band*11,spread*.2,-19+band*12,spread*.82,6+band*10);
        c.strokeStyle=band%2?'#77d3e04d':'#c5fff37a';c.lineWidth=1.6;c.stroke();
      }
      for(let j=0;j<7;j++){
        const a=Math.PI+j*Math.PI/6,wx=Math.cos(a)*spread,wy=4+Math.sin(a)*spread*.56;
        c.beginPath();c.moveTo(wx-7,wy);c.bezierCurveTo(wx-12,wy-rise,wx+12,wy-rise,wx+9,wy-rise*.35);c.bezierCurveTo(wx+7,wy-rise*.1,wx,wy-rise*.3,wx+2,wy-rise*.45);c.strokeStyle='#bffff3';c.lineWidth=2;c.stroke();
        circle(c,wx+8,wy-rise-7,2,'#ddfff5');
      }
      c.beginPath();c.ellipse(0,24,spread*.85,spread*.28,0,0,Math.PI);c.strokeStyle='#9bece4b0';c.lineWidth=2;c.stroke();c.restore();
    }else if(kind==='aegis'){
      const rise=(1-p)*10;
      c.save();c.translate(e.x,e.y-rise);
      const dome=c.createRadialGradient(-r*.2,-r*.3,0,0,0,r);dome.addColorStop(0,'#bdfff22a');dome.addColorStop(.8,'#9cedee0c');dome.addColorStop(1,'#bffff850');
      c.beginPath();c.ellipse(0,0,r,r*.65,0,0,Math.PI*2);c.fillStyle=dome;c.fill();c.strokeStyle='#b8fff4';c.lineWidth=2;c.stroke();
      for(let j=0;j<3;j++){c.beginPath();c.ellipse(0,0,r*(.35+j*.2),r*.65,0,Math.PI,Math.PI*2);c.strokeStyle='#a5e9ec55';c.lineWidth=1;c.stroke();}
      for(let j=0;j<8;j++){
        const a=j*Math.PI/4,xx=Math.cos(a)*r*.8,yy=Math.sin(a)*r*.5;
        path(c,[[xx-3,yy-4],[xx+3,yy-4],[xx+3,yy+1],[xx,yy+5],[xx-3,yy+1]],'#d1fff498');
      }
      path(c,[[-12,-20],[12,-20],[12,-4],[0,7],[-12,-4]],'#80d8cc8c','#e1fff6',2);
      path(c,[[0,-15],[5,-8],[0,-1],[-5,-8]],'#eafff8');c.restore();
    }else if(kind==='lightning'){
      glow(c,e.x,e.y,r,'#c4d4ff66');glow(c,e.x,e.y,24,'#eaf4ffb0');
      const zig= reducedMotion?0:Math.sin(time*26)*8;
      line(c,[[e.x+12,e.y-130],[e.x-18+zig,e.y-64],[e.x+7,e.y-66],[e.x-14,e.y+1]],'#9d9bff35',16);
      path(c,[[e.x+12,e.y-130],[e.x-18+zig,e.y-64],[e.x+7,e.y-66],[e.x-14,e.y+1],[e.x+31,e.y-82],[e.x+4+zig,e.y-79]],'#e9efff','#9eb8ff',2);
      line(c,[[e.x-6,e.y-54],[e.x-37,e.y-67],[e.x-49,e.y-45]],'#c1ccff',2);
      line(c,[[e.x+2,e.y-27],[e.x+31,e.y-35],[e.x+45,e.y-11]],'#c1ccff',2);
      circle(c,e.x,e.y,r*(1-p)*1.2,null,'#c1d4ff',2);
      for(let i=0;i<6;i++){const a=i*Math.PI/3;line(c,[[e.x+Math.cos(a)*r*.22,e.y+Math.sin(a)*r*.22],[e.x+Math.cos(a)*r*.7,e.y+Math.sin(a)*r*.7]],'#a7bbf066',1.5);}
    }else if(kind==='heal'){
      glow(c,e.x,e.y,r,'#83f2b345');circle(c,e.x,e.y,r*(1-p*.15),null,'#8debc7',3);
      for(let i=0;i<5;i++){
        const a=i*1.256,x=e.x+Math.cos(a)*r*.55,y=e.y+Math.sin(a)*r*.55-(1-p)*18;
        c.fillStyle='#b0ffd8';c.fillRect(x-2,y-6,4,12);c.fillRect(x-6,y-2,12,4);
      }
    }else if(kind==='spawn'||kind==='summon'||kind==='build'){
      const tint=color(e.team||0);circle(c,e.x,e.y,12+(1-p)*30,null,tint,2);
      glow(c,e.x,e.y,35,tint+'36');
      for(let i=0;i<6;i++){
        const a=i*Math.PI/3,x=e.x+Math.cos(a)*23,y=e.y+Math.sin(a)*14-(1-p)*35;
        path(c,[[x,y-3],[x+2,y],[x,y+3],[x-2,y]],tint);
        if(i%2===0)line(c,[[x,y+7],[x,y+14]],tint+'55',1);
      }
      c.save();c.translate(e.x,e.y);c.scale(1,.5);
      circle(c,0,0,27,null,tint+'b0',1.5);circle(c,0,0,19,null,tint+'75',1);
      for(let i=0;i<6;i++){const a=i*Math.PI/3;line(c,[[Math.cos(a)*20,Math.sin(a)*20],[Math.cos(a)*26,Math.sin(a)*26]],'#e4ffe1c0',1.5);}
      c.restore();
      if(p>.4){
        const beam=material(c,e.x,e.y-54,e.x,e.y,[tint+'00',tint+'14',tint+'35']);
        path(c,[[e.x-12,e.y],[e.x-6,e.y-54],[e.x+6,e.y-54],[e.x+12,e.y]],beam);
      }
    }else if(kind==='explosion'||kind==='mortar'||kind==='destroy'||kind==='eliminated'){
      const progress=1-p;
      glow(c,e.x,e.y,r*(.7+progress),'#f3a651'+Math.round(p*100).toString(16).padStart(2,'0'));
      circle(c,e.x,e.y,r*(1-p*.5),'#ffc98925','#f6bb7799',2);
      for(let i=0;i<8;i++){
        const a=i*.785+1.2,ex=e.x+Math.cos(a)*r*progress,ey=e.y+Math.sin(a)*r*progress-progress*(1-progress)*35;
        c.save();c.translate(ex,ey);c.rotate(a+progress*3);path(c,[[-3,-2],[3,-3],[4,3],[-2,4]],i%2?'#82918a':'#d0a981','#213144',1);c.restore();
      }
      if(kind==='eliminated')for(let i=0;i<5;i++){const a=i*1.256;ellipse(c,e.x+Math.cos(a)*r*.4*progress,e.y+Math.sin(a)*r*.25-r*.4*progress,8+progress*20,8+progress*15,'#28324070');}
    }else{
      const impact=1-p,reach=5+impact*17;
      c.save();c.translate(e.x,e.y);c.rotate(.25);
      path(c,[[-3,-3],[0,-11*p],[3,-3],[11*p,0],[3,3],[0,9*p],[-3,3],[-10*p,0]],'#fff3cd');
      for(let i=0;i<5;i++){
        const a=i*Math.PI*.4+.2,inner=reach*.6,outer=reach+4;
        line(c,[[Math.cos(a)*inner,Math.sin(a)*inner],[Math.cos(a)*outer,Math.sin(a)*outer]],i%2?'#f3b278':'#ffe5ac',1.4);
      }
      c.restore();
    }
    c.restore();
  }

  function draw(c,state,options={}){
    if(!c||!state)return;
    options=options||{};
    const width=options.width||W,height=options.height||H;
    const time=options.reducedMotion?0:(options.time??state.elapsed??0);
    c.save();
    try {
    c.clearRect(0,0,width,height);c.scale(width/W,height/H);
    let cache=terrainCache.get(c.canvas);
    if(!cache||cache.mode!==state.mode||cache.mapId!==state.mapId){
      const doc=c.canvas&&c.canvas.ownerDocument;
      if(doc){const canvas=doc.createElement('canvas');canvas.width=W;canvas.height=H;baseTerrain(canvas.getContext('2d'),state.mode,state.mapId);cache={mode:state.mode,mapId:state.mapId,canvas};terrainCache.set(c.canvas,cache);}
    }
    if(cache)c.drawImage(cache.canvas,0,0);else baseTerrain(c,state.mode,state.mapId);
    if(root.CastleEnvironment&&typeof root.CastleEnvironment.draw==='function'){
      root.CastleEnvironment.draw(c,state,{time,reducedMotion:Boolean(options.reducedMotion),quality:options.quality||(width<700?'low':'high')});
    }
    // Surface glints stay subtle so the action reads immediately.
    if(!options.reducedMotion)for(let i=0;i<12;i++){
      const x=45+rand(i+300)*910,y=40+rand(i+500)*620;
      if(Math.abs(x-500)<215||(state.mode===4&&Math.abs(y-350)<145))continue;
      const a=.15+.13*Math.sin(time*.8+i);
      c.globalAlpha=a;
      if(state.mapId==='ember') circle(c,x+Math.sin(time+i)*3,y-(time*9+i*7)%25,2.5,'#ffc281');
      else if(state.mapId==='frost') circle(c,x+Math.sin(time+i)*5,y+(time*5+i*7)%20,2,'#e6efff');
      else{line(c,[[x-8,y],[x+8,y]],'#b1ddd1',1.5);circle(c,x,y,1.4,'#e5f8e8');}
    }
    c.globalAlpha=1;
    const selected=options.selectedCard===undefined?state.selectedCard:options.selectedCard;
    const selectedId=selected&&typeof selected==='object'?selected.id:selected;
    const selectedDefinition=root.CastleEngine&&root.CastleEngine.CARD_DEFS&&root.CastleEngine.CARD_DEFS.find(card=>card.id===selectedId);
    const spellRadii={heal:115,lightning:90,fireball:95,blizzard:125,tidalwave:145,aegis:145};
    const selectedSpell=selectedDefinition?selectedDefinition.kind==='spell':Boolean(spellRadii[selectedId]);
    const home=(state.castles||[]).find(s=>s.team===0);
    const runners=(state.units||[]).filter(unit=>unit.cardId==='runner'&&unit.hp>0);
    const ownRunner=runners.find(unit=>unit.team===0);
    const runnerScale=options.quality==='low'||width<700?1.7:1.4;
    const markerScale=options.quality==='low'||width<700?1.9:1.2;
    if(ownRunner&&home)runnerRoute(c,ownRunner,home,time,options.reducedMotion);
    if(selectedId&&home&&state.status==='playing'){
      if(selectedId==='runner'){
        if(!ownRunner)runnerRoute(c,home,home,time,options.reducedMotion);
      }else if(!selectedSpell){
        const radius=selectedId==='cannon'||selectedId==='mortar'?155:205;
        c.save();c.beginPath();c.arc(home.x,home.y,radius,0,Math.PI*2);c.fillStyle='#76ecd610';c.fill();c.setLineDash([8,7]);c.lineWidth=2;c.strokeStyle='#8ff8de99';c.stroke();c.restore();
      }
    }
    // Draw all solid pieces in depth order.
    const pieces=[...(state.castles||[]).map(v=>({type:'castle',value:v})),...(state.towers||[]).map(v=>({type:'tower',value:v})),...(state.units||[]).filter(unit=>unit.cardId!=='runner').map(v=>({type:'unit',value:v}))];
    if(state.relic&&!state.relic.carrierId)pieces.push({type:'relic',value:state.relic});
    pieces.sort((a,b)=>a.value.y-b.value.y);
    for(const p of pieces){if(p.type==='castle')castle(c,p.value,state,time,options.reducedMotion);else if(p.type==='tower')artillery(c,p.value,state,time,options.reducedMotion);else if(p.type==='relic')relic(c,p.value,time,options.reducedMotion);else unit(c,p.value,time,options.reducedMotion);}
    // Couriers are a tactical objective: keep their actual moving bodies visible
    // over castles and crowds instead of allowing the architecture to hide them.
    for(const courier of runners)unit(c,courier,time,options.reducedMotion,runnerScale);
    for(const p of state.projectiles||[]){
      if(!finite(p.x)||!finite(p.y))continue;
      const progress=1-clamp(p.life/(p.maxLife||1),0,1);
      const x=p.x,y=p.y;
      const tint=color(p.team);
      if(p.kind==='fire'||p.kind==='water'||p.kind==='ice'){
        const angle=Math.atan2(p.ty-(p.startY??p.y),p.tx-(p.startX??p.x));
        const fire=p.kind==='fire',ice=p.kind==='ice',tint=fire?'#ffbd74':ice?'#c9edff':'#9df7e7';
        c.save();c.translate(x,y);c.rotate(angle);
        if(fire){
          glow(c,0,0,15,'#ff8f3c45');
          path(c,[[-18,-3],[-11,-6],[-24,0],[-12,3],[-19,6],[0,6],[6,0],[0,-6]],'#f79752');
          circle(c,0,0,5,material(c,-4,-4,5,5,['#fff1b5','#ffb15f','#e76541']));
          for(let i=0;i<3;i++)circle(c,-25-i*7,Math.sin(time*13+i*2)*3,1.5-i*.35,i%2?'#f6b466a0':'#fff0aa8c');
        }else if(ice){
          path(c,[[-20,0],[-5,-5],[8,0],[-5,5]],'#84c5ee','#dffaff',1);
          line(c,[[-15,0],[5,0]],'#f0ffff',1.5);
        }else{
          glow(c,0,0,13,'#75e8df2b');
          c.beginPath();c.moveTo(-18,0);c.quadraticCurveTo(0,-12,6,0);c.quadraticCurveTo(0,12,-18,0);c.fillStyle=material(c,-10,-5,3,5,['#e1fff8','#7fdad8','#409cbd']);c.fill();
          circle(c,-20,-3,1.8,tint);circle(c,-26,2,1.2,tint);line(c,[[-8,-3],[1,-3]],'#e8fff6',1);
          c.beginPath();c.moveTo(-10,0);c.quadraticCurveTo(-22,-6,-36,-1);c.strokeStyle='#9ce6e76b';c.lineWidth=1.4;c.stroke();
        }
        c.restore();
      }else if(p.kind==='mortar'){
        const groundY=finite(p.startY)&&finite(p.ty)?p.startY+(p.ty-p.startY)*progress:y;
        ellipse(c,x,groundY,5,2,'#08293388');circle(c,x,y,5,'#ffde99','#805a41',2);
      }else{
        const angle=Math.atan2((p.ty??p.y)-(p.startY??p.y),(p.tx??p.x)-(p.startX??p.x));
        c.save();c.translate(x,y);c.rotate(angle);
        line(c,[[-19,0],[-5,0]],tint+'4d',2);
        if(p.kind==='arrow'){
          line(c,[[-12,0],[5,0]],'#d8c3a1',1.5);
          path(c,[[8,0],[2,-3],[2,3]],'#e3efdc','#526973',.6);
          path(c,[[-8,0],[-13,-3],[-11,0],[-13,3]],tint);
        }else if(p.kind==='cannon'){
          circle(c,0,0,4.5,'#34485b','#e3c79b',1);circle(c,-1,-1,1.5,'#b6c1b4');
        }else{
          path(c,[[-5,0],[0,-4],[6,0],[0,4]],tint,'#efffd3',.8);
        }
        c.restore();
      }
    }
    for(const e of state.effects||[])effect(c,e,time,options.reducedMotion);
    const point=options.hoverPoint;
    if(selectedId&&selectedId!=='runner'&&point&&finite(point.x)&&finite(point.y)){
      const tint=point.valid===false?'#ff8e84':'#b4ffe4';
      const radius=selectedSpell?(selectedDefinition?.range||spellRadii[selectedId]||100):23;
      c.save();c.setLineDash([5,5]);circle(c,point.x,point.y,radius,tint+'15',tint,2);c.setLineDash([]);
      line(c,[[point.x-8,point.y],[point.x+8,point.y]],tint,2);line(c,[[point.x,point.y-8],[point.x,point.y+8]],tint,2);c.restore();
    }
    for(const courier of runners)runnerMarker(c,courier,state,time,options.reducedMotion,runnerScale,markerScale);
    } finally {
      c.restore();
    }
  }

  const ICONS={
    sentinel:'<path d="m25 47-8 45 25 12 24-13-10-46Z" fill="url(#CW_CLOTH)" stroke="#26364b" stroke-width="3"/><path d="m31 77-7 21 15 4 7-19 9 17 13-5-11-20" fill="url(#CW_METAL)" stroke="#293950" stroke-width="3"/><path d="m24 45-4 27 23 15 22-13-7-29Z" fill="url(#CW_METAL)" stroke="#26364b" stroke-width="3"/><path d="m37 44-4 32 10 10 11-9-5-33" fill="url(#CW_CLOTH)" stroke="#3b5265" stroke-width="2"/><path d="m25 69 35 2" stroke="#cdb384" stroke-width="4"/><circle cx="43" cy="72" r="4" fill="#f0dbac" stroke="#4e5b65" stroke-width="2"/><path d="m27 32-1-17 15-10 17 9 3 19-12 13-15-3Z" fill="url(#CW_METAL)" stroke="#26364b" stroke-width="3"/><path d="m40 7 5-5 5 7-1 20-9 1Z" fill="url(#CW_CLOTH)" stroke="#26364b" stroke-width="2"/><path d="m31 30 24 1" stroke="#24364c" stroke-width="7"/><path d="M33 30h7m7 0h6" stroke="#aaf7db" stroke-width="2"/><path d="m38 37 6 5 7-5" fill="#527187"/><path d="m21 46-9-7-7 10 11 10m42-13 10-7 8 11-13 9" fill="url(#CW_METAL)" stroke="#26364b" stroke-width="2"/><path d="m10 51 20-4 13 13-5 32-15 13L7 93 3 65Z" fill="url(#CW_METAL)" stroke="#26364b" stroke-width="3"/><path d="m13 57 16-3 8 9-5 25-10 10-10-8-3-23Z" fill="url(#CW_CLOTH)" stroke="#517b83" stroke-width="2"/><path d="M23 65v25m-8-22v7l8 7 8-7v-7" fill="none" stroke="#e9dbac" stroke-width="2.5"/><g fill="#e6d6a8"><circle cx="14" cy="61" r="1.7"/><circle cx="30" cy="61" r="1.7"/><circle cx="17" cy="89" r="1.7"/><circle cx="29" cy="87" r="1.7"/></g><path d="m68 78 18-50 9-14 1 17-20 51Z" fill="url(#CW_METAL)" stroke="#293950" stroke-width="2"/><path d="m92 23-20 54" stroke="#f6f2d5" stroke-width="1.7"/><path d="m65 74 17 7m-9-2-5 12" stroke="#e5c58d" stroke-width="4"/>',
    archer:'<path d="m29 43-15 50 22 12 23-10 5-43Z" fill="url(#CW_CLOTH)" stroke="#25394a" stroke-width="3"/><path d="m32 81-8 20 11 5 13-21m3-5 7 23 11-4-9-22" fill="#8c806c" stroke="#2c3d4e" stroke-width="4"/><path d="m27 48-3 28 24 12 13-12-8-32Z" fill="#9e9077" stroke="#2b3e4e" stroke-width="2.5"/><path d="m28 48 27 30m-25-7 26 1" stroke="#d6bf94" stroke-width="4"/><path d="m22 56-9-27 10-5 16 30Z" fill="#8b6c56" stroke="#263a4d" stroke-width="2"/><path d="m18 37-8-25m16 21-3-27" stroke="#d5c6a1" stroke-width="2"/><path d="m8 12 5-4 4 9m3-11 6-3 1 10" fill="#bde1c3"/><path d="M27 42Q16 20 41 7q26 13 20 36l-13 9-19-7Z" fill="url(#CW_CLOTH)" stroke="#283c4e" stroke-width="3"/><path d="m31 27 12-11 13 12-2 14-12 7-11-10Z" fill="#dabb97" stroke="#3d4c57" stroke-width="2"/><path d="m28 31 11-15 15 9-11-4-8 10-1 13-8 5-1-11" fill="#826047"/><path d="m31 22 10-11 14 9" fill="none" stroke="#a7d2b0" stroke-width="1.5"/><path d="m34 30 6-1m6 0 6 1" stroke="#60524b" stroke-width="2"/><ellipse cx="38" cy="33" rx="3" ry="2" fill="#f3f0d7"/><ellipse cx="49" cy="33" rx="3" ry="2" fill="#f3f0d7"/><circle cx="39" cy="33" r="1.4" fill="#31505c"/><circle cx="50" cy="33" r="1.4" fill="#31505c"/><path d="m40 41 6 1 3-2" fill="none" stroke="#a16c64" stroke-width="1.5"/><ellipse cx="27" cy="50" rx="8" ry="6" fill="#9fb9b8" stroke="#2d4151" stroke-width="2"/><path d="M21 49q6-6 12-1" fill="none" stroke="#e0e5c9" stroke-width="1.5"/><path d="M73 13q33 43 0 85" fill="none" stroke="#263a4b" stroke-width="8"/><path d="M73 13q33 43 0 85" fill="none" stroke="#d8b77c" stroke-width="4"/><path d="m73 13 4 44-4 41" fill="none" stroke="#eee8cb" stroke-width="1.5"/><path d="m36 57 20 8 16-9" fill="none" stroke="#c7b293" stroke-width="7" stroke-linecap="round"/><path d="M41 57h52" stroke="#d5c7a4" stroke-width="2"/><path d="m98 57-10-4v8Z" fill="#e7f3d8"/>',
    golem:'<path d="m31 75-11 24 24 7 11-25 10 22 24-5-12-24Z" fill="url(#CW_METAL)" stroke="#293f51" stroke-width="3"/><path d="m29 29 21-15 27 14 7 34-15 25-30 1-17-24Z" fill="url(#CW_METAL)" stroke="#293f51" stroke-width="3.5"/><path d="m50 14 27 14 7 34-15 25-17-8 7-37Z" fill="#52748a"/><path d="m29 29 21-15 24 14-24 14Z" fill="#c3cbb1"/><path d="m25 39-16 9-5 31 19 12 16-20-8-23m43-11 17 14 7 29-17 11-17-21 1-22Z" fill="url(#CW_METAL)" stroke="#293f51" stroke-width="3"/><path d="m33 34 11 6-2 7-11-5m24-2 13-7-1 10-11 4Z" fill="#1f3d51"/><path d="m34 39 8 3m15 1 9-5" stroke="#beffdb" stroke-width="3"/><path d="m42 49 10 4 11-6-5 12-12 2Z" fill="#29495c"/><path d="m45 54 9 1 5-3" stroke="#b7ebcd" stroke-width="2"/><path d="m44 64 9-9 11 11-9 15Z" fill="url(#CW_ENERGY)" stroke="#d0ffe7" stroke-width="2"/><path d="m39 28-6-10-1-14m2 14-10-6-4-9m14 9 7-7m33 26 7-12 12-5m-12 5-1-12" fill="none" stroke="#c99aa5" stroke-width="4" stroke-linecap="round"/><path d="m13 55 8 7-6 13m60-19 10 9-4 10" fill="none" stroke="#91ead2" stroke-width="2.5"/><g fill="#b6c8b7" stroke="#54748a" stroke-width="2"><circle cx="20" cy="52" r="4"/><circle cx="13" cy="61" r="3"/><circle cx="68" cy="78" r="4"/><circle cx="77" cy="73" r="3"/></g><path d="m27 95 13 3m29-3 14-1" stroke="#d6dfc2" stroke-width="2"/>',
    swarm:'<g fill="none" stroke-linecap="round"><path d="m27 65-15 10-7 13m26-16L20 88l-2 14m56-37 16 10 7 13M70 74l13 14 2 14" stroke="#29374a" stroke-width="7"/><path d="m27 65-15 10-7 13m26-16L20 88l-2 14m56-37 16 10 7 13M70 74l13 14 2 14" stroke="#cba07b" stroke-width="3.5"/></g><path d="m23 56-8-5 4 15m60-10 8-5-4 15" fill="#edbb8a" stroke="#29374a" stroke-width="2"/><ellipse cx="51" cy="67" rx="30" ry="24" fill="#bd7e6e" stroke="#29374a" stroke-width="3"/><path d="m23 60 12-18 19-4 23 16 2 13-18 7-24-2Z" fill="url(#CW_CLOTH)" stroke="#345366" stroke-width="2.5"/><path d="m37 50 16-7 12 10-15 9Z" fill="#a3d4bd"/><path d="m30 53-13-17m57 17 13-17" stroke="#d89f7b" stroke-width="9"/><path d="M17 43 5 34 4 15 14 20l4 10 6-15 9 11-7 20Z" fill="#e3ab7d" stroke="#29374a" stroke-width="2.5"/><path d="m84 44 13-10 1-19-11 5-4 10-6-15-9 11 7 20Z" fill="#e3ab7d" stroke="#29374a" stroke-width="2.5"/><path d="m8 21 3 13 9 6m72-19-3 13-9 6" fill="none" stroke="#ffe0ac" stroke-width="2"/><path d="m40 55-2-13m24 13 2-13" stroke="#374359" stroke-width="5"/><circle cx="38" cy="40" r="7" fill="#fff0c0" stroke="#29374a" stroke-width="2"/><circle cx="64" cy="40" r="7" fill="#fff0c0" stroke="#29374a" stroke-width="2"/><circle cx="40" cy="40" r="3.5" fill="#294153"/><circle cx="66" cy="40" r="3.5" fill="#294153"/><circle cx="38" cy="38" r="1.5" fill="white"/><circle cx="64" cy="38" r="1.5" fill="white"/><path d="m44 74 7 4 8-4" fill="none" stroke="#6c4b55" stroke-width="2"/><g fill="#f6c492"><circle cx="32" cy="76" r="2"/><circle cx="69" cy="76" r="2"/><circle cx="39" cy="83" r="2"/><circle cx="62" cy="84" r="2"/></g>',
    cannon:'<path d="m16 79 13-19h44l14 19-10 20H26Z" fill="#657e6a" stroke="#c0ba89" stroke-width="3"/><ellipse cx="51" cy="75" rx="30" ry="19" fill="#355e60" stroke="#a3b18c" stroke-width="3"/><path d="m32 66 19-40 18 5-10 44Z" fill="#a5bba4" stroke="#294c52" stroke-width="3"/><path d="m50 27 4-12 21 7-5 15Z" fill="#77998a" stroke="#c2d5ac" stroke-width="3"/><ellipse cx="64" cy="20" rx="11" ry="6" transform="rotate(20 64 20)" fill="#163742" stroke="#a9bea0" stroke-width="3"/><path d="m43 53 19 7" stroke="#416a69" stroke-width="5"/><circle cx="49" cy="76" r="9" fill="#6bdbc3" stroke="#baefcd" stroke-width="3"/><path d="m28 92 10 3m28-3 9-2" stroke="#b5c49e" stroke-width="3"/>',
    mortar:'<path d="m16 82 12-14h46l12 14-8 18H25Z" fill="#607668" stroke="#a8b596" stroke-width="3"/><path d="m31 77-8-45 53-1-7 47-19 9Z" fill="#716e64" stroke="#afad8a" stroke-width="3"/><path d="m51 37-1 47 19-7 7-46" fill="#455e5b"/><path d="m27 57 44 1" stroke="#deb07a" stroke-width="8"/><ellipse cx="50" cy="31" rx="27" ry="13" fill="#a4b49a" stroke="#decea0" stroke-width="3"/><ellipse cx="50" cy="31" rx="18" ry="8" fill="#193a44"/><path d="m44 65 6-6 6 6-6 9Z" fill="#f2c888"/><path d="m46 17 4-9m13 9 5-7" stroke="#d6a667" stroke-width="2"/>',
    heal:'<circle cx="51" cy="57" r="33" fill="#215c5c" stroke="#8ecba6" stroke-width="2"/><circle cx="51" cy="57" r="27" fill="none" stroke="#5c9d82" stroke-width="1" stroke-dasharray="3 5"/><path d="M43 33h16v16h16v16H59v16H43V65H27V49h16Z" fill="#c7f3c5" stroke="#6ed5a3" stroke-width="2"/><path d="m22 37-7-11m65 11 7-11M21 80l-8 8m68-8 8 8M51 17V7" stroke="#a9dfab" stroke-width="2"/><path d="m24 98 27-7 26 7-26 7Z" fill="#4c8f78"/>',
    lightning:'<path d="m57 7-36 52h26l-12 47 48-65H56L70 7Z" fill="#e1e5ff" stroke="#a6a8e3" stroke-width="3"/><path d="m57 7-36 52h26L35 106l25-55H37Z" fill="#93a7e9"/><path d="m15 39-8-9m76 41 10 5m-76 8-9 6m76-69 9-6" stroke="#a8b6e4" stroke-width="2"/><ellipse cx="51" cy="103" rx="28" ry="5" fill="#656f9a" opacity=".5"/>',
    embermage:'<path d="m28 49-13 51 24 7 9-19 9 19 19-10-15-49Z" fill="url(#CW_CLOTH)" stroke="#273047" stroke-width="3"/><path d="m28 49-7 45 12 2 9-35 7 29 11 11 9-7-15-44" fill="#a75f58"/><path d="m25 58 39 1m-30 37 7-31m14 0 9 29" stroke="#e8bb8a" stroke-width="2"/><path d="m28 45-3-19 11-16 17 2 12 16-4 20-10-5 4-13-10-9-11 12 4 11Z" fill="url(#CW_CLOTH)" stroke="#202b41" stroke-width="3"/><path d="m35 32 18-2-2 18-11 3-6-10Z" fill="#be917c"/><path d="m32 23-12-5 4-8 14 7m17 0 14-7 1 10-9 8" fill="url(#CW_METAL)" stroke="#263047" stroke-width="2"/><path d="M37 36h5m4 0h5" stroke="#fff1b6" stroke-width="3"/><path d="m78 102-3-62" stroke="#c9a37a" stroke-width="5"/><path d="m65 34 2 15 10 6 11-9 1-13-11 9Z" fill="url(#CW_METAL)" stroke="#263047" stroke-width="2"/><path d="m69 37-4-12 9 4 5-22 10 18-3 14Z" fill="#f38443" stroke="#ac4e3b" stroke-width="2"/><path d="m73 36 6-19 5 19Z" fill="#fff1b4"/><circle cx="19" cy="62" r="11" fill="url(#CW_ENERGY)"/><path d="m13 57-5-7 3 15m14-15 3 9" stroke="#ffc46f" stroke-width="2"/>',
    frostwarden:'<path d="m30 48-9 49 24 7 20-3 11-12-15-45Z" fill="url(#CW_CLOTH)" stroke="#25354c" stroke-width="3"/><path d="m32 49-7 28 18 14 20-10-3-32Z" fill="url(#CW_METAL)" stroke="#293950" stroke-width="3"/><path d="m39 48 8-10 9 11-5 28-8-1Z" fill="#9edff4"/><path d="m30 36 1-16 12-10 17 9 6 18-8 14-19-1Z" fill="url(#CW_METAL)" stroke="#293950" stroke-width="3"/><path d="m31 21-6-12 14 7 6-13 8 14 13-9-3 15" fill="#b9e8f4" stroke="#304766" stroke-width="2"/><path d="M35 34h24" stroke="#29466d" stroke-width="7"/><path d="M36 34h8m6 0h8" stroke="#ddffff" stroke-width="2"/><path d="m12 52 19-9 14 15-8 34-18 14L5 87Z" fill="url(#CW_METAL)" stroke="#23374f" stroke-width="3"/><path d="m17 57 13-6 8 10-6 25-11 11-10-12Z" fill="#5880a2"/><path d="M24 64v23m-10-17 20 11m0-11L14 81" stroke="#d8f7ff" stroke-width="2"/><path d="m77 103 2-72" stroke="#bddbe3" stroke-width="4"/><path d="m70 30 10-23 10 23-11 12Z" fill="url(#CW_ENERGY)" stroke="#4d7e9e" stroke-width="2"/><path d="M80 10v27" stroke="#f1ffff" stroke-width="2"/>',
    tidecaller:'<path d="m28 47-13 47 24 12 13-13 20 6 4-11-13-43Z" fill="url(#CW_CLOTH)" stroke="#20354d" stroke-width="3"/><path d="m39 48-7 44 11 7 8-27 10 21 8-4-13-42" fill="#8fc8c2"/><path d="m29 57 34-1m-31 38 8-33" stroke="#d7d6a6" stroke-width="2"/><path d="m27 37 4-21 16-10 16 11 5 32-8 13-9-16 3-22-10-7-9 14 1 21-7 9-7-12Z" fill="url(#CW_METAL)" stroke="#2c5268" stroke-width="3"/><path d="m35 26 19-2-2 21-12 3-7-13Z" fill="#aacfc6"/><path d="m29 20-3-13 14 7 7-12 6 13 15-10-5 17" fill="#b8dad3" stroke="#35576b" stroke-width="2"/><path d="m43 17 4-6 4 6-4 7Z" fill="#77f8e7"/><path d="M37 32h5m5 0h6" stroke="#234d64" stroke-width="2"/><path d="M81 103V25m-11-4v16l11 8 11-8V21" fill="none" stroke="#cbded2" stroke-width="4"/><path d="m76 22 5-12 5 12m-20 0 4-10 4 10m14 0 4-10 4 10" fill="#9cf7e8"/><circle cx="17" cy="61" r="10" fill="url(#CW_ENERGY)"/><path d="M9 96q39 16 79-4" fill="none" stroke="#8fe7dc" stroke-width="3"/><circle cx="9" cy="48" r="2" fill="#e2fff1"/><circle cx="22" cy="44" r="3" fill="#a0fff0"/>',
    fireball:'<path d="m81 7-7 30 20-8-19 31 14 7-34 32-32-8-15-26 16-27 24-10-4 16L68 19l-7 24Z" fill="#de673d" stroke="#703d41" stroke-width="3"/><path d="m78 22-16 29 18-4-23 39-31-2-13-20 18-21 15-7-2 16Z" fill="#ffa34f"/><circle cx="40" cy="70" r="24" fill="url(#CW_ENERGY)"/><path d="m25 73 4-18 15-7-3 14 14-5-9 19-13 9Z" fill="#fff0b6"/><path d="m15 23-5 12m70 59 10-3m-30 16 8-4" stroke="#f9c17b" stroke-width="3"/>',
    blizzard:'<circle cx="51" cy="53" r="31" fill="#427598" opacity=".35"/><g stroke="#d9f6ff" stroke-width="4" stroke-linecap="round"><path d="M51 14v74M19 33l64 36M19 69l64-36"/><path d="m43 22 8 9 8-9m-16 58 8-9 8 9M24 42l12-3-3-12m45 39-12 3 3 12M24 60l12 3-3 12m45-39-12-3 3-12" stroke-width="2.5"/></g><path d="m19 103 4-20 8-11 10 32m19 0 3-25 10-17 8 43" fill="url(#CW_ENERGY)" stroke="#91bfdc" stroke-width="2"/><path d="M7 51q-7 41 41 47m10-90q45 1 40 47" fill="none" stroke="#88b6df" stroke-width="2"/><circle cx="11" cy="19" r="2" fill="#d5f7ff"/><circle cx="87" cy="91" r="3" fill="#d5f7ff"/>',
    tidalwave:'<path d="M9 95Q40 88 37 52C34 18 82 7 92 35q7 20-13 27-15 4-19-8 14 3 17-8-4-17-21-5-12 10 6 34 13 17 34 18l-2 11H11Z" fill="url(#CW_ENERGY)" stroke="#2e718e" stroke-width="3"/><path d="M9 95Q41 88 38 52C37 22 71 13 86 28q14 17-7 30-10 4-16-5 15 1 14-10-2-16-19-7-20 10-3 37 12 19 39 24" fill="none" stroke="#d2fff1" stroke-width="4"/><path d="M15 101q36-15 75 1" fill="none" stroke="#b0f4e7" stroke-width="2"/><circle cx="20" cy="42" r="4" fill="#a8f4e9"/><circle cx="26" cy="27" r="2" fill="#e3fff5"/><circle cx="97" cy="67" r="3" fill="#a8f4e9"/>',
    aegis:'<path d="M18 29 51 11l33 18-3 38Q72 89 51 104 27 89 20 67Z" fill="url(#CW_CLOTH)" stroke="#c4ede4" stroke-width="4"/><path d="m26 34 25-14 25 14-3 31Q65 83 51 94 34 83 28 65Z" fill="url(#CW_ENERGY)" opacity=".65"/><path d="m32 61 1-17 8-1v10h7V36h8v17h7V43h8v20L51 79Z" fill="#d7e9d4" stroke="#3a7780" stroke-width="2"/><path d="M46 70V59q5-10 10 0v11" fill="#4f8490"/><path d="M8 51Q6 18 36 7m58 45Q96 20 71 8" fill="none" stroke="#91dcd6" stroke-width="2"/><path d="m11 81 4-4 4 4-4 4m69 0 4-4 4 4-4 4" fill="#c9fff1"/>',
    runner:'<rect x="57" y="36" width="30" height="43" rx="8" fill="#a7845e" stroke="#30334a" stroke-width="3"/><rect x="63" y="30" width="20" height="16" rx="5" fill="#d3ae7a" stroke="#594c4c" stroke-width="2"/><path d="M65 44v29m14-29v29" stroke="#edcd97" stroke-width="3"/><rect x="64" y="56" width="17" height="13" rx="3" fill="#8f674f" stroke="#5b4b4a" stroke-width="2"/><circle cx="73" cy="61" r="2" fill="#f2d493"/><path d="m33 77-9 23 12 7 16-22m3-9 10 17 12-5-9-20" fill="#a28a78" stroke="#30334a" stroke-width="5"/><path d="m22 98-8 7 4 6 20-3-2-7m30-12 8 10 11-3-7-12" fill="#675264" stroke="#2c3148" stroke-width="3"/><path d="m28 47-8 34 26 12 24-15-13-33Z" fill="url(#CW_CLOTH)" stroke="#2c3148" stroke-width="3"/><path d="m28 53-13 14 7 7m39-21 8 10-7 6" fill="none" stroke="#8c7790" stroke-width="8" stroke-linecap="round"/><circle cx="23" cy="74" r="5" fill="#dcbba0" stroke="#2c3148" stroke-width="2"/><circle cx="61" cy="70" r="5" fill="#dcbba0" stroke="#2c3148" stroke-width="2"/><path d="m28 46 10 15 21-7 4-15-16-5Z" fill="#70bfad" stroke="#2c3148" stroke-width="2"/><path d="m34 54-14 5-11-6 20-8" fill="#82d7bd" stroke="#2c3148" stroke-width="2"/><path d="m24 38-1-17 13-15 20 2 15 13-3 20-13 12-21-3Z" fill="url(#CW_CLOTH)" stroke="#2c3148" stroke-width="3"/><path d="m31 27 13-11 17 11-2 15-11 8-14-8Z" fill="#dfbda0" stroke="#5e4652" stroke-width="2"/><path d="m31 29 12-13 18 11-1 6-13-9-10 7Z" fill="#514052"/><ellipse cx="39" cy="33" rx="4" ry="5" fill="#fff0c9"/><ellipse cx="53" cy="34" rx="4" ry="5" fill="#fff0c9"/><circle cx="40" cy="33" r="2" fill="#363348"/><circle cx="54" cy="34" r="2" fill="#363348"/><path d="m42 42 6 1 3-2" fill="none" stroke="#a2706c" stroke-width="2"/><path d="m26 20 10-11 15 1" fill="none" stroke="#d5b8c3" stroke-width="2"/><path d="m82 13 7-10 7 11-5 12-9-4Z" fill="url(#CW_ENERGY)" stroke="#54728a" stroke-width="2"/><path d="m7 89 7-2m-8 11 8-2" stroke="#b9c9ac" stroke-width="2"/>'
  };
  function cardIcon(id){
    const key=Object.prototype.hasOwnProperty.call(ICONS,id)?id:'sentinel';
    const fire=key==='embermage'||key==='fireball',ice=key==='frostwarden'||key==='blizzard';
    const palette=fire?['#d28a66','#7c3e50','#fff0b3','#ee843f']:ice?['#9ac4df','#435c8b','#e5ffff','#81bcdf']:key==='runner'?['#ab8ca6','#4e4567','#e3fff0','#83d9c9']:['#9ad6c4','#32687d','#e0fff1','#57bcbf'];
    const prefix='cw-'+key;
    const defs='<defs><linearGradient id="'+prefix+'-cloth" x2=".85" y2="1"><stop stop-color="'+palette[0]+'"/><stop offset="1" stop-color="'+palette[1]+'"/></linearGradient><linearGradient id="'+prefix+'-metal" x2="1" y2=".75"><stop stop-color="#e1e5c9"/><stop offset=".4" stop-color="#b2d4d3"/><stop offset="1" stop-color="#5b7698"/></linearGradient><radialGradient id="'+prefix+'-energy" cx=".35" cy=".3" r=".8"><stop stop-color="'+palette[2]+'"/><stop offset=".5" stop-color="'+palette[3]+'"/><stop offset="1" stop-color="'+palette[1]+'"/></radialGradient></defs>';
    const content=ICONS[key].replaceAll('CW_CLOTH',prefix+'-cloth').replaceAll('CW_METAL',prefix+'-metal').replaceAll('CW_ENERGY',prefix+'-energy');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 102 114" aria-hidden="true" focusable="false">'+defs+content+'</svg>';
  }
  const api={draw,cardIcon};
  root.CastleRenderer=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
