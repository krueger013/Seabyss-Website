import { assetUrl } from './assets.js';

const fullTurn = Math.PI * 2;
const stellarColors = [[251,208,173],[243,231,217],[222,233,252],[175,201,245],[226,215,237]];

// A surrounding sphere keeps the stellar background at infinity when the
// orbital diagram is panned or magnified. Camera rotation changes the sightline.
export function createOrbitalSky(redraw) {
  let seed = 25219;
  function random() {
    seed = (Math.imul(seed,1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const stars = Array.from({length:13300}, () => {
    const height = random()*2-1, angle = random()*fullTurn, radius = Math.sqrt(1-height*height);
    return { x:radius*Math.cos(angle), y:height, z:radius*Math.sin(angle), flux:random()**4.5,
      color:stellarColors[Math.floor(random()*stellarColors.length)] };
  });
  const field = document.createElement('canvas');
  const paint = field.getContext('2d');
  let atlas;
  const panorama = new Image();
  panorama.onload = () => {
    const map=document.createElement('canvas');
    map.width=768;map.height=384;
    const mapCtx=map.getContext('2d',{willReadFrequently:true});
    mapCtx.drawImage(panorama,0,0,map.width,map.height);
    atlas=mapCtx.getImageData(0,0,map.width,map.height);
    for(let x=0;x<map.width;x++) {
      const longitude=(x/map.width-.5)*fullTurn;
      const warm=(.5+.5*Math.cos(longitude-2.52))**3;
      for(let y=0;y<map.height;y++) {
        const i=(y*map.width+x)*4, data=atlas.data;
        const light=Math.max(0,data[i]*.32+data[i+1]*.47+data[i+2]*.21-2);
        const scatter=Math.max(0,data[i+2]-data[i]);
        data[i]=4+light*(.80+1.09*warm)+scatter*.29;
        data[i+1]=8+light*(1.11-.10*warm)+scatter*.17;
        data[i+2]=17+light*(1.70-.69*warm)+scatter*.54;
      }
    }
    redraw();
  };
  panorama.src=assetUrl('galactic-sky-day.webp');

  function draw(ctx,w,h,yaw,elevation,roll) {
    const cx=w*.5, cy=h*.5, lens=Math.max(Math.min(w,h)*.85,Math.max(w,h)*.44);
    const ax=Math.cos(yaw),az=Math.sin(yaw),ce=Math.cos(elevation),se=Math.sin(elevation);
    const cr=Math.cos(roll),sr=Math.sin(roll);
    // Diffuse dust is bandwidth-limited. Rasterize its low spatial
    // frequencies separately and draw the point sources at display resolution.
    const resolution=Math.max(w/600,h/400,1.8);
    const pw=Math.max(2,Math.ceil(w/resolution)), ph=Math.max(2,Math.ceil(h/resolution));
    if(field.width!==pw || field.height!==ph) {field.width=pw;field.height=ph;}
    const baseX=(cr*ax-sr*se*(-az))/lens, baseY=sr*ce/lens, baseZ=(cr*az-sr*se*ax)/lens;
    const rowX=(sr*ax-cr*se*az)/lens,rowY=-cr*ce/lens,rowZ=(sr*az+cr*se*ax)/lens;
    const ct=.71091,st=.70328;
    if (atlas) {
      // Dust has smooth angular derivatives over a few pixels. Interpolate
      // its spherical coordinates within small tiles. The point sources
      // below are still projected individually at full precision.
      const tile=8, cols=Math.ceil(pw/tile)+1,rows=Math.ceil(ph/tile)+1;
      const longitudes=new Float32Array(cols*rows),latitudes=new Float32Array(cols*rows);
      const aw=atlas.width,ah=atlas.height;
      for(let j=0;j<rows;j++) for(let i=0;i<cols;i++) {
        const py=(j*tile+.5)*h/ph-cy, px=(i*tile+.5)*w/pw-cx;
        const wx=ce*az+baseX*px+rowX*py,wy=-se+baseY*px+rowY*py,wz=-ce*ax+baseZ*px+rowZ*py;
        const ny=wy*ct-wz*st,nz=wy*st+wz*ct,index=j*cols+i;
        longitudes[index]=(Math.atan2(wx,nz)/fullTurn+.5)*aw;
        latitudes[index]=(.5-Math.asin(ny/Math.hypot(wx,ny,nz))/Math.PI)*ah;
      }
      const deltaU=d=>d>aw/2?d-aw:d< -aw/2?d+aw:d;
      const image=paint.createImageData(pw,ph);
      const pixels=new Uint32Array(image.data.buffer),source=new Uint32Array(atlas.data.buffer);
      for(let y=0;y<ph;y++) {
        const line=Math.floor(y/tile)*cols, fy=(y%tile)/tile;
        for(let start=0;start<pw;start+=tile) {
          const i=line+start/tile;
          let u=longitudes[i]+fy*deltaU(longitudes[i+cols]-longitudes[i]);
          let v=latitudes[i]+fy*(latitudes[i+cols]-latitudes[i]);
          const rightU=longitudes[i+1]+fy*deltaU(longitudes[i+cols+1]-longitudes[i+1]);
          const rightV=latitudes[i+1]+fy*(latitudes[i+cols+1]-latitudes[i+1]);
          const du=deltaU(rightU-u)/tile,dv=(rightV-v)/tile;
          for(let x=start,end=Math.min(pw,start+tile);x<end;x++,u+=du,v+=dv) {
            const ox=(Math.floor(u)+aw)%aw,oy=Math.min(ah-1,Math.max(0,Math.floor(v)));
            pixels[y*pw+x]=source[oy*aw+ox];
          }
        }
      }
      paint.putImageData(image,0,0);
      ctx.drawImage(field,0,0,w,h);
    } else {
      ctx.fillStyle='#040811';ctx.fillRect(0,0,w,h);
    }
    const dim=np=>Math.max(.55,Math.min(1,np/650));
    const density=dim(Math.hypot(w,h));
    for (const star of stars) {
      const along=-star.x*az+star.z*ax,depth=-along*ce-star.y*se;
      if(depth<.43) continue;
      const side=star.x*ax+star.z*az, up=-star.y*ce+along*se;
      const x=cx+lens*(side*cr-up*sr)/depth,y=cy+lens*(side*sr+up*cr)/depth;
      if(x<0 || y<0 || x>w || y>h) continue;
      const flux=star.flux;
      const radius=.37+flux*.88*density;
      const c=star.color.join(',');
      if(flux>.986) {
        const glow=ctx.createRadialGradient(x,y,0,x,y,radius*5);
        glow.addColorStop(0,'rgba('+c+',.35)');glow.addColorStop(.22,'rgba('+c+',.16)');glow.addColorStop(1,'rgba('+c+',0)');
        ctx.fillStyle=glow;ctx.fillRect(x-radius*5,y-radius*5,radius*10,radius*10);
      }
      ctx.fillStyle='rgba('+c+','+(.18+flux*.69)+')';
      ctx.beginPath();ctx.arc(x,y,radius,0,fullTurn);ctx.fill();
    }
  }
  return {draw};
}
