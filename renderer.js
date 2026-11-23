import {quadVertex, skyFragment, bodyFragment, galaxyFragment, starVertex, starFragment, cloudFragment, memberVertex, memberFragment} from './shaders.js';
import {isDeep, hasVolume, hasPhotoDetail, deepParticles, deepPoints2D, CanvasVolumes, photoRelief} from './deep-render.js';
import { assetUrl } from './assets.js';
import { BodyLabels } from './body-labels.js';

const LY = 9460730472580.8;
const TAU = 2 * Math.PI;
const STAR_COUNT = 3000;
const FULL = [-1, -1, 1, 1];
const types = {earth:1, moon:2, mercury:3, mars:4, jupiter:5, saturn:6, uranus:7, neptune:8, venus:11};
const materials = {haze:10, gas:7, rock:3, lava:12, ice:13, desert:14, ocean:15};
const moonMaps = new Set(['moon','io','europa','ganymede','callisto','titan','enceladus']);
const galaxyAxes = {andromeda:[-.39,.85,.36], 'milky-way':[-.46,.61,.64], whirlpool:[-.19,.24,.95]};
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const minus = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const unit = a => { const d=Math.hypot(...a)||1; return a.map(n=>n/d); };
const clamp = (a,min,max) => Math.max(min,Math.min(max,a));
const rgb = s => [1,3,5].map(index=>parseInt(s.slice(index,index+2),16)/255);
const powerCanvas = (w,h) => Object.assign(document.createElement('canvas'),{width:w,height:h});
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

// Obliquity is relative to the orbital plane. The atlas illustrates the
// azimuth of each pole; its origin of longitude is shared by both renderers.
const poleAzimuth = {earth:.60, moon:.60, saturn:1.94, jupiter:.80, uranus:.27, neptune:2.10, mars:2.75, sun:.86};
const cachedAxes = new WeakMap();
function surfaceAxes(obj) {
  const previous = cachedAxes.get(obj);
  if (previous) return previous;
  const baseline = obj.orbitNormal || [0,1,0];
  let tilt = obj.axialTiltDeg ?? 0;
  if (tilt > 90) tilt -= 180; // Retrograde motion is already in spinAngle.
  tilt *= Math.PI / 180;
  const az = poleAzimuth[obj.id] ?? 1;
  const planeX = unit(cross(baseline,Math.abs(baseline[2])>.95?[1,0,0]:[0,0,1]));
  const planeZ = cross(planeX,baseline);
  const pole = obj.id==='saturn' && obj.axialTiltDeg==null ? unit([-.14,.92,.37])
    : unit(baseline.map((n,i)=>n*Math.cos(tilt)+(planeX[i]*Math.cos(az)+planeZ[i]*Math.sin(az))*Math.sin(tilt)));
  const east = unit(cross(pole,Math.abs(pole[2])>.98?[1,0,0]:[0,0,1]));
  const meridian = cross(east,pole);
  const matrix = [east[0],pole[0],meridian[0],east[1],pole[1],meridian[1],east[2],pole[2],meridian[2]];
  const axes = {east,pole,meridian,matrix};
  cachedAxes.set(obj,axes);
  return axes;
}

export function geographicDirection(body,latitude,longitude) {
  const {east,pole,meridian}=surfaceAxes(body);
  const longitudeInWorld=longitude*Math.PI/180+(body.spinAngle||0);
  const latitudeRad=latitude*Math.PI/180;
  const x=Math.cos(latitudeRad)*Math.sin(longitudeInWorld);
  const y=Math.sin(latitudeRad);
  const z=Math.cos(latitudeRad)*Math.cos(longitudeInWorld);
  return [0,1,2].map(i=>east[i]*x+pole[i]*y+meridian[i]*z);
}

function randomSource(seed) {
  let state=seed;
  return () => { state=(Math.imul(1664525,state)+1013904223)>>>0; return state/4294967296; };
}
function noiseSource(random) {
  const table=Float32Array.from({length:65536},random);
  return (x,y) => {
    const ix=Math.floor(x), iy=Math.floor(y);
    let a=x-ix,b=y-iy;
    a=a*a*(3-2*a); b=b*b*(3-2*b);
    const r0=(iy&255)*256,r1=((iy+1)&255)*256, x0=ix&255,x1=(ix+1)&255;
    return (table[r0+x0]*(1-a)+table[r0+x1]*a)*(1-b)+(table[r1+x0]*(1-a)+table[r1+x1]*a)*b;
  };
}
function skyMap() {
  const w=256,h=128,c=powerCanvas(w,h),ctx=c.getContext('2d');
  const random=randomSource(85012), noise=noiseSource(random), image=ctx.createImageData(w,h);
  // An inconspicuous star cloud follows a great circle. Periodic noise avoids a seam.
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const lon=(x/w-.5)*TAU, lat=(.5-y/h)*Math.PI;
    const nx=25+Math.cos(lon)*7, ny=18+Math.sin(lon)*7+lat*5;
    const fog=noise(nx,ny)*.52+noise(nx*2,ny*2)*.29+noise(nx*4,ny*4)*.13+noise(nx*8,ny*8)*.06;
    const belt=lat-(.39*Math.sin(lon+.62)+.07*Math.sin(2*lon));
    const lane=belt-.018*Math.sin(lon*3)-.09*(fog-.5);
    const density=Math.exp(-belt*belt*13)*(.20+.80*noise(nx*.43,ny*.43));
    const dust=1-.62*Math.exp(-lane*lane*970);
    const light=density*dust*Math.pow(Math.max(0,fog-.18),1.5)*96;
    const i=(y*w+x)*4, grain=random()*1.8;
    image.data[i]=4+grain+light*.73;
    image.data[i+1]=7+grain+light*.82;
    image.data[i+2]=13+grain+light*1.04;
    image.data[i+3]=255;
  }
  ctx.putImageData(image,0,0);
  for(let i=0;i<480;i++) {
    const x=random()*w,longitude=(x/w-.5)*TAU;
    const y=h*(.5-(.39*Math.sin(longitude+.62)+.07*Math.sin(2*longitude)+(random()+random()+random()-1.5)*.33)/Math.PI);
    ctx.fillStyle='rgba(202,211,228,'+(.012+random()*.045)+')';
    ctx.fillRect(x,y,.3+random()*.65,.3+random()*.65);
  }
  return c;
}
function stars() {
  const random=randomSource(23717),result=new Float32Array(STAR_COUNT*6);
  for(let i=0;i<STAR_COUNT;i++) {
    const phi=random()*TAU,z=random()*2-1, r=Math.sqrt(1-z*z),d=.09+Math.cbrt(random())*3.5;
    const brightness=.19+Math.pow(random(),5)*1.15;
    result.set([d*r*Math.cos(phi),d*z,d*r*Math.sin(phi),brightness*d,random(),.5+.5*random()],i*6);
  }
  return result;
}

