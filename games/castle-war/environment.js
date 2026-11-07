(function (root) {
  'use strict';

  // World-space atmosphere. The island is excluded from every paint operation,
  // keeping the battlefield, routes and placement feedback completely readable.
  const W = 1000, H = 700, TAU = Math.PI * 2;
  const backdrops = new WeakMap();
  const ISLANDS = {
    4: [[397,30],[602,30],[644,72],[650,218],[686,236],[933,236],[974,281],[976,416],[931,462],[683,462],[649,486],[646,631],[601,674],[395,674],[353,632],[351,484],[317,462],[69,462],[24,418],[24,282],[67,237],[317,237],[353,217],[355,74]],
    2: [[392,26],[603,26],[657,76],[656,222],[701,271],[724,350],[701,430],[655,479],[652,628],[605,675],[392,675],[344,628],[346,479],[298,430],[275,350],[299,272],[344,222],[344,75]]
  };
  const rnd = n => { const x = Math.sin(n * 127.13 + 78.27) * 43758.5453; return x - Math.floor(x); };
  const wrap = (n, max) => ((n % max) + max) % max;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const ICE_PLATES = [[155,118,124,79,1],[844,122,123,81,2],[130,369,115,123,3],[861,356,118,112,4],[178,577,139,88,5],[823,584,145,88,6]];

  function outsideIsland(c, mode) {
    c.beginPath(); c.rect(0, 0, W, H);
    (ISLANDS[mode] || ISLANDS[2]).forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.closePath(); c.clip('evenodd');
  }
  function poly(c, points, fill, stroke, width = 1) {
    c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  function ellipse(c, x, y, rx, ry, fill, stroke, width = 1) {
    c.beginPath(); c.ellipse(x, y, Math.max(.01,rx), Math.max(.01,ry), 0, 0, TAU);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  function haze(c, x, y, r, inner) {
    const g = c.createRadialGradient(x,y,0,x,y,r); g.addColorStop(0,inner); g.addColorStop(1,'transparent');
    ellipse(c,x,y,r,r,g);
  }
  function curve(c, points, closed = false) {
    c.beginPath(); c.moveTo(points[0][0], points[0][1]);
    for (let i=0;i<points.length-1;i++) {
      const a=points[Math.max(0,i-1)],b=points[i],d=points[i+1],e=points[Math.min(points.length-1,i+2)];
      c.bezierCurveTo(b[0]+(d[0]-a[0])/6,b[1]+(d[1]-a[1])/6,d[0]-(e[0]-b[0])/6,d[1]-(e[1]-b[1])/6,d[0],d[1]);
    }
    if(closed)c.closePath();
  }
  function jaggedRock(c, x, y, rx, ry, n, warm = true) {
    const points=[];
    for(let j=0;j<8;j++) {const a=j/8*TAU,s=.77+rnd(n*17+j)*.25;points.push([x+Math.cos(a)*rx*s,y+Math.sin(a)*ry*s]);}
    poly(c,points,warm?'#241e2a':'#1c3442',warm?'#0f1420':'#16303a',3);
    poly(c,[points[4],points[5],points[6],points[7],[x+rx*.35,y-ry*.05],[x-rx*.45,y+ry*.05]],warm?'#46303a':'#34505b');
    c.beginPath();c.moveTo(x-rx*.6,y+ry*.2);c.lineTo(x-rx*.05,y+ry*.01);c.lineTo(x+rx*.55,y+ry*.24);
    c.strokeStyle=warm?'#98513c':'#547581';c.lineWidth=1.5;c.stroke();
  }
  function platePoints(x,y,rx,ry,n) {
    return Array.from({length:8},(_,i)=>{
      const a=i/8*TAU,s=.8+rnd(n*31+i)*.2;
      return [x+Math.cos(a)*rx*s,y+Math.sin(a)*ry*s];
    });
  }
  function coralFan(c,x,y,size,tint) {
    c.save();c.translate(x,y);c.lineCap='round';
    for(let i=0;i<5;i++) {
      const a=-Math.PI*.85+i*Math.PI*.18,px=Math.cos(a)*size,py=Math.sin(a)*size;
      c.beginPath();c.moveTo(0,0);c.quadraticCurveTo(px*.2,py*.6,px,py);
      c.strokeStyle='#06262e';c.lineWidth=5;c.stroke();c.strokeStyle=tint;c.lineWidth=2.2;c.stroke();
      for(let j=1;j<3;j++) {
        const sx=px*j/3,sy=py*j/3,dir=i%2?-1:1;
        c.beginPath();c.moveTo(sx,sy);c.lineTo(sx+dir*size*.18,sy-size*.14);c.stroke();
      }
      ellipse(c,px,py,2,2,'#9dd9bc');
    }
    c.restore();
  }
  function abyssBackdrop(c) {
    const sea=c.createLinearGradient(0,0,W,H);sea.addColorStop(0,'#071724');sea.addColorStop(.42,'#0a353d');sea.addColorStop(.75,'#103a40');sea.addColorStop(1,'#071a2d');
    c.fillStyle=sea;c.fillRect(0,0,W,H);
    // Layered reef shelves create depth under the translucent water.
    for(let i=0;i<7;i++) {
      const x=i%2?890:115,y=55+i*106,rx=115+rnd(i+50)*43,ry=53+rnd(i+87)*24;
      const points=platePoints(x,y,rx,ry,i+60);
      poly(c,points.map(([px,py])=>[px+7,py+15]),'#03192396');
      poly(c,points,i%2?'#143b40':'#183c41','#276166',1.6);
      poly(c,[points[4],points[5],points[6],points[7],[x+rx*.22,y-ry*.1],[x-rx*.4,y]],'#27514c');
      c.beginPath();c.moveTo(points[4][0],points[4][1]);c.lineTo(points[5][0],points[5][1]);c.lineTo(points[6][0],points[6][1]);c.strokeStyle='#5d88714f';c.lineWidth=2;c.stroke();
      for(let j=0;j<5;j++){const px=x+(rnd(i*9+j)-.5)*rx*1.3,py=y+(rnd(i*7+j+90)-.5)*ry;ellipse(c,px,py,2+rnd(j+7)*3,1.5,'#537a655c');}
    }
    // Submerged masonry is deliberately sparse and stays beneath the action.
    for(const [x,y,s] of [[244,137,.8],[760,545,1],[75,510,.72],[927,205,.7]]) {
      c.save();c.translate(x,y);c.rotate(-.14);c.scale(s,s);
      ellipse(c,9,30,36,12,'#021c278c');
      poly(c,[[-23,25],[-23,-28],[-7,-45],[18,-37],[23,23],[0,36]],'#365b59','#123540',2);
      poly(c,[[0,-35],[18,-37],[23,23],[0,36]],'#254749');
      poly(c,[[-23,-28],[-7,-45],[18,-37],[0,-24]],'#668073');
      for(let j=0;j<3;j++){c.beginPath();c.moveTo(-20,-15+j*14);c.lineTo(18,-9+j*14);c.strokeStyle='#152f3799';c.lineWidth=1.5;c.stroke();}
      c.beginPath();c.moveTo(0,-22);c.lineTo(-5,-9);c.lineTo(2,0);c.lineTo(-3,14);c.strokeStyle='#8cb79b66';c.stroke();
      c.restore();
    }
    for(const [x,y,s,tint] of [[41,174,24,'#6a8c79'],[280,642,26,'#4f9688'],[948,604,30,'#557f8d'],[731,54,19,'#6b9f8c'],[74,650,35,'#467e77'],[938,98,23,'#527f85']]) coralFan(c,x,y,s,tint);
    for(let i=0;i<16;i++) {
      const x=i%2?932+rnd(i+21)*60:8+rnd(i+44)*60,y=rnd(i+82)*H;
      jaggedRock(c,x,y,8+rnd(i+17)*16,5+rnd(i+52)*9,i,false);
    }
  }
  function frostBackdrop(c) {
    const ice=c.createLinearGradient(0,0,W,H);ice.addColorStop(0,'#161b34');ice.addColorStop(.45,'#303c5b');ice.addColorStop(1,'#151d35');
    c.fillStyle=ice;c.fillRect(0,0,W,H);
    for(const [x,y,rx,ry,n] of ICE_PLATES) {
      const points=platePoints(x,y,rx,ry,n);
      poly(c,points.map(([px,py])=>[px+5,py+13]),'#0a1830a6');
      const sheet=c.createLinearGradient(x-rx,y-ry,x+rx,y+ry);sheet.addColorStop(0,'#687f98');sheet.addColorStop(.45,'#3f5b78');sheet.addColorStop(1,'#22324f');
      poly(c,points,sheet,'#91b6c16e',2);
      poly(c,[points[4],points[5],points[6],points[7],[x+rx*.2,y+ry*.1],[x-rx*.33,y+ry*.1]],'#a9d2d21a');
      // Dark fissures, with one lit edge, read as thickness instead of outlines.
      const cracks=[[[x-rx*.7,y+ry*.14],[x-rx*.15,y-ry*.05],[x+rx*.18,y+ry*.25],[x+rx*.7,y+ry*.12]],[[x-rx*.15,y-ry*.05],[x+rx*.08,y-ry*.43],[x-rx*.1,y-ry*.72]]];
      for(const points of cracks){curve(c,points);c.strokeStyle='#172842aa';c.lineWidth=4;c.stroke();curve(c,points.map(([px,py])=>[px,py-1.4]));c.strokeStyle='#b0dbe55c';c.lineWidth=1;c.stroke();}
      c.beginPath();c.moveTo(points[4][0],points[4][1]);c.lineTo(points[5][0],points[5][1]);c.lineTo(points[6][0],points[6][1]);c.lineTo(points[7][0],points[7][1]);c.strokeStyle='#d1e0dc9c';c.lineWidth=3;c.stroke();
    }
    // Snow banks frame the glassy sheets; carved facets provide foreground scale.
    for(let side=0;side<2;side++)for(let i=0;i<4;i++) {
      const x=side?966:29,y=45+i*208,rx=48+rnd(i+side*18)*20,ry=45+rnd(i+25)*28;
      const p=platePoints(x,y,rx,ry,i+side*14+40);
      poly(c,p.map(([px,py])=>[px+3,py+10]),'#11203990');
      poly(c,p,'#4f657e','#243650',2);poly(c,[p[4],p[5],p[6],p[7],[x+rx*.4,y+ry*.1],[x-rx*.2,y]],'#91a8b7');
      poly(c,[[x-11,y+5],[x-4,y-29],[x+9,y-46],[x+18,y-14],[x+14,y+7]],'#87b5c4','#c6dde1',1);
      poly(c,[[x+9,y-46],[x+18,y-14],[x+14,y+7],[x+4,y-8]],'#406b8a');
    }
    for(let i=0;i<11;i++) {
      const x=i%2?790:145,y=35+i*67;
      curve(c,[[x-85,y],[x-32,y-8],[x+20,y+3],[x+78,y-3]]);c.strokeStyle='#b6c4d017';c.lineWidth=4;c.stroke();
    }
  }
  function volcanicBackdrop(c) {
    const ground=c.createLinearGradient(0,0,0,H);ground.addColorStop(0,'#1c1824');ground.addColorStop(.5,'#39202a');ground.addColorStop(1,'#191924');
    c.fillStyle=ground;c.fillRect(0,0,W,H);
    for(let i=0;i<62;i++) {
      const x=rnd(i*9+3)*W,y=rnd(i*5+20)*H,r=8+rnd(i+200)*32;
      c.beginPath();c.moveTo(x-r,y+r*.15);c.lineTo(x-r*.3,y-r*.35);c.lineTo(x+r*.23,y);c.lineTo(x+r,y-r*.12);
      c.strokeStyle=i%5===0?'#7a3b343b':'#090e1938';c.lineWidth=i%5===0?2:3;c.stroke();
    }
    for(let i=0;i<19;i++) {
      const x=i<10?rnd(i+11)*89:909+rnd(i+31)*91,y=rnd(i+109)*700;
      jaggedRock(c,x,y,20+rnd(i+12)*28,10+rnd(i+21)*16,i);
    }
    // Ruined basalt shelves sit beside the molten channels.
    for(const [x,y,s] of [[286,95,34],[39,235,33],[282,577,31],[723,156,29],[962,497,31],[720,625,25]]) {
      ellipse(c,x+4,y+9,s*1.25,s*.5,'#0d111c9c');
      poly(c,[[x-s,y+8],[x-s*.65,y-s*.7],[x-s*.2,y-s*.65],[x,y-s*1.5],[x+s*.38,y-s*.9],[x+s,y+5],[x+s*.4,y+s*.4]],'#342732','#101422',3);
      poly(c,[[x,y-s*1.5],[x+s*.38,y-s*.9],[x+s,y+5],[x+s*.1,y-s*.05]],'#4d3039');
      c.beginPath();c.moveTo(x-2,y-s*1.1);c.lineTo(x+6,y-s*.6);c.lineTo(x-3,y-s*.18);c.lineTo(x+8,y+5);
      c.strokeStyle='#eb793d';c.lineWidth=2;c.stroke();
      haze(c,x,y-s*.25,s*1.4,'#ff7b2524');
    }
    // Thin hot seams connect the large channels to the cooled basalt banks.
    for(const [x,y,flip] of [[254,205,1],[250,498,-1],[744,264,-1],[751,589,1]]) {
      const points=[[x-31*flip,y-30],[x-10*flip,y-13],[x-17*flip,y+3],[x+9*flip,y+15],[x+23*flip,y+37]];
      curve(c,points);c.strokeStyle='#0c1420';c.lineWidth=8;c.stroke();
      curve(c,points);c.strokeStyle='#b94d31';c.lineWidth=3;c.stroke();
      curve(c,points);c.strokeStyle='#ed9d503b';c.lineWidth=1;c.stroke();
    }
  }
  function backdrop(c,mapId='ember') {
    let entry=backdrops.get(c.canvas);
    if(!entry){entry=new Map();backdrops.set(c.canvas,entry);}
    let cached=entry.get(mapId);
    const paint=mapId==='frost'?frostBackdrop:mapId==='abyss'?abyssBackdrop:volcanicBackdrop;
    if(!cached) {
      const doc=c.canvas&&c.canvas.ownerDocument;
      let surface;
      if(doc) {surface=doc.createElement('canvas');surface.width=W;surface.height=H;}
      else if(typeof OffscreenCanvas!=='undefined')surface=new OffscreenCanvas(W,H);
      if(surface) {paint(surface.getContext('2d'));cached=surface;entry.set(mapId,cached);}
    }
    if(cached)c.drawImage(cached,0,0);else paint(c);
  }

  // Banks remain stable; thin surface streams and crust travel visibly through
  // the entire river instead of merely blinking in a static orange channel.
  function riverX(y, side) {
    const x=151+Math.sin(y/107+side*.6)*43+Math.sin(y/49+side*.9)*12;
    return side?W-x:x;
  }
  function riverWidth(y, side) {
    return 53+Math.sin(y/93+side*.4)*10+24*Math.exp(-Math.pow((y-142)/80,2))+19*Math.exp(-Math.pow((y-541)/100,2));
  }
  function riverPath(c, side) {
    const left=[],right=[];
    for(let y=-60;y<=780;y+=35) {const x=riverX(y,side),r=riverWidth(y,side);left.push([x-r,y]);right.push([x+r,y]);}
    curve(c,left.concat(right.reverse()),true);
  }
  function flowingRibbon(c, side, y, length, offset, wiggle, tint, width, time) {
    const points=[];
    for(let j=0;j<=5;j++){const yy=y+j*length/5;points.push([riverX(yy,side)+offset+Math.sin(yy*.04+wiggle+time*.35)*4,yy]);}
    curve(c,points);c.strokeStyle=tint;c.lineWidth=width;c.lineCap='round';c.stroke();
  }
  function moltenRiver(c, side, time, quality) {
    const center=side?850:150;
    // The diffuse ember-red bank merges the hot river into cold basalt.
    riverPath(c,side);c.strokeStyle='#a63c2528';c.lineWidth=38;c.stroke();
    riverPath(c,side);c.strokeStyle='#6e2a29';c.lineWidth=11;c.stroke();
    const heat=c.createLinearGradient(center-100,0,center+100,0);
    heat.addColorStop(0,'#8d251e');heat.addColorStop(.17,'#d6431a');heat.addColorStop(.42,'#fa7924');heat.addColorStop(.65,'#ffb238');heat.addColorStop(.83,'#ea4d19');heat.addColorStop(1,'#87251e');
    riverPath(c,side);c.fillStyle=heat;c.fill();
    c.save();riverPath(c,side);c.clip();
    const bands=quality<.7?17:26;
    for(let i=0;i<bands;i++) {
      const seed=i+side*47, y=wrap(rnd(seed+44)*840+time*(11+rnd(seed+32)*17)*(side?-1:1),840)-70;
      const offset=(rnd(seed+21)-.5)*107,length=35+rnd(seed+12)*90;
      flowingRibbon(c,side,y,length,offset,seed,'#a92b1b55',11+rnd(seed+3)*16,time);
      flowingRibbon(c,side,y+5,length*.82,offset-2,seed,i%3===0?'#ffe893bf':'#ffcb4eb3',1.5+rnd(seed+4)*4,time);
      if(i%3===0)flowingRibbon(c,side,y+length*.2,length*.42,offset+7,seed,'#fff4bcd9',1.2,time);
    }
    // Rotating cooled crust rafts shear along the fluid, rimmed in orange.
    const rafts=quality<.7?9:15;
    for(let i=0;i<rafts;i++) {
      const n=i+side*31, y=wrap(rnd(n+311)*840+time*(8+rnd(n+112)*9)*(side?-1:1),840)-70;
      const x=riverX(y,side)+(rnd(n+88)-.5)*82,rx=8+rnd(n+8)*17,ry=9+rnd(n+41)*26;
      c.save();c.translate(x,y);c.rotate(Math.sin(time*.13+n)*.22+(rnd(n+33)-.5)*.8);
      const p=[];for(let j=0;j<8;j++){const a=j/8*TAU,s=.7+rnd(n*17+j)*.35;p.push([Math.cos(a)*rx*s,Math.sin(a)*ry*s]);}
      poly(c,p,'#70281f','#ff9d34',1.7);
      poly(c,p.map(v=>[v[0]*.83,v[1]*.84]),'#35232b','#a44227',1);
      c.beginPath();c.moveTo(-rx*.4,-ry*.2);c.lineTo(rx*.06,0);c.lineTo(-rx*.15,ry*.55);c.strokeStyle='#e9752f';c.lineWidth=1.2;c.stroke();c.restore();
    }
    const bubbles=quality<.7?7:12;
    for(let i=0;i<bubbles;i++) {
      const n=i+side*20, phase=wrap(time*.23+rnd(n+771),1),y=46+rnd(n+315)*610,x=riverX(y,side)+(rnd(n+141)-.5)*76;
      if(phase<.69) {
        const r=2+phase*10;
        ellipse(c,x,y,r,r*.62,'#cf4a20','#ffce61',1.4);
        c.beginPath();c.ellipse(x-1,y-1,r*.65,r*.33,0,Math.PI,Math.PI*1.75);c.strokeStyle='#fff1a5';c.lineWidth=1.3;c.stroke();
      } else {
        const burst=(phase-.69)/.31,r=8+burst*14;c.globalAlpha=1-burst;
        ellipse(c,x,y,r,r*.52,null,'#ffe58e',1.4);
        for(let j=0;j<3;j++){const a=j*2.094+n;ellipse(c,x+Math.cos(a)*r,y+Math.sin(a)*r*.5-burst*11,1.5,2.5,'#fff0a0');}
        c.globalAlpha=1;
      }
    }
    c.restore();
    riverPath(c,side);c.strokeStyle='#ffad483b';c.lineWidth=2;c.stroke();
    // A broad heat reflection breathes slowly over the bank rather than adding
    // more sparks. Its soft shape gives the river a luminous sense of volume.
    const glowY=side?540:148;
    c.save();c.translate(riverX(glowY,side),glowY);c.scale(1.35,.5);
    haze(c,0,0,110,`rgba(255,125,48,${.07+.025*Math.sin(time*.45+side)})`);c.restore();
    // A few bank stones overlap the edge and ground the river in the scene.
    for(let i=0;i<8;i++) {const y=37+i*89+side*12,x=riverX(y,side)+(i%2?1:-1)*(riverWidth(y,side)+5);jaggedRock(c,x,y,10+rnd(i+side*14)*10,8+rnd(i+60)*8,i+side*32);}
  }
  function volcanicAtmosphere(c,time,quality) {
    backdrop(c);moltenRiver(c,0,time,quality);moltenRiver(c,1,time,quality);
    // Slow smoke and small rising sparks: warm, luminous, never a strobe.
    const count=quality<.7?14:22;
    for(let i=0;i<count;i++) {
      const side=i%2,y=wrap(rnd(i+42)*780-time*(9+rnd(i+13)*13),780)-40;
      const x=riverX(y,side)+(rnd(i+55)-.5)*142+Math.sin(time*.7+i)*8;
      const opacity=.25+.4*(.5+.5*Math.sin(time*.65+i));
      c.globalAlpha=opacity;c.fillStyle=i%4===0?'#ffed9b':'#ff9a4b';
      c.beginPath();c.ellipse(x,y,1+rnd(i+2)*1.5,2+rnd(i+6)*2,Math.sin(i)*.3,0,TAU);c.fill();
      if(i%5===0){c.globalAlpha=.11;haze(c,x,y+4,10,'#ff882a');}
    }
    c.globalAlpha=1;
    for(let i=0;i<(quality<.7?4:6);i++) {
      const side=i%2,x=riverX(100+i*99,side)+Math.sin(time*.17+i)*21,y=90+i*104-Math.sin(time*.13+i)*12;
      c.save();c.translate(x,y);c.scale(1.5,.45);haze(c,0,0,67,'#b58b8517');c.restore();
    }
    const vignette=c.createRadialGradient(500,350,230,500,350,635);vignette.addColorStop(0,'transparent');vignette.addColorStop(1,'#080c1d6b');c.fillStyle=vignette;c.fillRect(0,0,W,H);
  }
  function underwaterLight(c,time,quality) {
    // Long shafts and moving, connected caustic loops reveal the depth of the
    // reef. The restrained palette keeps their contrast below the combat art.
    for(let side=0;side<2;side++) {
      const x=side?824:117,sway=Math.sin(time*.1+side)*15;
      const beam=c.createLinearGradient(x,0,x+75,690);beam.addColorStop(0,'#91e3cd16');beam.addColorStop(.55,'#58c5b60a');beam.addColorStop(1,'transparent');
      poly(c,[[x-53+sway,-10],[x+8+sway,-10],[x+128+sway,700],[x-72+sway,700]],beam);
    }
    const cells=quality<.7?6:10;
    for(let i=0;i<cells;i++) {
      const side=i%2,x=side?832:164,y=65+Math.floor(i/2)*147;
      const points=[];
      for(let j=0;j<10;j++) {
        const a=j/9*TAU,r=1+Math.sin(a*3+time*.32+i)*.12;
        points.push([x+Math.cos(a)*78*r+Math.sin(time*.18+i)*15,y+Math.sin(a)*30*r]);
      }
      curve(c,points);c.strokeStyle='#7fd6bf12';c.lineWidth=7;c.stroke();
      curve(c,points);c.strokeStyle='#a9e6cb39';c.lineWidth=1.1;c.stroke();
      if(i%2===0){curve(c,points.map(([px,py])=>[px+23,py+14]));c.strokeStyle='#75c9bd19';c.lineWidth=1;c.stroke();}
    }
    // Bubbles have a dark body and a crescent highlight instead of reading as
    // opaque particles. A few ordered trails establish an upward current.
    for(let trail=0;trail<4;trail++)for(let j=0;j<(quality<.7?3:5);j++) {
      const side=trail%2,n=trail*11+j,x=(side?900:95)+(trail>1?-20:22);
      const y=wrap(80+trail*117+j*142-time*(12+j*2),790)-45;
      const px=x+Math.sin(time*.37+j+trail)*12,r=2.3+rnd(n+419)*3.8;
      c.globalAlpha=.35+rnd(n+230)*.3;
      ellipse(c,px,y,r,r*1.14,'#102d363b','#9ddbd07d',.8);
      c.beginPath();c.ellipse(px-.3,y-.5,r*.65,r*.78,0,Math.PI,Math.PI*1.65);c.strokeStyle='#d2f3dc';c.lineWidth=.9;c.stroke();
    }
    c.globalAlpha=1;
    const tufts=quality<.7?4:6;
    for(let i=0;i<tufts;i++) {
      const x=i%2?986:15,y=139+Math.floor(i/2)*238;
      for(let j=0;j<3;j++) {
        const height=34+j*13,lean=Math.sin(time*.55+i+j*.6)*8;
        const points=[[x+j*5,y],[x+j*5+lean*.3,y-height*.5],[x+j*5+lean+6,y-height]];
        curve(c,points);c.strokeStyle='#092831';c.lineWidth=6;c.stroke();
        curve(c,points);c.strokeStyle=j%2?'#336f66':'#285750';c.lineWidth=2.5;c.stroke();
      }
    }
  }
  function abyssAtmosphere(c,time,quality) {
    backdrop(c,'abyss');underwaterLight(c,time,quality);
    const count=quality<.7?10:16;
    for(let i=0;i<count;i++) {
      const x=28+rnd(i+701)*944,y=wrap(rnd(i+44)*740-time*(2+rnd(i+77)*4),740)-20;
      const a=.16+.2*(.5+.5*Math.sin(time*.9+i));
      c.globalAlpha=a;ellipse(c,x+Math.sin(time*.32+i)*8,y,1.2+rnd(i+91)*2,1.2+rnd(i+91)*2,i%3?'#8ae5da':'#c9f0bd');
      if(i%4===0){c.globalAlpha=.18;haze(c,x,y,13,'#35d9cf');}
    }
    c.globalAlpha=1;
    for(let i=0;i<(quality<.7?6:9);i++) {
      const x=45+rnd(i+81)*910,y=45+rnd(i+181)*610,phase=wrap(time*.075+i*.187,1),r=10+phase*45;
      c.beginPath();c.ellipse(x,y,r,r*.29,-.19,.2,Math.PI*1.71);
      c.strokeStyle=`rgba(112,217,206,${.17*(1-phase)})`;c.lineWidth=1.1;c.stroke();
    }
    // Broad translucent currents and refracted light lace the dark water.
    for(let i=0;i<8;i++) {
      const side=i%2,x=side?805:190,y=55+Math.floor(i/2)*190;
      const points=[];for(let j=0;j<6;j++)points.push([x-140+j*53,y+Math.sin(j*.85+time*.24+i)*17+j*6]);
      curve(c,points);c.strokeStyle='#80d3ba0d';c.lineWidth=16;c.stroke();
      curve(c,points.map(p=>[p[0],p[1]+7]));c.strokeStyle='#8ce2c31c';c.lineWidth=1.2;c.stroke();
    }
    for(let i=0;i<4;i++){const x=i%2?840:160,y=i<2?150:560;c.save();c.translate(x+Math.sin(time*.15+i)*12,y);c.scale(1,.4);haze(c,0,0,126,'#2fc9b70d');c.restore();}
  }
  function iceReflections(c,time,quality) {
    for(let i=0;i<ICE_PLATES.length;i++) {
      if(quality<.7&&i===2)continue;
      const [x,y,rx,ry,n]=ICE_PLATES[i];
      c.save();poly(c,platePoints(x,y,rx,ry,n));c.clip();
      const sweep=x+Math.sin(time*.19+i)*rx*.8;
      const shine=c.createLinearGradient(sweep-38,y-ry,sweep+38,y+ry);
      shine.addColorStop(0,'transparent');shine.addColorStop(.43,'#b5d8e11c');shine.addColorStop(.51,'#e0f3ec34');shine.addColorStop(.57,'#a3c9dc16');shine.addColorStop(1,'transparent');
      c.fillStyle=shine;c.fillRect(x-rx,y-ry,rx*2,ry*2);c.restore();
    }
    // A handful of long wind strokes complements the snowfall without making
    // the entire screen busier. Snow skims the surface rather than pulsing.
    for(let i=0;i<(quality<.7?4:7);i++) {
      const side=i%2,x=side?815:167,y=wrap(49+i*123+time*(3+rnd(i+121)*3),790)-45;
      const drift=Math.sin(time*.32+i)*17;
      const points=[[x-70+drift,y+6],[x-28+drift,y-2],[x+13+drift,y+4],[x+60+drift,y-3]];
      curve(c,points);c.strokeStyle='#b8d6e313';c.lineWidth=10;c.stroke();
      curve(c,points);c.strokeStyle='#d6e9ed36';c.lineWidth=.8;c.stroke();
    }
  }
  function frostAtmosphere(c,time,quality) {
    backdrop(c,'frost');iceReflections(c,time,quality);
    // Aurora reflects in the frozen outskirts, preserving the muted dark ice.
    for(let side=0;side<2;side++) {
      const points=[];for(let j=0;j<9;j++){const x=side?720+j*40:-40+j*40,y=73+Math.sin(j*.52+time*.16+side)*35;points.push([x,y]);}
      curve(c,points);c.strokeStyle='#9adbc50a';c.lineWidth=43;c.stroke();
      curve(c,points.map(p=>[p[0],p[1]+14]));c.strokeStyle='#c6a6ff16';c.lineWidth=19;c.stroke();
      curve(c,points);c.strokeStyle='#a1f3d72c';c.lineWidth=2;c.stroke();
    }
    const count=quality<.7?18:28;
    for(let i=0;i<count;i++) {
      const x=wrap(rnd(i+13)*1060+time*(3+rnd(i+8)*4)+Math.sin(time*.31+i)*9,1060)-30;
      const y=wrap(rnd(i+71)*760+time*(4+rnd(i+4)*10),760)-30,size=.7+rnd(i+31)*1.65;
      c.globalAlpha=.23+rnd(i+16)*.5;ellipse(c,x,y,size,size*.7,'#e7f5ff');
      if(i%9===0){c.beginPath();c.moveTo(x-3,y);c.lineTo(x+3,y);c.moveTo(x,y-3);c.lineTo(x,y+3);c.strokeStyle='#f1f4ff';c.lineWidth=.6;c.stroke();}
    }
    c.globalAlpha=1;
    for(let i=0;i<6;i++) {
      const x=i%2?825:175,y=90+i*108;
      c.save();c.translate(x+Math.sin(time*.13+i)*27,y);c.scale(1.7,.3);haze(c,0,0,97,'#bfd7f619');c.restore();
    }
    for(let i=0;i<8;i++) {
      const x=30+rnd(i+531)*940,y=40+rnd(i+125)*620,a=.15+.16*(.5+.5*Math.sin(time*.46+i));
      c.globalAlpha=a;c.beginPath();c.moveTo(x-7,y);c.lineTo(x+7,y);c.moveTo(x,y-5);c.lineTo(x,y+5);c.strokeStyle='#dbedff';c.lineWidth=1;c.stroke();
    }
    c.globalAlpha=1;
  }
  function islandEdgeLight(c,mode,mapId) {
    const points=ISLANDS[mode]||ISLANDS[2];
    poly(c,points,null,'#02081558',18);
    const tint=mapId==='ember'?'#e69d632f':mapId==='frost'?'#c0e2ed48':'#6dc9b53b';
    poly(c,points,null,tint,3);
    const vignette=c.createRadialGradient(500,340,290,500,340,640);
    vignette.addColorStop(0,'transparent');vignette.addColorStop(1,'#03091659');
    c.fillStyle=vignette;c.fillRect(0,0,W,H);
  }
  function draw(c,state,options={}) {
    if(!c||!state)return;
    const time=options.reducedMotion?0:Math.max(0,Number(options.time??state.elapsed)||0);
    const quality=typeof options.quality==='number'?clamp(options.quality,.3,1):options.quality==='low'?.5:1;
    c.save();
    try {
      outsideIsland(c,state.mode);c.lineCap='round';c.lineJoin='round';
      if(state.mapId==='ember')volcanicAtmosphere(c,time,quality);
      else if(state.mapId==='frost')frostAtmosphere(c,time,quality);
      else abyssAtmosphere(c,time,quality);
      islandEdgeLight(c,state.mode,state.mapId);
    } finally {c.restore();}
  }
  const api=Object.freeze({draw});
  root.CastleEnvironment=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
