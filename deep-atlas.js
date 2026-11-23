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
  'm87':'NASA, STScI et WikiSky', 'sombrero':'NASA/ESA et Hubble Heritage Team (STScI/AURA)'
};
const esoImages = {'wild-duck':'eso1430a','eagle-nebula':'eso0926a','triangulum':'eso1424a','dumbbell-nebula':'eso9846a'};
const editorial = ['orion-nebula','pleiades','sombrero','trappist-1-e','crab-nebula','triangulum',
  'ring-nebula','hercules-cluster','55-cancri-e','eagle-nebula','m87','dumbbell-nebula','beehive',
  'hd-189733-b','bodes-galaxy','wild-duck','kepler-186-f','lagoon-nebula','carina-nebula'];
const format = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const kindOptions = [['all','Toutes les familles'],['nebula','Nébuleuses'],['cluster','Amas d’étoiles'],['galaxy','Galaxies'],['planet','Exoplanètes'],['star','Étoiles']];
const regionOptions = [['all','Toutes les régions'],['galactic','Voie lactée'],['extragalactic','Au-delà de la Voie lactée'],['exoplanetaires','Systèmes exoplanétaires']];
function node(tag, klass, text) {
  const result = document.createElement(tag);
  if (klass) result.className = klass;
  if (text) result.textContent = text;
  return result;
}
function region(body) { return body.system ? 'exoplanetaires' : body.kind === 'galaxy' ? 'extragalactic' : 'galactic'; }
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

export function createDeepAtlas(container, {objects, travel}) {
  const gallery=node('section','deep-gallery');
  gallery.setAttribute('aria-label','Découvrir le ciel profond');
  const discovered=objects.filter(b=>b.observation && !b.simulated);
  const rank=new Map(editorial.map((id,i)=>[id,i]));
  discovered.sort((a,b)=>(rank.get(a.id)??100)-(rank.get(b.id)??100) || a.name.localeCompare(b.name,'fr'));
  const filters=node('div','deep-filters');
  const family=selectFilter('data-deep-kind','Famille',kindOptions);
  const zone=selectFilter('data-deep-region','Région',regionOptions);
  const count=node('output','deep-count');
  count.setAttribute('aria-live','polite');
  filters.append(family.field,zone.field,count);
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
    const artwork=node('div','deep-artwork');
    const image=node('img');
    image.alt=''; image.decoding='async'; image.loading=featured?'eager':'lazy';
    image.src=assetUrl('deep-thumb-'+body.id+'.webp');
    artwork.append(image);
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
    if (esoImages[body.id]) byline.append(sourceLink(photos[body.id], 'https://www.eso.org/public/images/'+esoImages[body.id]+'/'));
    else byline.textContent = photos[body.id] || plateKind(body)+(body.system?' · jour zéro':' · étoiles XHIP');
    article.append(byline);
    return article;
  }
  function filter() {
    const matching=discovered.filter(b=>(family.select.value==='all'||b.kind===family.select.value) &&
      (zone.select.value==='all'||region(b)===zone.select.value));
    count.textContent=matching.length+' destination'+(matching.length===1?'':'s');
    hero.replaceChildren(); cards.replaceChildren();
    if (matching.length) {
      hero.append(card(matching[0],true));
      cards.append(...matching.slice(1).map(b=>card(b,false)));
    } else {
      const empty=node('div','deep-empty');
      empty.append(node('p','','Aucune destination pour cette combinaison.'));
      const reset=node('button','chart-secondary','Afficher toute la galerie');
      reset.type='button'; reset.onclick=()=>{family.select.value='all';zone.select.value='all';filter();family.select.focus();};
      empty.append(reset); hero.append(empty);
    }
  }
  family.select.onchange=zone.select.onchange=filter;
  gallery.append(filters,hero,cards,credits);
  container.replaceChildren(gallery);
  filter();
  return () => { disposed=true; };
}