// A large sunlit disk needs a shorter exposure than a deep-sky field.
// Work from its illuminated fraction so the background returns on the night side.
function skyExposure(items,eye,sun,shortEdge) {
  let brightest=0;
  for(const {obj,bounds,visible,radius} of items) {
    if(!bounds || !visible || radius<4 || !['planet','moon','star','dwarf','asteroid'].includes(obj.kind)) continue;
    const disk=clamp(radius/(shortEdge*.32),0,1);
    const phase=obj.kind==='star'?1:(1+dot(unit(minus(eye,obj.position)),unit(minus(obj.lightPosition||sun,obj.position))))*.5;
    brightest=Math.max(brightest,disk*phase);
  }
  return .64-.36*brightest;
}

function camera(view,w,h,options) {
  const cy=Math.cos(view.yaw),sy=Math.sin(view.yaw),cp=Math.cos(view.pitch),sp=Math.sin(view.pitch);
  const right=[cy,0,sy], up=[-sy*sp,cp,cy*sp], forward=[sy*cp,sp,-cy*cp];
  const scale=Math.tan(view.fov*.5);
  return {right, up, forward, scale:[w/h*scale,scale], w,h,
    cx:options.centerX??.5, cy:options.centerY??.5,
    matrix:[...right,...up,...forward],
    inverse:[right[0],up[0],forward[0],right[1],up[1],forward[1],right[2],up[2],forward[2]]};
}
export function directionAtPixel(view,width,height,x,y,options={}) {
  const cam = camera(view,width,height,options);
  const dx = (x/width-cam.cx)*2*cam.scale[0];
  const dy = (cam.cy-y/height)*2*cam.scale[1];
  return unit(cam.forward.map((component,axis)=>component+dx*cam.right[axis]+dy*cam.up[axis]));
}
function project(obj, eye, cam) {
  const relative=minus(obj.position,eye), world=relative.map(v=>v/obj.radius);
  const center=[dot(world,cam.right),dot(world,cam.up),dot(world,cam.forward)];
  const distance=Math.hypot(...world), [cx,cy,cz]=center;
  const focal=cam.h/(2*cam.scale[1]);
  const x=cam.cx*cam.w+cx/cz*focal, y=cam.cy*cam.h-cy/cz*focal;
  const radius=focal/Math.sqrt(Math.max(.00001,cz*cz-1));
  // Tangents to a sphere on each axis give tight bounds even off the optical axis.
  let extent=obj.id==='saturn'?2.33:obj.kind==='star'?3.2:obj.kind==='galaxy'?1.31:1.10;
  let bounds=FULL;
  if(cz < -extent) bounds=null;
  else if(cz > extent) {
    const tangent=(v,scale,axis) => {
      const disc=extent*Math.sqrt(v*v+cz*cz-extent*extent), denom=(cz*cz-extent*extent)*scale;
      return [(v*cz-disc)/denom+axis,(v*cz+disc)/denom+axis];
    };
    const X=tangent(cx,cam.scale[0],cam.cx*2-1), Y=tangent(cy,cam.scale[1],1-cam.cy*2);
    bounds=[X[0],Y[0],X[1],Y[1]];
    if(bounds[2]<-1 || bounds[0]>1 || bounds[3]<-1 || bounds[1]>1) bounds=null;
  }
  let labelRise=radius;
  if (obj.id==='saturn' && bounds && cz>2.3 && radius>3) {
    const {east,meridian}=surfaceAxes(obj);
    for (let i=0;i<20;i++) {
      const angle=TAU*i/20, a=2.27*Math.cos(angle), b=2.27*Math.sin(angle);
      const up=cy+a*dot(east,cam.up)+b*dot(meridian,cam.up);
      const depth=cz+a*dot(east,cam.forward)+b*dot(meridian,cam.forward);
      labelRise=Math.max(labelRise,focal*(up/depth-cy/cz));
    }
  }
  return {obj, center,distance,range:distance*obj.radius, x,y,radius,labelRise,bounds,
    visible:cz>0 && x>=0 && x<cam.w && y>=0 && y<cam.h};
}

