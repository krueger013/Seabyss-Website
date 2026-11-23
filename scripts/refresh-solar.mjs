// node refresh-solar.mjs <published assets directory>
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory=process.argv[2];
if (!directory) throw new Error('Indiquer le répertoire des ressources du site.');
const base='https://sdo.gsfc.nasa.gov/assets/img/';
const now=new Date();
const manifest=path.join(directory,'solar-frame.json');
const request=url=>fetch(url,{signal:AbortSignal.timeout(11000)});

async function datedFrame(day) {
  const prefix=day.toISOString().slice(0,10).replaceAll('-','/');
  const url=base+'browse/'+prefix+'/';
  const response=await request(url);
  if (!response.ok) return null;
  const listing=await response.text();
  const candidates=[...listing.matchAll(/href=["'](\d{8})_(\d{6})_1024_(HMII|HMIIF)\.jpg["']/gi)]
    .filter(m=>m[1]===prefix.replaceAll('/','')).sort((a,b)=>b[2].localeCompare(a[2]) || a[3].length-b[3].length);
  for (const m of candidates) {
    const stamp=prefix.replaceAll('/','-')+'T'+m[2].replace(/(..)(..)(..)/,'$1:$2:$3')+'Z';
    if (new Date(stamp)<=now) return {source:url+m[1]+'_'+m[2]+'_1024_'+m[3]+'.jpg',observedAt:stamp};
  }
  return null;
}

async function readJpeg(source) {
  const response=await request(source);
  if (!response.ok || Number(response.headers.get('content-length'))>3500000) throw new Error('Image SDO indisponible.');
  const bytes=Buffer.from(await response.arrayBuffer());
  if (bytes.length<8000 || bytes.length>3500000 || bytes.readUInt16BE(0)!==0xffd8 || bytes.readUInt16BE(bytes.length-2)!==0xffd9)
    throw new Error('Réponse JPEG HMI invalide.');
  return {bytes,publishedAt:response.headers.get('last-modified')};
}

const candidate=await datedFrame(now).catch(()=>null);
const latest={source:base+'latest/latest_1024_HMII.jpg',observedAt:null};
let frame=candidate||latest;
let result;
try { result=await readJpeg(frame.source); }
catch (err) { if(!candidate) throw err; frame=latest; result=await readJpeg(frame.source); }
const digest=createHash('sha256').update(result.bytes).digest('hex');
await mkdir(directory,{recursive:true});
const previous=await readFile(manifest,'utf8').then(JSON.parse).catch(()=>null);
const image='solar-photosphere-'+digest.slice(0,12)+'.jpg';
const recorded=await readFile(path.join(directory,image)).catch(()=>null);
if(previous?.image===image && recorded?.equals(result.bytes) && (previous.observedAt || !frame.observedAt)) {
  console.log('Image HMI déjà à jour.'); process.exit(0);
}
const payload={image,...frame,retrievedAt:now.toISOString(),publishedAt:result.publishedAt,sha256:digest};
const temp=manifest+'.'+randomUUID()+'.tmp';
await writeFile(path.join(directory,image),result.bytes);
await writeFile(temp,JSON.stringify(payload,null,2)+'\n');
await rename(temp,manifest);
console.log(image,frame.observedAt||'Heure de prise de vue inscrite sur le cliché.');
