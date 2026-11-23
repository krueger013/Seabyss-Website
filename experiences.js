const worlds = [
  {id:'moon', name:'Lune', description:'Au bord d’un cratère', color:'#adbcc8'},
  {id:'mars', name:'Mars', description:'Dans une vallée rouge', color:'#d98f62'},
  {id:'europa', name:'Europe', description:'Sur la glace fracturée', color:'#a5d8e3'},
  {id:'titan', name:'Titan', description:'Sous un ciel orange', color:'#e2b47c'},
  {id:'mercury',name:'Mercure',description:'Dans le bassin Caloris',color:'#c0aca0'},
  {id:'enceladus',name:'Encelade',description:'Au bord des failles australes',color:'#ceddf6'},
  {id:'ganymede',name:'Ganymède',description:'Le long des sillons d’Arbela',color:'#cabdcf'}
];

export function experienceLinks({surfaces,pilot,phenomena,sandbox,climate,relativity,waves,phase,traveller,solar,events}) {
  const choices = [
    ['events','fragments','Cataclysmes cosmiques',events],
    ['traveller','navigate','Comètes et sondes',traveller],
    ['solar','eclipse','Soleil observé',solar],
    ['phase','eclipse','Observatoire des phases',phase],
    ['surfaces','terrain','Expéditions au sol',surfaces],
    ['pilot','navigate','Piloter une descente',pilot],
    ['phenomena','eclipse','Phénomènes',phenomena],
    ['shatter','fragments','Collision et débris',sandbox],
    ['climate','climate','Climat planétaire',climate]
  ];
  if (typeof relativity==='function') choices.push(['relativity','gravity','Laboratoire des trous noirs',relativity]);
  if (typeof waves==='function') choices.push(['waves','waves','Ondes gravitationnelles',waves]);
  const row = document.createElement('div');
  row.className = 'experience-links';
  for (const [key, symbol, title, action] of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.experience = key;
    button.innerHTML = '<i data-icon="'+symbol+'"></i><span>'+title+'</span>';
    button.onclick = action;
    row.append(button);
  }
  return row;
}

export function renderLandingChoices(panel,{worlds:choices,start}) {
  const text=document.createElement('p');
  text.className='landing-intro';
  text.textContent='Gère ta poussée et ta vitesse. Pose-toi près de la balise et poursuis l’expédition à pied.';
  const list=document.createElement('div');
  list.className='pilot-choices';
  for (const id of choices) {
    const world=worlds.find(item=>item.id===id);
    const button=document.createElement('button');
    button.type='button';
    button.dataset.landingChoice=id;
    button.className='archive-entry';
    button.textContent=world.name+' · '+world.description;
    button.onclick=()=>start(id);
    list.append(button);
  }
  panel.append(text,list);
}