function program(gl,vertex,fragment) {
  const p=gl.createProgram();
  for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
    const shader=gl.createShader(type);
    gl.shaderSource(shader,source); gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
    gl.attachShader(p,shader); gl.deleteShader(shader);
  }
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
  const uniforms={};
  const count=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);
  for(let i=0;i<count;i++) {
    const name=gl.getActiveUniform(p,i).name;
    uniforms[name]=gl.getUniformLocation(p,name);
  }
  const attributes={};
  for(let i=0;i<gl.getProgramParameter(p,gl.ACTIVE_ATTRIBUTES);i++) {
    const name=gl.getActiveAttrib(p,i).name;
    attributes[name]=gl.getAttribLocation(p,name);
  }
  return {p,u:uniforms,a:attributes};
}
function buffer(gl,data) {
  const b=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,b); gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW); return b;
}
function texture(gl,image) {
  const t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
  const powerOfTwo = value => value>0 && (value&(value-1))===0;
  const mip = powerOfTwo(image.width)&&powerOfTwo(image.height);
  if(mip) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,mip?gl.LINEAR_MIPMAP_LINEAR:gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return t;
}
class SpaceGL {
  constructor(gl,sky,catalog) {
    this.gl=gl;
    this.sky=program(gl,quadVertex,skyFragment);
    this.body=program(gl,quadVertex,bodyFragment);
    this.galaxy=program(gl,quadVertex,galaxyFragment);
    this.stars=program(gl,starVertex,starFragment);
    this.cloud=program(gl,quadVertex,cloudFragment);
    this.members=program(gl,memberVertex,memberFragment);
    this.memberBuffers=new Map();
    this.corners=buffer(gl,new Float32Array([0,0,1,0,0,1,1,1]));
    this.catalog=buffer(gl,catalog);
    this.skyMap=texture(gl,sky); this.blank=texture(gl,powerCanvas(1,1));
    this.maps=new Map();
  }
  loadMap(id,image) {
    this.maps.set(id,texture(this.gl,image));
  }
  useQuad(shader,cam) {
    const gl=this.gl, {p,u,a}=shader;
    gl.useProgram(p); gl.bindBuffer(gl.ARRAY_BUFFER,this.corners);
    gl.enableVertexAttribArray(a.aCorner); gl.vertexAttribPointer(a.aCorner,2,gl.FLOAT,false,0,0);
    gl.uniformMatrix3fv(u.uToWorld,false,cam.matrix);
    gl.uniform2fv(u.uScale,cam.scale); gl.uniform2f(u.uAxis,cam.cx*2-1,1-cam.cy*2);
    return u;
  }
  drawDeep(frame,item) {
    const {gl}=this,{cam,dpr}=frame,{obj,center,bounds,radius}=item;
    gl.blendFunc(gl.ONE,gl.ONE);
    const map=this.maps.get(obj.id+'-volume');
    if(map && radius>=1.0) {
      const u=this.useQuad(this.cloud,cam);
      gl.uniform4fv(u.uBounds,bounds);gl.uniform3fv(u.uCenter,center);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,map);gl.uniform1i(u.uVolume,0);
      const detail=this.maps.get(obj.id+'-detail');
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,detail||this.blank);gl.uniform1i(u.uDetail,1);
      gl.uniform1f(u.uDetailReady,detail?1:0);gl.activeTexture(gl.TEXTURE0);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    }
    const points=deepParticles(obj),{p,a,u}=this.members;
    if(!this.memberBuffers.has(obj.id)) this.memberBuffers.set(obj.id,buffer(gl,points));
    gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,this.memberBuffers.get(obj.id));
    const step=radius<7?12:radius<22?4:1;
    // Keep the stride within WebGL 1's 255-byte limit for distant groups.
    const stride=step>4?4:step;
    gl.enableVertexAttribArray(a.aMember);gl.vertexAttribPointer(a.aMember,4,gl.FLOAT,false,32*stride,0);
    gl.enableVertexAttribArray(a.aLight);gl.vertexAttribPointer(a.aLight,4,gl.FLOAT,false,32*stride,16);
    gl.uniformMatrix3fv(u.uFromWorld,false,cam.inverse);gl.uniform3fv(u.uCenter,center);
    gl.uniform2fv(u.uScale,cam.scale);gl.uniform2f(u.uAxis,cam.cx*2-1,1-cam.cy*2);
    gl.uniform1f(u.uPixel,dpr);gl.uniform1f(u.uFocal,cam.h/(2*cam.scale[1]));
    gl.uniform1f(u.uFade,clamp(radius/23,.04,1));
    gl.drawArrays(gl.POINTS,0,Math.floor(points.length/8/step));
    gl.disableVertexAttribArray(a.aMember);gl.disableVertexAttribArray(a.aLight);
  }
  draw(frame) {
    const {gl}=this,{cam,view,objects,local,starEye,farEye,dpr,sun}=frame;
    gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    let u=this.useQuad(this.sky,cam);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,this.maps.get('galactic-sky')||this.skyMap);
    gl.uniform1i(u.uSky,0); gl.uniform1f(u.uLocal,local*frame.exposure);
    gl.uniform4fv(u.uBounds,FULL); gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.useProgram(this.stars.p); const a=this.stars.a; u=this.stars.u;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.catalog);
    gl.enableVertexAttribArray(a.aStar); gl.vertexAttribPointer(a.aStar,4,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(a.aTone); gl.vertexAttribPointer(a.aTone,2,gl.FLOAT,false,24,16);
    gl.uniformMatrix3fv(u.uFromWorld,false,cam.inverse);
    gl.uniform2fv(u.uScale,cam.scale); gl.uniform2f(u.uAxis,cam.cx*2-1,1-cam.cy*2); gl.uniform1f(u.uPixel,dpr);
    gl.uniform1f(u.uTransit,frame.transit);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
    for(const [eye,brightness,count] of [[starEye,local,frame.starCount],[farEye,.34,Math.floor(frame.starCount/8)]]) {
      if(brightness<=.01) continue;
      gl.uniform3fv(u.uEye,eye); gl.uniform1f(u.uLocal,brightness*(.54+.65*frame.exposure)); gl.drawArrays(gl.POINTS,0,count);
    }
    gl.disableVertexAttribArray(a.aTone); gl.disableVertexAttribArray(a.aStar);
    let previous=null;
    for(const item of objects) {
      const {obj,bounds,center,radius,distance}=item;
      if(!bounds || radius<.35) continue;
      if(isDeep(obj)) {this.drawDeep(frame,item);previous=null;continue;}
      if(obj.kind==='galaxy' && distance<.68) continue;
      const gal=obj.kind==='galaxy', shader=gal?this.galaxy:this.body;
      if(shader!==previous) {
        u=this.useQuad(shader,cam);
        previous=shader;
        gl.blendFunc(gal?gl.ONE:gl.SRC_ALPHA,gal?gl.ONE:gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.uniform4fv(u.uBounds,bounds); gl.uniform3fv(u.uCenter,center);
      if(gal) {
        const disk=this.maps.get(obj.id);
        gl.bindTexture(gl.TEXTURE_2D,disk||this.blank);
        gl.uniform1i(u.uDiskMap,0);
        gl.uniform1f(u.uDiskReady,disk?1:0);
        gl.uniform3fv(u.uDiskNormal,unit(galaxyAxes[obj.id]||galaxyAxes.whirlpool));
        gl.uniform1f(u.uStyle,obj.id==='andromeda'?1:.6);
      }
      else {
        const map=this.maps.get(obj.id==='earth'?'earth-land':obj.id);
        gl.bindTexture(gl.TEXTURE_2D,map||this.blank); gl.uniform1i(u.uEarth,0);
        const weather=this.maps.get('earth-weather'), night=this.maps.get('earth-night');
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,weather||this.blank); gl.uniform1i(u.uWeather,1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,night||this.blank); gl.uniform1i(u.uNight,2);
        gl.activeTexture(gl.TEXTURE0); gl.uniform2f(u.uLayerReady,weather?1:0,night?1:0);
        gl.uniform1f(u.uEarthReady,map?1:0);
        const axes = surfaceAxes(obj);
        gl.uniformMatrix3fv(u.uBodyFrame,false,axes.matrix);
        gl.uniform3fv(u.uPole,axes.pole);
        gl.uniform1f(u.uSpin,-(obj.spinAngle ?? frame.fallbackSpin));
        gl.uniform1f(u.uCloudDrift,frame.cloudDrift);
        gl.uniform1f(u.uVenusWind,frame.venusWind); gl.uniform1f(u.uPixelWidth,1/(radius*dpr));
        const surfaceType = moonMaps.has(obj.id) && obj.material!=='haze'?2:materials[obj.material] ?? types[obj.id] ?? 0;
        gl.uniform1f(u.uType,obj.kind==='star'?9:surfaceType);
        gl.uniform1f(u.uLunarDisk,obj.id==='moon'||obj.id==='mercury'?1:0);
        gl.uniform1f(u.uSolarDisk,obj.id==='sun'?1:0);
        const lightSource=frame.earthSurvey && obj.id==='earth' ? view.position : obj.lightPosition || sun;
        gl.uniform3fv(u.uColor,rgb(obj.color)); gl.uniform3fv(u.uLight,unit(minus(lightSource,obj.position)));
      }
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    }
  }
}

