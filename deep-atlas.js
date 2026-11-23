import { assetUrl } from './assets.js';
import { LIGHT_YEAR } from './catalog.js';

const photos = {
  'orion-nebula':'NASA, ESA, M. Robberto et l’équipe du projet Orion de Hubble',
  'crab-nebula':'NASA, ESA, J. Hester et A. Loll (ASU)',
  'ring-nebula':'Hubble Heritage Team (AURA/STScI/NASA)',
  'lagoon-nebula':'Hunter Wilson (Hewholooks) · CC BY-SA 3.0',
  'eagle-nebula':'ESO · CC BY 4.0', 'dumbbell-nebula':'ESO/I. Appenzeller, W. Seifert, O. Stahl, M. Zamani · CC BY 4.0',
  'wild-duck':'ESO · CC BY 4.0', 'hercules-cluster':'NASA, STScI et WikiSky',
  'beehive':'Giuseppe Donatiello · CC0', 'pleiades':'Bob Star · CC BY 2.0',
  'triangulum':'ESO · CC BY 4.0', 'bodes-galaxy':'Ken Crawford · CC BY-SA 4.0',
  'm87':'NASA, STScI et WikiSky', 'sombrero':'NASA/ESA et Hubble Heritage Team (STScI/AURA)',
  'cassiopeia-a':'Chandra · NASA/CXC/Meiji Univ./T. Sato et al. · Traitement NASA/CXC/SAO/N. Wolk',
  'tycho-remnant':'Chandra · NASA/CXC/RIKEN & GSFC/T. Sato et al.',
  'sn1006':'Chandra · NASA/CXC/Middlebury College/F. Winkler',
  'southern-ring-nebula':'Webb/MIRI · NASA, ESA, CSA, STScI et Webb ERO Production Team',
  'butterfly-nebula':'Hubble · NASA, ESA et J. Kastner (RIT)',
  'ngc281':'Spitzer · NASA/JPL/CfA/S. Wolk'
};
const esoImages = {'wild-duck':'eso1430a','eagle-nebula':'eso0926a','triangulum':'eso1424a','dumbbell-nebula':'eso9846a'};
const editorial = ['orion-nebula','cassiopeia-a','pleiades','butterfly-nebula','sombrero','tycho-remnant',
  'trappist-1-e','southern-ring-nebula','sn1006','ngc281','crab-nebula','triangulum',
  'ring-nebula','hercules-cluster','55-cancri-e','eagle-nebula','m87','dumbbell-nebula','beehive',
  'hd-189733-b','bodes-galaxy','wild-duck','kepler-186-f','lagoon-nebula','carina-nebula'];
const format = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const starDistanceFormat = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});
const kindOptions = [['all','Toutes les familles'],['nebula','Nébuleuses'],['cluster','Amas d’étoiles'],['galaxy','Galaxies'],['planet','Exoplanètes'],['star','Étoiles']];
const phenomena = [
  ['remnant','Rémanents de supernova', b => b.morphology === 'remnant'],
  ['planetary-nebula','Nébuleuses planétaires', b => ['planetary','bipolar'].includes(b.morphology)],
  ['nursery','Pouponnières stellaires', b => ['emission','pillars'].includes(b.morphology) || ['carina-nebula','lagoon-nebula','westerlund2','m78'].includes(b.id)]
];
const regionOptions = [['all','Toutes les régions'],['galactic','Voie lactée'],['extragalactic','Au-delà de la Voie lactée'],['exoplanetaires','Systèmes exoplanétaires']];
function node(tag, klass, text) {
  const result = document.createElement(tag);
  if (klass) result.className = klass;
  if (text) result.textContent = text;
  return result;
}
function region(body) { return body.system ? 'exoplanetaires' : body.kind === 'galaxy' ? 'extragalactic' : 'galactic'; }
function searchKey(value) {
  return (value || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu,'')
    .replace(/œ/g,'oe').replace(/[^a-z0-9]/g,'');
}
function shortDistance(body) {
  const d = Math.hypot(...body.position)/LIGHT_YEAR;
  if (d >= 1e6) return format.format(d/1e6)+' M al';
  return format.format(d < 100 ? d : Math.round(d))+' al';
}
function plateKind(body) { return photos[body.id] ? 'Photographie' : body.system ? 'Plan orbital' : 'Carte de repérage'; }
function sourceLink(text,url) {
  const link=node('a','',text);
  link.href=url; link.target='_blank'; link.rel='noopener noreferrer';
  return link;
}
function selectFilter(attribute, label, entries) {
  const field=node('label','deep-filter');
  field.append(node('span','',label));
  const select=node('select');
  select.setAttribute(attribute,'');
  for (const [value,caption] of entries) select.add(new Option(caption,value));
  field.append(select);
  return {field,select};
}

