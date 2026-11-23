const prefix='seabyss.transits.measure.v1.';
const percent=new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:4});
const hours=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});
const dates=new Intl.DateTimeFormat('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});

function valid(entry) {
  return !!entry && typeof entry.planetId==='string' && Number.isFinite(entry.impact) && entry.impact>=0
    && Number.isFinite(entry.depth) && entry.depth>=0 && entry.depth<=1
    && Number.isFinite(entry.durationHours) && entry.durationHours>=0;
}

export function readTransitRecords(storage) {
  const rows=[];
  for (let i=0;i<storage.length;i++) {
    const key=storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const entry=JSON.parse(storage.getItem(key));
      if (valid(entry) && Number.isFinite(entry.stamp)) rows.push({...entry,key});
    } catch { /* Ignore an incomplete entry while keeping the rest of the notebook readable. */ }
  }
  return rows.sort((a,b)=>b.stamp-a.stamp || b.key.localeCompare(a.key));
}

export function addTransitRecord(storage,measurement) {
  if (!valid(measurement)) return null;
  const {planetId,impact,depth,durationHours}=measurement;
  const previous=readTransitRecords(storage).find(row=>row.planetId===planetId && row.impact===impact &&
    row.depth===depth && row.durationHours===durationHours);
  if (previous) return {key:previous.key,added:false};
  const key=prefix+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');
  storage.setItem(key,JSON.stringify({planetId,impact,depth,durationHours,stamp:Date.now()}));
  return {key,added:true};
}

const node=(tag,text='')=>{const el=document.createElement(tag);el.textContent=text;return el;};
export function createTransitNotebook(host,{objects,onRecall}) {
  const names=new Map(objects.map(body=>[body.id,body.name]));
  const section=node('section');section.className='transit-notes';
  const title=node('h3','Mesures consignées'),list=node('div'),difference=node('div'),status=node('p');
  list.className='transit-note-list';status.className='transit-note-status';status.setAttribute('role','status');
  difference.className='transit-note-compare';
  section.append(title,list,difference,status);host.append(section);
  let aKey='',bKey='';
  const name=row=>names.get(row.planetId) || row.planetId;
  const label=row=>name(row)+' · b = '+hours.format(row.impact);
  function drawDifferences(rows) {
    difference.replaceChildren();
    if (rows.length<2) return;
    const a=rows.find(row=>row.key===aKey)||rows[0],b=rows.find(row=>row.key===bKey && row!==a)||rows.find(row=>row!==a);
    aKey=a.key;bKey=b.key;
    difference.append(node('h4','Comparer deux mesures'));
    const controls=node('div');controls.className='transit-note-fields';
    for (const [slot,entry] of [['A',a],['B',b]]) {
      const field=node('label','Mesure '+slot),select=node('select');select.dataset.transitPair=slot;
      for (const row of rows) select.add(new Option(label(row),row.key));
      select.value=entry.key;
      select.onchange=()=>{
        if (slot==='A') {if(select.value===bKey)bKey=aKey;aKey=select.value;}
        else {if(select.value===aKey)aKey=bKey;bKey=select.value;}
        drawDifferences(rows);
        difference.querySelector('[data-transit-pair="'+slot+'"]').focus({preventScroll:true});
      };
      field.append(select);controls.append(field);
    }
    const result=node('output');
    result.dataset.transitDifference='';
    const delta=(a.depth-b.depth)*100;
    result.textContent='Écart de profondeur (A − B) : '+(delta>0?'+':'')+percent.format(delta)+' point'+(Math.abs(delta)>=2?'s':'')+' de pourcentage.';
    difference.append(controls,result);
  }
  function display(rows) {
    list.replaceChildren();
    if (!rows.length) list.append(node('p','Dans l’observatoire des transits, choisis une planète et consigne une mesure pour la retrouver ici.'));
    for (const row of rows) {
      const card=node('article');card.dataset.transitEntry=row.planetId;
      const copy=node('div'),heading=node('strong',name(row)),summary=node('p','b = '+hours.format(row.impact)+' · profondeur '+percent.format(row.depth*100)+' % · durée '+hours.format(row.durationHours)+' h');
      copy.append(heading,summary,node('small',dates.format(row.stamp)));
      const actions=node('div');actions.className='transit-note-actions';
      const recall=node('button','Reprendre'),remove=node('button','Retirer');
      recall.type=remove.type='button';recall.dataset.transitRecall=row.planetId;remove.dataset.transitRemove=row.planetId;
      recall.setAttribute('aria-label','Reprendre '+label(row));remove.setAttribute('aria-label','Retirer '+label(row));
      recall.onclick=()=>onRecall(row);
      remove.onclick=()=>{
        try {
          localStorage.removeItem(row.key);refresh();
          status.textContent='Mesure retirée.';
          (list.querySelector('button') || title).focus({preventScroll:true});
        } catch {status.textContent='Impossible de retirer cette mesure sur cet appareil.';}
      };
      actions.append(recall,remove);card.append(copy,actions);list.append(card);
    }
    drawDifferences(rows);
  }
  function refresh() {
    try {display(readTransitRecords(localStorage));}
    catch {display([]);status.textContent='Le stockage local du carnet est indisponible.';}
  }
  function record(measurement) {
    try {
      const result=addTransitRecord(localStorage,measurement);
      if (!result) {status.textContent='La mesure est incomplète.';return false;}
      if (result.added) {bKey=aKey;aKey=result.key;}
      refresh();status.textContent=result.added?'Mesure consignée sur cet appareil.':'Cette mesure figure déjà dans le carnet.';
      return true;
    } catch {status.textContent='Impossible de consigner la mesure sur cet appareil.';return false;}
  }
  function onStorage(event) {if(event.key===null || event.key.startsWith(prefix))refresh();}
  title.tabIndex=-1;
  window.addEventListener('storage',onStorage);refresh();
  return {record,dispose:()=>window.removeEventListener('storage',onStorage)};
}