// Canvas 2D retains the same spatial projection on machines without accelerated graphics.
class Space2D {
  constructor(ctx,sky,catalog) {
    this.ctx=ctx; this.sky=sky; this.catalog=catalog;
    this.sprites=new Map(); this.maps=new Map(); this.noise=noiseSource(randomSource(18591));
    this.volumes=new CanvasVolumes();
  }
  loadMap(id,image) {
    if(id.endsWith('-volume')) { this.volumes.load(id.slice(0,-7),image);return; }
    if(id.endsWith('-detail')) {this.volumes.loadDetail(id.slice(0,-7),image);return;}
    if(id==='galactic-sky') {this.sky=image; return;}
    if(Object.hasOwn(galaxyAxes,id)) {this.sprites.set(id,{sprite:image});return;}
    const width=Math.min(2048,image.width), map=powerCanvas(width,Math.round(width*image.height/image.width)),ctx=map.getContext('2d');
    ctx.drawImage(image,0,0,map.width,map.height);
    this.maps.set(id,ctx.getImageData(0,0,map.width,map.height));
    this.sprites.delete(id.startsWith('earth-')?'earth':id);
  }
  globe(frame,item,size) {
    const {cam,sun}=frame,{obj}=item;
    const lightSource=frame.earthSurvey && obj.id==='earth' ? frame.view.position : obj.lightPosition || sun;
    const localLight=unit(minus(lightSource,obj.position));
    const spin=-(obj.spinAngle ?? frame.fallbackSpin), axes=surfaceAxes(obj);
    const key=[size,...cam.matrix.map(v=>Math.round(v*65)),...localLight.map(v=>Math.round(v*90)),
      Math.round(spin*100),obj.id==='earth'?Math.round(frame.cloudDrift*110):obj.id==='venus'?Math.round(frame.venusWind*68):0].join(',');
    const previous=this.sprites.get(obj.id);
    if(previous?.key===key) return previous.sprite;
    const c=powerCanvas(size,size), ctx=c.getContext('2d'), data=ctx.createImageData(size,size);
    const color=rgb(obj.color), map=this.maps.get(obj.id==='earth'?'earth-land':obj.id), noise=this.noise;
    const weather=this.maps.get('earth-weather'),night=this.maps.get('earth-night');
    const scalar=(texture,s,t) => {
      if(!texture) return 0;
      let sx=(s-Math.floor(s))*texture.width, sy=clamp(t,0,.999999)*texture.height;
      const ix=Math.floor(sx), iy=Math.floor(sy), a=(iy*texture.width+ix)*4;
      const b=(iy*texture.width+(ix+1)%texture.width)*4;
      const row=Math.min(iy+1,texture.height-1)-iy;
      sx-=ix;sy-=iy;
      return ((texture.data[a]*(1-sx)+texture.data[b]*sx)*(1-sy)
        +(texture.data[a+row*texture.width*4]*(1-sx)+texture.data[b+row*texture.width*4]*sx)*sy)/255;
    };
    const ringSun=obj.id==='saturn'?dot(axes.pole,localLight):0;
    for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
      const a=(x+.5)/size*2-1,b=1-(y+.5)/size*2, r2=a*a+b*b;
      if(r2>=1) continue;
      const z=Math.sqrt(1-r2);
      const nx=a*cam.right[0]+b*cam.up[0]-z*cam.forward[0],
            ny=a*cam.right[1]+b*cam.up[1]-z*cam.forward[1],
            nz=a*cam.right[2]+b*cam.up[2]-z*cam.forward[2];
      const localX = nx*axes.east[0]+ny*axes.east[1]+nz*axes.east[2];
      const localY = nx*axes.pole[0]+ny*axes.pole[1]+nz*axes.pole[2];
      const localZ = nx*axes.meridian[0]+ny*axes.meridian[1]+nz*axes.meridian[2];
      const longitude=Math.atan2(localX,localZ);
      const s=((.5+(longitude+spin)/TAU)%1+1)%1, t=.5-Math.asin(clamp(localY,-1,1))/Math.PI;
      let red=color[0], green=color[1], blue=color[2];
      let grain=noise(s*47,t*30);
      const light=nx*localLight[0]+ny*localLight[1]+nz*localLight[2];
      let lighting=.045+.955*Math.pow(Math.max(0,light),.68);
      if(obj.id==='moon'||obj.id==='mercury') {
        const incidence=Math.max(0,light);
        const lunarDisk=2*incidence/Math.max(.003,incidence+z);
        lighting=.018+.982*Math.pow(.65*lunarDisk+.35*incidence,.65);
      }
      if(map) {
        const index=(Math.min(map.height-1,Math.floor(t*map.height))*map.width+Math.floor(s*map.width))*4;
        red=map.data[index]/255; green=map.data[index+1]/255; blue=map.data[index+2]/255;
      } else if(obj.id==='earth') {
        const land=noise(s*14,t*8)*.72+grain*.28>.53;
        red=land?.35:.045; green=land?.41:.19; blue=land?.24:.33;
        const clouds=clamp((grain+noise(s*16,t*18)-1.2)*1.5,0,.85);
        red+=clouds*(1-red); green+=clouds*(1-green); blue+=clouds*(1-blue);
      } else if(['lava','ice','desert','ocean'].includes(obj.material)) {
        const large=noise(localX*5+localZ*2+11,localY*6+localZ*3+29);
        const fissure=Math.abs(large-.52+.105*(grain-.5)), c=clamp((.045-fissure)/.045,0,1);
        if(obj.material==='lava') {
          const glow=c*c*(.75+.25*grain);
          red=.19+.24*large+glow*1.8;green=.095+.09*large+glow*.59;blue=.09+.03*large;
          lighting=Math.max(lighting,glow*.9);
        } else if(obj.material==='ice') {
          red=.55+.27*large-c*.30;green=.71+.22*large-c*.18;blue=.82+.17*large-c*.07;
        } else if(obj.material==='ocean') {
          red=.044+.1*large;green=.17+.18*large;blue=.33+.28*large;
        } else {
          const strata=.10*Math.sin(41*localY+large*16+grain*1.1);
          red*=.77+.40*large+strata;green*=.70+.45*large+strata;blue*=.69+.42*large+strata;
        }
      } else if(obj.material==='haze') {
        red=.86+.025*ny; green=.63+.022*ny; blue=.34+.032*ny;
      } else if(obj.id==='venus') {
        const drift=(longitude+frame.venusWind)/TAU;
        const eddy=noise((Math.cos(drift*TAU)+1)*4+t*6,(Math.sin(drift*TAU)+1)*4+t*18);
        const clouds=.77+.15*eddy+.07*Math.sin(localY*18+eddy*5);
        red=.97*clouds;green=.84*clouds;blue=.63*clouds;
      } else if(obj.id==='saturn'||obj.id==='jupiter'||obj.id==='uranus'||obj.id==='neptune'||obj.material==='gas') {
        const contrast=obj.id==='uranus'?.038:obj.id==='neptune'?.092:.22;
        const band=.88+contrast*Math.sin(localY*49+grain*1.4)+.035*Math.sin(localY*123);
        red*=band; green*=band*.97; blue*=band*.93;
      } else if(obj.kind==='star') {
        lighting=obj.id==='sun'?(.42+.58*z)*(.98+.04*grain):(.80+.14*z+.08*grain);
        blue+=.07*grain;
      } else {
        lighting*=.73+.28*grain+.20*noise(s*146,t*81);
      }
      if(obj.id==='earth') {
        const sea=blue>red*1.38&&blue>green*1.05;
        const wind=frame.cloudDrift/TAU;
        const clouds=clamp((scalar(weather,s+wind,t)-.09)/.91,0,1);
        const shadow=clamp((scalar(weather,s+wind+.0029*localLight[0],t-.0015*localLight[1])-.09)/.91,0,1);
        lighting=(.034+.99*Math.pow(Math.max(light,0),.53))*(1-.37*shadow*clamp(light*6+.4,0,1));
        const litCloud=Math.pow(Math.max(light,0),.45);
        const cloudOpacity=clouds*clouds*(3-2*clouds)*.95;
        let spec=0;
        if(sea) {
          const reflection = Math.max(0,2*light*z+dot(localLight,cam.forward));
          spec=(.21*Math.pow(reflection,85)+.05*Math.pow(reflection,16))*clamp(light*6,0,1);
        }
        const cities=Math.pow(scalar(night,s,t),.77)*clamp((.025-light)/.285,0,1)*.91;
        red=(red*lighting+spec+cities+.003)*(1-cloudOpacity)+(.055+.945*litCloud)*cloudOpacity;
        green=(green*lighting+spec*.89+cities*.68+.009)*(1-cloudOpacity)+(.08+.905*litCloud)*cloudOpacity;
        blue=(blue*lighting+spec*.72+cities*.31+.021)*(1-cloudOpacity)+(.115+.835*litCloud)*cloudOpacity;
        lighting=1;
      }
      if(obj.material==='haze') {
        const fringe=Math.pow(1-z,3.0)*(.06+.45*clamp(light+.3,0,1));
        lighting=.07+.94*Math.pow(Math.max(light,0),.49);
        red=red*lighting+fringe*.75;green=green*lighting+fringe*.60;blue=blue*lighting+fringe*.38;
        lighting=1;
      }
      if(Math.abs(ringSun)>.015 && localY*ringSun<0) {
        const crossing=-localY/ringSun;
        const ring=Math.sqrt(1+2*crossing*light+crossing*crossing);
        if(ring>1.24 && ring<2.26 && (ring<1.94 || ring>1.99)) {
          lighting*=ring<1.52?.73:ring<1.94?.30:.45;
        }
      }
      const rim=obj.id==='earth'?Math.pow(1-z,2.9)*(.03+.64*clamp((light+.23)/.63,0,1)):0;
      const i=(y*size+x)*4;
      data.data[i]=(red*lighting+rim*.2)*255;
      data.data[i+1]=(green*lighting+rim*.49)*255;
      data.data[i+2]=(blue*lighting+rim*.85)*255;
      data.data[i+3]=clamp((1-r2)*size*.7,0,1)*255;
    }
    ctx.putImageData(data,0,0); this.sprites.set(obj.id,{key,sprite:c}); return c;
  }
  spiral(id) {
    const prev=this.sprites.get(id);
    if(prev) return prev.sprite;
    const c=powerCanvas(500,500),ctx=c.getContext('2d'), random=randomSource(id==='andromeda'?47:88);
    const glow=ctx.createRadialGradient(250,250,0,250,250,220);
    glow.addColorStop(0,'rgb(251,233,206)'); glow.addColorStop(.07,'rgba(241,202,157,.9)');
    glow.addColorStop(.25,'rgba(170,147,144,.35)'); glow.addColorStop(1,'rgba(92,118,168,0)');
    ctx.fillStyle=glow;ctx.fillRect(0,0,500,500);
    for(let i=0;i<23500;i++) {
      const r=Math.sqrt(random())*229, branch=i%2*Math.PI;
      const a=2.8*Math.log(.11+r/225)+branch+(random()+random()+random()-1.5)*.55;
      const alpha=(1-r/235)*(.11+random()*.62);
      ctx.fillStyle=i%4?'rgba(176,204,249,'+alpha+')':'rgba(229,207,201,'+alpha+')';
      ctx.fillRect(250+r*Math.cos(a),250+r*Math.sin(a),.6+random()*1.8,.6+random()*1.2);
    }
    this.sprites.set(id,{sprite:c}); return c;
  }
  drawStars(frame) {
    const {cam,local,starEye,farEye}=frame,ctx=this.ctx, data=this.catalog;
    const focal=cam.h/(2*cam.scale[1]),cx=cam.cx*cam.w,cy=cam.cy*cam.h;
    for(const [eye,intensity,limit] of [[starEye,local,frame.starCount*6],[farEye,.34,Math.floor(frame.starCount/8)*6]]) {
      if(intensity<.01) continue;
      for(let i=0;i<limit;i+=6) {
        let x=data[i]-eye[0],y=data[i+1]-eye[1],z=data[i+2]-eye[2];
        x-=8*Math.floor((x+4)/8);y-=8*Math.floor((y+4)/8);z-=8*Math.floor((z+4)/8);
        const depth=x*cam.forward[0]+y*cam.forward[1]+z*cam.forward[2];
        if(depth<=0) continue;
        const px=cx+(x*cam.right[0]+z*cam.right[2])*focal/depth;
        const py=cy-(x*cam.up[0]+y*cam.up[1]+z*cam.up[2])*focal/depth;
        if(px<0 || px>cam.w || py<0 || py>cam.h) continue;
        const mag=clamp(data[i+3]/Math.hypot(x,y,z),.06,3);
        const edge=clamp((4-Math.max(Math.abs(x),Math.abs(y),Math.abs(z)))/.75,0,1);
        ctx.globalAlpha=clamp((mag*.93+.1)*intensity*data[i+5]*edge*(.54+.65*frame.exposure),0,1);
        ctx.fillStyle=data[i+4]<.3?'#abc9fa':data[i+4]>.85?'#f7d9b8':'#e4e8f4';
        const r=.45+Math.min(1.25,mag);
        if(frame.transit>.04) {
          const length=.026*frame.transit*(.55+Math.min(2,mag));
          ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=Math.min(1.3,r);
          ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px+(px-cx)*length,py+(py-cy)*length);ctx.stroke();
        }
        ctx.fillRect(px,py,r,r);
      }
    }
    ctx.globalAlpha=1;
  }
  draw(frame) {
    const {cam,dpr,view,local}=frame, ctx=this.ctx;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#03050a';ctx.fillRect(0,0,cam.w,cam.h);
    const skyW=cam.h*TAU/view.fov, skyH=skyW*.5;
    const left=cam.cx*cam.w-skyW*((1-Math.atan2(cam.forward[0],cam.forward[2])/TAU+.5)%1);
    const top=cam.cy*cam.h-skyH*(.5-view.pitch/Math.PI);
    ctx.globalAlpha=local*frame.exposure;
    for(let i=-1;i<=1;i++) ctx.drawImage(this.sky,left+i*skyW,top,skyW,skyH);
    ctx.globalAlpha=1;
    this.drawStars(frame);
    for(const item of frame.objects) {
      const {obj,x,y,radius,bounds,distance}=item;
      if(!bounds || radius<.5) continue;
      if(isDeep(obj)) { this.volumes.draw(ctx,frame,item);deepPoints2D(ctx,frame,item);continue; }
      if(item.center[2]<=0) continue;
      const r=Math.min(radius,3*Math.max(cam.w,cam.h));
      if(obj.kind==='galaxy') {
        if(distance<.68) continue;
        const normal=unit(galaxyAxes[obj.id]||galaxyAxes.whirlpool);
        const east=unit([normal[2],0,-normal[0]]);
        const north=[normal[1]*east[2], normal[2]*east[0]-normal[0]*east[2],-normal[1]*east[0]];
        ctx.save();ctx.translate(x,y);ctx.globalCompositeOperation='screen';
        ctx.transform(dot(east,cam.right),-dot(east,cam.up),dot(north,cam.right),-dot(north,cam.up),0,0);
        ctx.drawImage(this.spiral(obj.id),-r*1.2,-r*1.2,r*2.4,r*2.4);ctx.restore();
        ctx.save();ctx.translate(x,y);
        ctx.rotate(Math.atan2(-dot(east,cam.up),dot(east,cam.right)));
        ctx.scale(1,.50+.50*Math.abs(dot(normal,cam.forward)));
        ctx.globalCompositeOperation='screen';
        const bulge=ctx.createRadialGradient(0,0,0,0,0,r*.31);
        bulge.addColorStop(0,'#fff3d8');bulge.addColorStop(.075,'rgba(255,222,174,.89)');
        bulge.addColorStop(.26,'rgba(207,169,127,.52)');bulge.addColorStop(.6,'rgba(150,116,91,.14)');
        bulge.addColorStop(1,'rgba(98,73,56,0)');
        ctx.fillStyle=bulge;ctx.fillRect(-r*.31,-r*.31,r*.62,r*.62);ctx.restore();continue;
      }
      if(r<1.7) { ctx.fillStyle=obj.color;ctx.fillRect(x-.6,y-.6,1.2,1.2);continue; }
      if(obj.id==='earth'||obj.material==='haze'||obj.kind==='star') {
        const edge=obj.kind==='star'?1.9:1.053;
        const glow=ctx.createRadialGradient(x,y,r*.998,x,y,r*edge);
        glow.addColorStop(0,obj.kind==='star'?obj.color+'b0':obj.material==='haze'?'#d8b47d91':'#438bd57f');
        glow.addColorStop(.24,obj.kind==='star'?obj.color+'44':obj.material==='haze'?'#b7885b35':'#19588f26');
        glow.addColorStop(1,'transparent');ctx.fillStyle=glow;ctx.fillRect(x-r*edge,y-r*edge,2*r*edge,2*r*edge);
      }
      const rings=(front) => {
        const normal=surfaceAxes(obj).pole, tilt=dot(normal,cam.forward);
        const angle=Math.atan2(dot(normal,cam.right),dot(normal,cam.up));
        const nearHalf=tilt<0?front:!front;
        ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.scale(1,Math.max(.006,Math.abs(tilt)));
        for(let j=0;j<80;j++) {
          const distance=1.24+j*.013;
          if((distance>1.94&&distance<1.99)||Math.abs(distance-2.215)<.007) continue;
          const c=distance<1.52, b=distance<1.94;
          const alpha=(c?.30:b?.91:.73)*(.94+.055*Math.sin(j*1.85)+.035*Math.sin(j*.67));
          ctx.strokeStyle='rgba('+(c?'138,123,112':b?'221,207,183':'196,183,164')+','+alpha+')';
          ctx.lineWidth=.018*r;
          ctx.beginPath();ctx.arc(0,0,distance*r,nearHalf?0:Math.PI,nearHalf?Math.PI:TAU);ctx.stroke();
        }
        ctx.restore();
      };
      if(obj.id==='saturn') rings(false);
      const size=r>160?(frame.moving?288:512):r>75?(frame.moving?224:256):r>28?128:64;
      ctx.drawImage(this.globe(frame,item,size),x-r,y-r,r*2,r*2);
      if(obj.id==='saturn') rings(true);
    }
  }
}