function discoveryTools({objects, travel, experiences, openArchive, openCompare}) {
  const tools=node('section','discover-tools');
  tools.setAttribute('aria-label','Outils de découverte');
  const bar=node('div','discover-actions');
  const panels=[];
  function action(attribute,label,icon,activate) {
    const button=node('button','discover-choice');
    button.type='button'; button.setAttribute(attribute,'');
    const glyph=node('i');
    glyph.dataset.icon=icon;
    glyph.setAttribute('aria-hidden','true');
    button.append(glyph,node('span','',label));
    button.onclick=activate;
    bar.append(button);
    return button;
  }
  function disclosure(attribute,label,icon,panel,id) {
    const button=action(attribute,label,icon,()=>{
      const show=panel.hidden;
      for (const item of panels) {
        const selected=show && item.panel===panel;
        item.panel.hidden=!selected;
        item.button.setAttribute('aria-expanded',String(selected));
      }
    });
    panel.id=id; panel.hidden=true;
    button.setAttribute('aria-expanded','false');
    button.setAttribute('aria-controls',id);
    panels.push({button,panel});
  }
  const nearby=objects.filter(b=>b.stellarNeighborhood)
    .sort((a,b)=>a.distanceLY-b.distanceLY);
  if (nearby.length) {
    const neighbours=node('section','discover-neighbours');
    neighbours.append(node('h3','','Étoiles proches du Soleil'));
    const list=node('ol','discover-stars');
    for (const body of nearby) {
      const item=node('li'),button=node('button');
      button.type='button'; button.dataset.nearbyTravel=body.id; button.onclick=()=>travel(body.id);
      const star=node('span','discover-star');
      star.style.setProperty('--star-color',body.color); star.setAttribute('aria-hidden','true');
      const identity=node('span','discover-star-name',body.name);
      identity.append(node('small','','Type spectral '+body.spectralType));
      button.append(star,identity,node('span','discover-distance',starDistanceFormat.format(body.distanceLY)+' al'));
      item.append(button); list.append(item);
    }
    neighbours.append(list);
    disclosure('data-discover-nearby','Voisinage stellaire','navigate',neighbours,'atlas-nearby-stars');
  }
  action('data-discover-compare','Comparer les astres','grid',openCompare);
  disclosure('data-discover-labs','Laboratoires','fragments',experiences,'atlas-discovery-labs');
  action('data-archive-open','Photos de mission','photo',openArchive);
  tools.append(bar,...panels.map(item=>item.panel));
  return tools;
}

