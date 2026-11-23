const TAU=Math.PI*2;
const DEG=Math.PI/180;
const MOON_RADIUS=1.055;
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const colors=['#b1c8db','#d5dde9','#ffffff','#f2cc9e','#bdaaf0'];

function randomSource(seed) {
  return ()=>{
    seed=(Math.imul(1664525,seed)+1013904223)>>>0;
    return seed/4294967296;
  };
}

export function eclipseObservation(offset) {
  const d=Math.hypot(offset,.012);
  if (d<=MOON_RADIUS-1) return {coverage:1,phase:'Totalité'};
  if (d>=MOON_RADIUS+1) return {coverage:0,phase:offset<0?'Avant le premier contact':'Après le dernier contact'};
  const moonSquared=MOON_RADIUS**2, distanceSquared=d*d;
  const a=Math.acos(clamp((distanceSquared+1-moonSquared)/(2*d),-1,1));
  const b=Math.acos(clamp((distanceSquared+moonSquared-1)/(2*d*MOON_RADIUS),-1,1));
  const chord=Math.sqrt(Math.max(0,(-d+1+MOON_RADIUS)*(d+1-MOON_RADIUS)*(d-1+MOON_RADIUS)*(d+1+MOON_RADIUS)));
  return {coverage:(a+moonSquared*b-.5*chord)/Math.PI,phase:offset<0?'Phase partielle entrante':'Phase partielle sortante'};
}

function createCachedCanvas(width,height=width) {
  const layer=document.createElement('canvas');
  layer.width=width;
  layer.height=height;
  return layer;
}

function starscape(width,height) {
  const layer=createCachedCanvas(width,height);
  const ctx=layer.getContext('2d');
  const backdrop=ctx.createLinearGradient(0,0,width,height);
  backdrop.addColorStop(0,'#050914');
  backdrop.addColorStop(.45,'#0a101e');
  backdrop.addColorStop(1,'#04070f');
  ctx.fillStyle=backdrop;
  ctx.fillRect(0,0,width,height);
  const random=randomSource(28211);
  ctx.save();
  ctx.globalCompositeOperation='screen';
  for (let i=0;i<120;i++) {
    const x=random()*width, h=random(), y=height*(.72-.45*x/width+(h-.5)*.42);
    const radius=(.1+random()*.24)*height;
    const haze=ctx.createRadialGradient(x,y,0,x,y,radius);
    const hue=i%4===0?'104,78,140':i%3===0?'53,88,131':'103,91,91';
    haze.addColorStop(0,'rgba('+hue+','+(random()*.05)+')');
    haze.addColorStop(1,'rgba('+hue+',0)');
    ctx.fillStyle=haze;
    ctx.fillRect(x-radius,y-radius,2*radius,2*radius);
  }
  ctx.restore();
  for (let i=0;i<Math.min(width*height/290,1050);i++) {
    const x=random()*width,y=random()*height, b=random();
    ctx.globalAlpha=.12+.8*b*b*b;
    ctx.fillStyle=colors[Math.floor(random()*colors.length)];
    const radius=.28+b*b*.85;
    ctx.beginPath();
    ctx.arc(x,y,radius,0,TAU);
    ctx.fill();
    if (b>.987) {
      ctx.globalAlpha=.12;
      ctx.fillRect(x-3.5,y-.35,7,.7);
      ctx.fillRect(x-.35,y-3.5,.7,7);
    }
  }
  ctx.globalAlpha=1;
  return layer;
}

function glow(ctx,x,y,radius,stops) {
  const fill=ctx.createRadialGradient(x,y,0,x,y,radius);
  for (const [at,color] of stops) fill.addColorStop(at,color);
  ctx.fillStyle=fill;
  ctx.fillRect(x-radius,y-radius,radius*2,radius*2);
}

function ellipse(ctx,x,y,rx,ry,start=0,end=TAU) {
  ctx.beginPath();
  ctx.ellipse(x,y,Math.max(.1,rx),Math.max(.1,ry),0,start,end);
}