export class UniverseRenderer {
  constructor(canvas) {
    this.canvas=canvas;
    this.labels=new BodyLabels(canvas);
    this.images=new Map(); this.requested=new Set();
    this.sky=skyMap(); this.stars=stars();
    let gl=null;
    try {
      gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,powerPreference:'low-power'});
      if(gl) this.backend=new SpaceGL(gl,this.sky,this.stars);
    } catch(error) { console.warn('Rendu spatial en mode compatible.',error.message); }
    const fallback=() => {
      if(gl && !this.overlay) {
        this.overlay=powerCanvas(1,1);
        this.overlay.setAttribute('aria-hidden','true');
        this.overlay.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
        canvas.after(this.overlay);
      }
      this.backend=new Space2D((this.overlay||canvas).getContext('2d',{alpha:false}),this.sky,this.stars);
      for(const [id,image] of this.images) this.backend.loadMap(id,image);
      this.lastKey=null;
    };
    if(!this.backend) fallback();
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();fallback();});
    canvas.addEventListener('webglcontextrestored',()=>{
      try {
        const restored=new SpaceGL(gl,this.sky,this.stars);
        for(const [id,image] of this.images) restored.loadMap(id,image);
        this.backend=restored; this.overlay?.remove();this.overlay=null;this.lastKey=null;
      } catch { fallback(); }
    });
    this.requestMap('earth-land');
    const preview=new Image();
    preview.onload=()=>{
      if(this.images.has('earth-land')) return;
      this.images.set('earth-land',preview);
      this.backend.loadMap('earth-land',preview);
      this.lastKey=null;
    };
    preview.src=assetUrl('earth-land-preview.webp');
    this.requestMap('earth-weather');
    this.requestMap('earth-night');
    this.requestMap('galactic-sky');
    const primeGalaxy=()=>this.requestMap('andromeda');
    if(window.requestIdleCallback) window.requestIdleCallback(primeGalaxy,{timeout:1400});
    else setTimeout(primeGalaxy,800);
  }
  requestMap(id,filename=id+'-day.webp') {
    if(this.requested.has(id)) return;
    this.requested.add(id);
    const image=new Image();
    image.onload=()=>{
      const texture=id.endsWith('-detail')?photoRelief(image):image;
      this.images.set(id,texture);this.backend.loadMap(id,texture);this.lastKey=null;
    };
    image.src=assetUrl(filename);
  }
  draw(view,objects,options={}) {
    const cssW=this.canvas.clientWidth,cssH=this.canvas.clientHeight;
    if(!cssW || !cssH) return null;
    const dpr=Math.min(window.devicePixelRatio||1,1.75,Math.sqrt(1700000/(cssW*cssH)));
    const target=this.overlay||this.canvas, w=Math.max(1,Math.round(cssW*dpr)),h=Math.max(1,Math.round(cssH*dpr));
    const fallbackSpin=options.reducedMotion?0:((options.time||0)*.008)%TAU;
    const days=options.simulationDays;
    const prior=this.lastFrame;
    const cameraMoving=Boolean(prior && (view.yaw!==prior.yaw || view.pitch!==prior.pitch ||
      view.fov!==prior.fov || view.position.some((v,i)=>v!==prior.position[i])));
    const moving=cameraMoving||Boolean(prior && (days!==prior.days || options.transit>.02));
    this.lastFrame={days,yaw:view.yaw,pitch:view.pitch,fov:view.fov,position:view.position.slice()};
    const cloudDrift=Number.isFinite(days)?(days*.035%1)*-TAU:-fallbackSpin*.035;
    const venusWind=Number.isFinite(days)?(days/4.2%1)*TAU:-fallbackSpin;
    const transit=options.reducedMotion?0:clamp(options.transit||0,0,1);
    // Resting views redraw only as the surface visibly rotates; motion still tracks every frame.
    const key=[...view.position,view.yaw,view.pitch,view.fov,options.centerX,options.centerY,
      options.selectedId,w,h,options.showNames!==false,this.labels.revision,moving,cameraMoving,!!options.earthSurvey,
      Number.isFinite(days)?days:Math.floor(fallbackSpin*240),Math.round(transit*180)].join(',');
    if(key===this.lastKey && !options.capture) return this.selection;
    this.lastKey=key;
    if(target.width!==w || target.height!==h) { target.width=w;target.height=h; }
    const cam=camera(view,cssW,cssH,options);
    const items=objects.map(obj=>project(obj,view.position,cam)).sort((a,b)=>b.range-a.range);
    for(const {obj,bounds,radius} of items) {
      if((!bounds || radius<=5) && options.selectedId!==obj.id) continue;
      if(hasVolume(obj.id)) {
        this.requestMap(obj.id+'-volume',obj.id+'-volume.webp');
        if(hasPhotoDetail(obj.id)) this.requestMap(obj.id+'-detail','deep-thumb-'+obj.id+'.webp');
      }
      else if(moonMaps.has(obj.id)||['mercury','mars','jupiter','saturn'].includes(obj.id)||Object.hasOwn(galaxyAxes,obj.id)) this.requestMap(obj.id);
    }
    const selected=items.find(item=>item.obj.id===options.selectedId);
    this.selection=selected?{x:selected.x,y:selected.y,radius:selected.radius,visible:selected.visible}:null;
    const galaxies=items.filter(item=>item.obj.kind==='galaxy').sort((a,b)=>a.distance-b.distance);
    const home=galaxies[0];
    const local=home?clamp((1.32-home.distance)/.52,0,1):1;
    const center=home && home.obj.id!=='milky-way'?home.obj.position:[0,0,0];
    // Reduce coordinates before float upload. Distant stars stay fixed over Solar System flights.
    const starEye=minus(view.position,center).map(v=>(v/(400*LY))%8);
    const farEye=view.position.map(v=>(v/(28e6*LY))%8);
    const sun=objects.find(o=>o.id==='sun')?.position||[-1,.5,1];
    const exposure=skyExposure(items,view.position,sun,Math.min(cssW,cssH));
    const starCount=clamp(Math.round(cssW*cssH/310),720,STAR_COUNT);
    this.backend.draw({cam,view,dpr,objects:items,local,starEye,farEye,fallbackSpin,cloudDrift,venusWind,sun,transit,moving,cameraMoving,
      exposure,starCount,earthSurvey:!!options.earthSurvey});
    this.labels.draw(items,options.selectedId,cam,options.showNames!==false);
    return this.selection;
  }
  capture(view,objects,options) {
    this.draw(view,objects,{...options,capture:true});
    // Copy before WebGL presents the frame and discards its drawing buffer.
    this.lastKey=null;
    const source=this.overlay||this.canvas;
    const photo=powerCanvas(source.width,source.height);
    photo.getContext('2d').drawImage(source,0,0);
    return photo;
  }
}
