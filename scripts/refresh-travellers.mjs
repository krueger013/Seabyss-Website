// Populate the offline edition with heliocentric JPL vectors. Node 20+.
// node "Seabyss Univers/windows/refresh-travellers.mjs" [YYYY-MM-DD YYYY-MM-DD [module-path]]
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DAY_MS = 86400000;
const unixJd = 2440587.5;
const marker = /\/\/ BEGIN HORIZONS TABLES[\s\S]*?\/\/ END HORIZONS TABLES/g;
const targets = [
  ['halley','DES=1P;CAP;NOFRAG',/\b1P\/Halley\b/i],
  ['oumuamua','50788063',/Oumuamua/i],
  ['voyager-1','-31',/Voyager 1 .*\(-31\)/i],
  ['voyager-2','-32',/Voyager 2 .*\(-32\)/i]
];

function isoDay(ms) { return new Date(ms).toISOString().slice(0,10); }

function parseDate(text) {
  const ms=Date.parse(text+'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(ms) || isoDay(ms)!==text) {
    throw new Error('Date UTC invalide : '+text);
  }
  return ms;
}

export function horizonsVectors(body,identity,startMs,endMs) {
  const title=body.match(/^Target body name\s*:\s*(.+)$/m)?.[1];
  if (!title || !identity.test(title) ||
      !/^Center body name\s*:\s*Sun \(10\)/m.test(body) ||
      !/^Reference frame\s*:\s*Ecliptic of J2000\.0/m.test(body) ||
      !/^Output type\s*:\s*GEOMETRIC cartesian states/m.test(body) ||
      !/^Output units\s*:\s*KM-S/m.test(body) ||
      !/^\s*JDUT\s*,/m.test(body)) {
    throw new Error('Référentiel, cible, unités ou échelle de temps inattendus dans la réponse Horizons.');
  }
  const block = body.match(/^\$\$SOE\s*\r?\n([\s\S]*?)^\$\$EOE/m)?.[1];
  if (!block) throw new Error('Table de vecteurs absente.');
  const rows=block.trim().split(/\r?\n/).map(line=>{
    const parts=line.split(',').map(s=>s.trim());
    if(parts.at(-1)==='') parts.pop();
    if(parts.length!==8 || parts.some(s=>!s)) throw new Error('Ligne Horizons incomplète.');
    const row=[parts[0],...parts.slice(2)].map(Number);
    if (!row.every(Number.isFinite)) throw new Error('Vecteur Horizons illisible.');
    return row;
  });
  const first=unixJd+startMs/DAY_MS, last=unixJd+endMs/DAY_MS;
  if (rows[0][0]!==first || rows.at(-1)[0]!==last ||
      rows.some((r,i)=>i>0 && r[0]-rows[i-1][0]!==5)) {
    throw new Error('La réponse Horizons couvre seulement une partie de la période demandée.');
  }
  return rows;
}

async function refresh(args) {
  if (![0,2,3].includes(args.length)) throw new Error('Usage : refresh-travellers.mjs [AAAA-MM-JJ AAAA-MM-JJ [chemin-module]]');
  const today=new Date(), year=today.getUTCFullYear();
  const start=args.length?parseDate(args[0]):Date.UTC(year,0,1);
  const wantedEnd=args.length?parseDate(args[1]):Date.UTC(year+2,0,1);
  if (wantedEnd<=start || wantedEnd-start>4*366*DAY_MS) throw new Error('Choisir une période comprise entre un jour et quatre ans.');
  const end=start+Math.ceil((wantedEnd-start)/(5*DAY_MS))*5*DAY_MS;
  const path=args[2] ? resolve(args[2]) : fileURLToPath(new URL('../../Seabyss Cards/jeu/univers/traveller-ephemerides.js',import.meta.url));
  const source=await readFile(path,'utf8'), tables={};
  if ([...source.matchAll(marker)].length!==1) throw new Error('Emplacement de la table introuvable.');
  for (const [id,command,identity] of targets) {
    const url=new URL('https://ssd.jpl.nasa.gov/api/horizons.api');
    url.searchParams.set('format','json');
    const params={COMMAND:command,CENTER:'500@10',MAKE_EPHEM:'YES',EPHEM_TYPE:'VECTORS',OBJ_DATA:'NO',
      TIME_TYPE:'UT',REF_SYSTEM:'ICRF',REF_PLANE:'ECLIPTIC',VEC_CORR:'NONE',VEC_TABLE:'2',CSV_FORMAT:'YES',
      OUT_UNITS:'KM-S',START_TIME:isoDay(start),STOP_TIME:isoDay(end),STEP_SIZE:'5 d'};
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key,"'"+value+"'");
    // As required by the SSD API policy, wait for each response before the next call.
    const response=await fetch(url,{signal:AbortSignal.timeout(45000)});
    if (!response.ok) throw new Error('Horizons '+id+' : HTTP '+response.status);
    const data=await response.json();
    if(data.error || typeof data.result!=='string') throw new Error('Horizons '+id+' : '+(data.error || 'réponse vide'));
    const rows=horizonsVectors(data.result,identity,start,end);
    tables[id]={sourceUrl:url.href,forecastDays:0,rows};
    console.log(id+' : '+rows.length+' vecteurs du '+isoDay(start)+' au '+isoDay(end));
  }
  const block='// BEGIN HORIZONS TABLES\nconst tables = '+JSON.stringify(tables)+';\n// END HORIZONS TABLES';
  if (await readFile(path,'utf8')!==source) throw new Error('Le fichier source a été modifié pendant la requête.');
  const stage=path+'.'+randomUUID()+'.new';
  try {
    await writeFile(stage,source.replace(marker,()=>block),{flag:'wx'});
    await rename(stage,path);
  } finally { await rm(stage,{force:true}); }
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  refresh(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}