function lensedDisk(ctx,radius,incline,age) {
  const foreshortening=Math.max(.035,Math.cos(incline));
  const lensStrength=Math.sin(incline);
  const shadow=radius*.30;
  ctx.rotate(-.11);
  glow(ctx,0,0,radius*1.24,[[0,'#cc49004e'],[.31,'#ef68004b'],[.55,'#e34e092e'],[1,'#ef6f1600']]);

  function disk(near) {
    const start=near?0:Math.PI;
    for (let ring=0;ring<58;ring++) {
      const t=1-ring/58;
      const distance=radius*(.315+.675*t);
      const turbulence=.48+.18*Math.sin(ring*4.6)+.20*Math.cos(ring*.48);
      for(let segment=0;segment<20;segment++) {
        const a=start+segment*Math.PI/20, b=a+Math.PI/20+.007, angle=(a+b)/2;
        const density=.64+.24*Math.sin(angle*4-t*18+age*.72/(.5+t))+.08*Math.sin(angle*23-t*17-age*.40);
        const doppler=.54+.46*(.5-.5*Math.cos(angle+.08)*lensStrength);
        const hue=22+27*(1-t);
        const intensity=19+(59-36*t)*doppler+density*6;
        ctx.strokeStyle='hsla('+hue+',97%,'+intensity+'%,'+((.24+.67*(1-t))*turbulence*density)+')';
        ctx.lineWidth=radius*(.007+.009*(1-t));
        ellipse(ctx,0,0,distance,distance*foreshortening,a,b);
        ctx.stroke();
      }
    }
  }
  disk(false);
  if (lensStrength>.035) {
    ctx.globalCompositeOperation='screen';
    for (let pass=0;pass<2;pass++) {
      const a=pass===0 ? Math.PI*1.06 : .14;
      const b=pass===0 ? Math.PI*1.94 : Math.PI-.14;
      const arc=ctx.createLinearGradient(-radius*.40,0,radius*.40,0);
      arc.addColorStop(0,'#ff753000');
      arc.addColorStop(.28,'#ec59286e');
      arc.addColorStop(.68,'#ffb061d4');
      arc.addColorStop(1,'#ed661000');
      ctx.strokeStyle=arc;
      for(let bloom=5;bloom>0;bloom--) {
        ctx.globalAlpha=(pass===0?.44:.19)*lensStrength/(bloom*.66+.5);
        ctx.lineWidth=Math.max(.9,radius*.023*bloom);
        ellipse(ctx,0,pass===0?-radius*.024:radius*.015,radius*.353,radius*(.326+.132*lensStrength),a,b);
        ctx.stroke();
      }
      ctx.globalAlpha=1;
      for (let i=0;i<34;i++) {
        const t=i/34;
        const width=radius*(.29+t*.106);
        const height=radius*(.296+t*.26*lensStrength);
        const luminousFlow=.67+.33*Math.sin(t*24+.52);
        const intensity=(1-t*.65)*lensStrength*luminousFlow*(pass===0?.94:.58);
        const light=ctx.createLinearGradient(-width,0,width,0);
        light.addColorStop(0,'rgba(255,106,33,'+(intensity*.18)+')');
        light.addColorStop(.34,'rgba(255,151,49,'+(intensity*.70)+')');
        light.addColorStop(.67,'rgba(255,222,132,'+intensity+')');
        light.addColorStop(1,'rgba(196,65,11,'+(intensity*.13)+')');
        ctx.strokeStyle=light;
        ctx.lineWidth=Math.max(.7,radius*.0084);
        ellipse(ctx,0,pass===0?-radius*t*.025:radius*t*.02,width,height,a,b);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation='source-over';
  }
  ctx.fillStyle='#010104';
  ellipse(ctx,0,0,shadow,shadow);
  ctx.fill();
  const photon=ctx.createLinearGradient(-shadow,-shadow,shadow,shadow);
  photon.addColorStop(0,'#df6d39');
  photon.addColorStop(.42,'#fff0ad');
  photon.addColorStop(.73,'#ed9249');
  photon.addColorStop(1,'#661c0d');
  ctx.strokeStyle=photon;
  ctx.lineWidth=Math.max(1,radius*.012);
  ctx.stroke();
  disk(true);
}

function makePhotosphere(size) {
  const surface=createCachedCanvas(size), ctx=surface.getContext('2d');
  const image=ctx.createImageData(size,size), data=image.data, half=size/2;
  const random=randomSource(2131);
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    const nx=(x+.5-half)/half,ny=(y+.5-half)/half,r2=nx*nx+ny*ny;
    if (r2>1) continue;
    const depth=Math.sqrt(1-r2);
    const longitude=Math.atan2(nx,depth);
    const cells=Math.sin(longitude*160+Math.sin(ny*160))*Math.cos(ny*220+Math.sin(longitude*185));
    const active=Math.exp(-((nx+.28)**2+(ny+.13)**2)*39);
    const spot=Math.exp(-((nx+.28)**2+(ny+.13)**2)*540);
    const light=clamp(.52+.47*depth+.078*cells+(random()-.5)*.11+active*.12-spot*.52);
    const index=4*(y*size+x);
    data[index]=231+24*light;
    data[index+1]=65+155*light;
    data[index+2]=16+101*light*light;
    data[index+3]=clamp((1-r2)*half)*255;
  }
  ctx.putImageData(image,0,0);
  return surface;
}

function solarEclipse(ctx,radius,offset,sun) {
  const {coverage}=eclipseObservation(offset), moonX=radius*offset, moonY=radius*.012;
  const blackout=clamp((coverage-.83)/.17);
  glow(ctx,0,0,radius*(3.0-.54*blackout),[[0,'#ff981e7d'],[.45,'rgba(255,142,18,'+(1-blackout)*.21+')'],[1,'#ee650000']]);
  if (blackout>.01) {
    ctx.globalCompositeOperation='screen';
    glow(ctx,0,0,radius*2.7,[[0,'#82a8e695'],[.31,'#d3e9ff6d'],[.40,'rgba(165,199,239,'+blackout*.23+')'],[1,'#7a9ae900']]);
    const random=randomSource(5061);
    for(let i=0;i<224;i++) {
      const angle=TAU*(i+random()*.7)/224;
      const streams=.42+.22*Math.cos(2*angle+.78)+.18*Math.cos(5*angle-1.7)+.12*Math.cos(9*angle+1);
      const length=radius*(.16+1.7*streams*random());
      const x=Math.cos(angle),y=Math.sin(angle), turn=.12*Math.sin(angle*3+.5);
      const edge=ctx.createLinearGradient(x*radius,y*radius,x*(radius+length),y*(radius+length));
      edge.addColorStop(0,'rgba(236,245,255,'+blackout*(.28+random()*.44)+')');
      edge.addColorStop(.40,'rgba(171,198,218,'+blackout*.18+')');
      edge.addColorStop(1,'#8bb0da00');
      ctx.strokeStyle=edge;
      ctx.lineWidth=Math.max(.6,radius*(.005+.008*random()));
      ctx.beginPath();
      ctx.moveTo(x*radius,y*radius);
      ctx.quadraticCurveTo(x*(radius+length*.5)-y*length*turn,y*(radius+length*.5)+x*length*turn,x*(radius+length)-y*length*turn*2,y*(radius+length)+x*length*turn*2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation='source-over';
    ctx.strokeStyle='rgba(247,164,188,'+blackout*.96+')';
    ctx.lineWidth=Math.max(1.2,radius*.023);
    ellipse(ctx,0,0,radius*1.066,radius*1.066);
    ctx.stroke();
  }
  ctx.drawImage(sun,-radius,-radius,2*radius,2*radius);
  const earthshine=ctx.createRadialGradient(moonX-radius*.45,moonY-radius*.2,0,moonX,moonY,radius*MOON_RADIUS);
  earthshine.addColorStop(0,'#151825');
  earthshine.addColorStop(.65,'#090d17');
  earthshine.addColorStop(1,'#030610');
  ctx.fillStyle=earthshine;
  ellipse(ctx,moonX,moonY,radius*MOON_RADIUS,radius*MOON_RADIUS);
  ctx.fill();
}

function saturnPhotosphere(size,tilt) {
  const surface=createCachedCanvas(size),ctx=surface.getContext('2d');
  const image=ctx.createImageData(size,size), data=image.data, half=size/2;
  const cosine=Math.cos(tilt),sine=Math.sin(tilt);
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    const nx=(x+.5-half)/half,ny=(y+.5-half)/half,z2=1-nx*nx-ny*ny;
    if(z2<=0) continue;
    const nz=Math.sqrt(z2);
    const latitude=ny*cosine+nz*sine;
    const ridges=.60+.13*Math.sin(latitude*27)+.10*Math.sin(latitude*56+.5*Math.sin(nx*16))
      +.09*Math.sin(latitude*105+.14*Math.sin(nx*19))+.05*Math.cos(latitude*203);
    const polar=.55*(clamp((Math.abs(latitude)-.72)/.29));
    const illumination=clamp(-.65*nx-.42*ny+.63*nz);
    const lit=(.13+.87*illumination)*(.76+.24*nz);
    const shadowPlane=(ny+.32*nz)<-.055 && (ny+.32*nz)>-.17 ? .76 : 1;
    const index=4*(y*size+x);
    data[index]=lit*shadowPlane*(166+86*ridges-40*polar);
    data[index+1]=lit*shadowPlane*(134+69*ridges+20*polar);
    data[index+2]=lit*shadowPlane*(103+73*ridges+54*polar);
    data[index+3]=clamp(z2*half)*255;
  }
  ctx.putImageData(image,0,0);
  return surface;
}

function saturnRings(ctx,radius,tilt,image,age) {
  const tiltSin=Math.sin(tilt);
  const thinness=Math.max(.007,tiltSin);
  ctx.rotate(-.32);
  function rings(near) {
    const a=near?0:Math.PI;
    const b=a+Math.PI;
    for (let band=0;band<117;band++) {
      const fraction=band/117, distance=radius*(1.26+fraction*1.03);
      const gap= fraction>.65 && fraction<.737 ? .06 : fraction<.22 ? .31 : 1;
      const belts=.62+.16*Math.cos(band*.49)+.10*Math.sin(band*3.52)+.08*Math.cos(band*.16);
      const opacity=gap*belts*clamp(.20+tiltSin*1.35);
      const warm=fraction<.65;
      const color=warm?'226,197,153':'191,180,162';
      const gradient=ctx.createLinearGradient(-distance,0,distance,0);
      gradient.addColorStop(0,'rgba('+color+','+opacity*.97+')');
      gradient.addColorStop(.56,'rgba('+color+','+opacity*.72+')');
      gradient.addColorStop(.78,'rgba('+color+','+opacity*(near?.70:.14)+')');
      gradient.addColorStop(1,'rgba('+color+','+opacity*.6+')');
      ctx.strokeStyle=gradient;
      ctx.lineWidth=Math.max(.37,radius*.009);
      ellipse(ctx,0,0,distance,distance*thinness,a,b);
      ctx.stroke();
    }
    ctx.strokeStyle='rgba(233,220,186,'+clamp(.26+tiltSin*.55)+')';
    ctx.lineWidth=Math.max(.55,radius*.0055);
    ellipse(ctx,0,0,2.34*radius,2.34*radius*thinness,a,b);
    ctx.stroke();
  }
  rings(false);
  glow(ctx,0,0,radius*1.16,[[.65,'#ffc87a00'],[.83,'#e4b47e20'],[1,'#e4b47e00']]);
  ctx.drawImage(image,-radius,-radius*.91,radius*2,radius*1.82);
  rings(true);
  const orbits=[[2.65,1.1,1.4],[3.02,5.1,2.3],[3.22,3.26,2.8]];
  for (const [r,phase,size] of orbits) {
    const angle=phase+age*.051/r, x=Math.cos(angle)*radius*r,y=Math.sin(angle)*radius*r*thinness;
    if (Math.hypot(x,y)<radius) continue;
    glow(ctx,x,y,size*3,[[0,'#f1dbc6aa'],[1,'#edd4ac00']]);
    ctx.fillStyle='#d9cfc1';
    ellipse(ctx,x,y,size,size);
    ctx.fill();
  }
}

export function createPhenomenaRenderer(canvas) {
  const ctx=canvas.getContext('2d',{alpha:false});
  let sky, sun;
  const saturn=new Map();
  return {
    draw(id,value,age) {
      const dpr=Math.min(window.devicePixelRatio || 1,1.75);
      const width=Math.round(canvas.clientWidth*dpr),height=Math.round(canvas.clientHeight*dpr);
      if (!width || !height) return;
      if (!sky || width!==canvas.width || height!==canvas.height) {
        canvas.width=width;canvas.height=height;
        sky=starscape(width,height);
      }
      ctx.drawImage(sky,0,0);
      ctx.save();
      ctx.translate(width*.5,height*.49);
      if (id==='eclipse') {
        sun ||= makePhotosphere(256);
        solarEclipse(ctx,Math.min(width*.15,height*.245),value,sun);
      } else if (id==='rings') {
        const key=Math.round(value/4);
        if (!saturn.has(key)) saturn.set(key,saturnPhotosphere(205,key*4*DEG));
        saturnRings(ctx,Math.min(width*.194,height*.31),value*DEG,saturn.get(key),age);
      } else lensedDisk(ctx,Math.min(width*.47,height*.57),value*DEG,age);
      ctx.restore();
    }
  };
}