export function createDeepAtlas(container, options) {
  const {objects,travel}=options;
  const gallery=node('section','deep-gallery');
  gallery.setAttribute('aria-label','Découvrir le ciel profond');
  const discovered=objects.filter(b=>b.observation && !b.simulated && !b.solarFamily);
  const searchIndex=new Map(discovered.map(b=>[b.id,[b.name,b.designation,b.region,b.category].map(searchKey)]));
  const rank=new Map(editorial.map((id,i)=>[id,i]));
  discovered.sort((a,b)=>(rank.get(a.id)??100)-(rank.get(b.id)??100) || a.name.localeCompare(b.name,'fr'));
  const filters=node('div','deep-filters');
  const family=selectFilter('data-deep-kind','Famille',kindOptions);
  const group=node('optgroup');
  group.label='Phénomènes stellaires';
  for (const [value,caption] of phenomena) group.append(new Option(caption,value));
  family.select.append(group);
  const zone=selectFilter('data-deep-region','Région',regionOptions);
  const searchField=node('label','deep-filter deep-search');
  const search=node('input');
  search.type='search'; search.placeholder='Nom ou catalogue (ex. SN 1572)';
  search.setAttribute('data-deep-search','');
  searchField.append(node('span','','Rechercher un astre'),search);
  const count=node('output','deep-count');
  count.setAttribute('aria-live','polite');
  filters.append(searchField,family.field,zone.field,count);
  const hero=node('div','deep-feature');
  const cards=node('div','deep-grid');
  const credits=node('details','deep-credits');
  credits.append(node('summary','','Sources et lecture des images'));
  const note=node('div','deep-credit-content');
  credits.append(note);
  let disposed=false;
  credits.ontoggle=async () => {
    if (!credits.open || note.dataset.loaded) return;
    note.dataset.loaded='pending';
    try {
      const response=await fetch(assetUrl('deep-atlas-credits.txt'));
      if (!response.ok) throw new Error();
      const source=await response.text();
      if (!disposed) for (const part of source.split(/(https?:\/\/\S+)/g)) {
        note.append(part.startsWith('https://')||part.startsWith('http://')?sourceLink(part,part):document.createTextNode(part));
      }
    } catch {
      delete note.dataset.loaded;
      if (!disposed) note.textContent='Les références complètes accompagnent le jeu dans web/assets/deep-atlas-credits.txt.';
    }
  };
  function card(body,featured) {
    const article=node('article',featured?'deep-hero':'deep-card');
    const button=node('button','deep-travel');
    button.type='button'; button.dataset.deepTravel=body.id;
    button.setAttribute('aria-label','Observer '+body.name);
    button.onclick=()=>travel(body.id);
    const artwork=node('div',body.radiusBasis==='field'?'deep-artwork deep-field':'deep-artwork');
    const image=node('img');
    image.alt=''; image.decoding='async'; image.loading=featured?'eager':'lazy';
    if (featured) image.fetchPriority='high';
    image.src=assetUrl('deep-thumb-'+body.id+'.webp');
    const plate=body.id==='orion-nebula'?'orion-vis':body.radiusBasis==='field' && photos[body.id]?body.id:null;
    if (featured && plate) {
      const picture=node('picture');
      const source=node('source');
      source.media='(min-width: 680px), (min-resolution: 1.5dppx)';
      source.srcset=assetUrl('plate-'+plate+'.webp');
      picture.append(source,image);
      artwork.append(picture);
    } else artwork.append(image);
    const copy=node('div','deep-copy');
    const designation=body.designation.split(' · ')[0];
    const tag=designation.toLowerCase()===body.name.toLowerCase()?body.category:designation;
    const origin=node('p','deep-origin',tag+' · '+shortDistance(body));
    copy.append(origin,node(featured?'h3':'h4','deep-name',body.name));
    const note=featured?body.observation:body.category;
    copy.append(node('p','deep-description',note));
    if(featured) copy.append(node('span','deep-action','Observer'));
    else artwork.append(node('span','deep-arrow','↗'));
    button.append(artwork,copy);
    article.append(button);
    const byline=node('p','deep-byline');
    if (body.sourceUrl && photos[body.id]) byline.append(sourceLink(photos[body.id],body.sourceUrl));
    else if (esoImages[body.id]) byline.append(sourceLink(photos[body.id], 'https://www.eso.org/public/images/'+esoImages[body.id]+'/'));
    else byline.textContent = photos[body.id] || plateKind(body)+(body.system?' · jour zéro':' · étoiles XHIP');
    if (body.sourceUrl && !photos[body.id]) byline.append(' · ',sourceLink('Fiche de mission',body.sourceUrl));
    article.append(byline);
    return article;
  }
  function filter() {
    const familyValue=family.select.value;
    const phenomenon=phenomena.find(([value])=>value===familyValue);
    const term=searchKey(search.value);
    const filtered=familyValue!=='all'||zone.select.value!=='all'||Boolean(term);
    if (filtered && hero.previousElementSibling!==filters) filters.after(hero);
    if (!filtered && gallery.firstElementChild!==hero) gallery.prepend(hero);
    const matching=discovered.filter(b=>(phenomenon?phenomenon[2](b):familyValue==='all'||b.kind===familyValue) &&
      (zone.select.value==='all'||region(b)===zone.select.value) && searchIndex.get(b.id).some(s=>s.includes(term)));
    count.textContent=matching.length+' destination'+(matching.length===1?'':'s');
    hero.replaceChildren(); cards.replaceChildren();
    if (matching.length) {
      hero.append(card(matching[0],true));
      cards.append(...matching.slice(1).map(b=>card(b,false)));
    } else {
      const empty=node('div','deep-empty');
      empty.append(node('p','','Aucune destination pour cette combinaison.'));
      const reset=node('button','chart-secondary','Afficher toute la galerie');
      reset.type='button'; reset.onclick=()=>{family.select.value='all';zone.select.value='all';search.value='';filter();search.focus();};
      empty.append(reset); hero.append(empty);
    }
  }
  family.select.onchange=zone.select.onchange=filter;
  search.oninput=filter;
  gallery.append(hero,discoveryTools(options),filters,cards,credits);
  container.replaceChildren(gallery);
  filter();
  return () => { disposed=true; };
}
