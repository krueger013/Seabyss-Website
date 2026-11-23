import {EARTH_SKY_SITES, resolveEarthSkySite} from './earth-sky-sites.js';
import {EARTH_SKY_BODIES} from './earth-sky-model.js';

const prefix='seabyss.earth-sky.note.v1.';
const bodyNames=new Map(EARTH_SKY_BODIES.map(body=>[body.id,body.name]));

function observationFrom(value) {
  if (!value || !bodyNames.has(value.targetId)) return null;
  const site=value.site;
  if (typeof site==='string') {
    if (!EARTH_SKY_SITES.some(place=>place.id===site)) return null;
  } else if (!Number.isFinite(site?.latitude) || Math.abs(site.latitude)>90 ||
      !Number.isFinite(site?.longitude) || Math.abs(site.longitude)>180) return null;
  const date=value.date;
  if (!(date instanceof Date) && typeof date!=='number' && typeof date!=='string') return null;
  const time=new Date(date);
  if (!Number.isFinite(time.getTime()) || time.getUTCFullYear()<1700 || time.getUTCFullYear()>2100) return null;
  return {site:resolveEarthSkySite(site),targetId:value.targetId,date:time.toISOString()};
}

function storageKey({site,targetId,date}) {
  return prefix+[targetId,date,site.latitude,site.longitude,site.elevationMeters,site.timeZone].join('|');
}

export function storeSkyObservation(storage, value) {
  const observation=observationFrom(value);
  if (!observation || !storage) return false;
  try {
    const key=storageKey(observation);
    storage.setItem(key,JSON.stringify({...observation,savedAt:Date.now()}));
    return true;
  } catch {return false;}
}

export function readSkyObservations(storage) {
  const entries=[];
  if (!storage) return entries;
  try {
    for (let index=0;index<storage.length;index++) {
      const key=storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const value=JSON.parse(storage.getItem(key));
        const observation=observationFrom(value);
        if (observation && storageKey(observation)===key)
          entries.push({...observation,key,savedAt:Number.isFinite(value.savedAt)?value.savedAt:0});
      } catch { /* An unreadable entry must not hide other observations. */ }
    }
  } catch { /* A browser can revoke storage access while the journal is open. */ }
  return entries.sort((a,b)=>b.savedAt-a.savedAt || a.key.localeCompare(b.key));
}

function make(tag,text) {
  const node=document.createElement(tag);
  if (text) node.textContent=text;
  return node;
}

export function createEarthSkyNotebook(host,{onRecall}={}) {
  let storage;
  try {storage=window.localStorage;} catch {}
  const section=make('section');
  section.className='earth-sky-notes';
  const title=make('h3','Mes observations');
  const status=make('p');
  status.setAttribute('role','status');
  const list=make('ul');
  section.append(title,list,status);host.append(section);

  function render() {
    const entries=readSkyObservations(storage);
    list.replaceChildren();
    if (!entries.length) {
      const empty=make('li',storage?'Aucune observation enregistrée sur cet appareil.':'Le stockage du carnet est indisponible dans ce navigateur.');
      empty.className='earth-sky-notes-empty';list.append(empty);return;
    }
    for (const entry of entries) {
      const row=make('li');
      row.dataset.earthSkyEntry='';
      const label=bodyNames.get(entry.targetId)+' · '+entry.site.name;
      const metadata=make('div'),heading=make('strong',label);
      const time=make('time',new Intl.DateTimeFormat('fr-CA',{timeZone:entry.site.timeZone,day:'numeric',
        month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'shortOffset'}).format(new Date(entry.date)));
      time.dateTime=entry.date;time.title=entry.date;
      metadata.append(heading,time);
      if (entry.site.id==='custom') metadata.append(make('small',new Intl.NumberFormat('fr-CA',{maximumFractionDigits:5}).format(entry.site.latitude)+'°, '+
        new Intl.NumberFormat('fr-CA',{maximumFractionDigits:5}).format(entry.site.longitude)+'°'));
      const actions=make('div');actions.className='earth-sky-note-actions';
      if (onRecall) {
        const recall=make('button','Revoir');recall.type='button';recall.dataset.earthSkyRecall='';
        recall.setAttribute('aria-label','Revoir '+label);recall.onclick=()=>onRecall({site:entry.site,targetId:entry.targetId,date:entry.date});actions.append(recall);
      }
      const remove=make('button','Retirer');remove.type='button';remove.dataset.earthSkyRemove='';
      remove.setAttribute('aria-label','Retirer '+label+' du carnet');
      remove.onclick=()=>{
        try {storage.removeItem(entry.key);render();status.textContent='Observation retirée.';}
        catch {status.textContent='La suppression a échoué sur cet appareil.';}
      };
      actions.append(remove);row.append(metadata,actions);list.append(row);
    }
  }

  function record(value) {
    const saved=storeSkyObservation(storage,value);
    if (saved) render();
    return saved;
  }
  function changed(event) {
    if (storage && event.storageArea===storage && (!event.key || event.key.startsWith(prefix))) render();
  }
  render();window.addEventListener('storage',changed);
  return {record,dispose(){window.removeEventListener('storage',changed);section.remove();}};
}
