import {SANDBOX_SCENARIOS} from './sandbox-scenarios.js';

export function renderCosmicEvents(host,openSandbox,openSupernova) {
  const experiments = ['comet-train','starfall','moon-theft','roche-pass','shock-duel'];
  const scenarios=new Map(SANDBOX_SCENARIOS.map(scene=>[scene.id,scene]));
  const list=document.createElement('div');
  list.className='cosmic-events';
  function entry(id,name,detail,open) {
    const card=document.createElement('button');
    card.type='button';card.dataset.cosmicEvent=id;
    const title=document.createElement('strong'),note=document.createElement('span');
    title.textContent=name;note.textContent=detail;
    card.append(title,note);card.onclick=open;list.append(card);
  }
  entry('supernova','Après la supernova','Fais avancer le temps pour suivre le front de choc, puis observe le rémanent de Cassiopée A.',openSupernova);
  for (const id of experiments) {
    const scene=scenarios.get(id);
    entry(id,scene.name,scene.caption,()=>openSandbox(id));
  }
  host.replaceChildren(list);
}
