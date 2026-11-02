(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const engine = window.PetEngine;
  const store = engine.createStore();
  const stages = { egg: 'Dans son œuf', baby: 'Petit bébé', teen: 'Junior curieux', adult: 'Grand compagnon' };
  const stageOrder = ['egg', 'baby', 'teen', 'adult'];
  const dialog = $('main-dialog');
  const content = $('dialog-content');
  let state = store.getState();
  let night = false;
  let toastTimer;
  const audio = window.PetAudio.create();
  let lastSoundAt = -Infinity;
  let lastTouch = 0;
  let miniGameRunning = false;
  let activeDialog = '';
  let speechUntil = 0;
  const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const active = () => state.pets.find(pet => pet.id === state.activePetId);
  const infoFor = pet => engine.species.find(info => info.id === pet.species);

  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.add('visible');
    toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500);
  }

  function sound(kind) {
    lastSoundAt = performance.now();
    audio.play(kind);
  }

  function refreshAudioUI() {
    const enabled = state.settings.sound || state.settings.music;
    const toggle = $('sound-toggle');
    toggle.classList.toggle('on', enabled);
    toggle.textContent = enabled ? '♫' : '♪';
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.setAttribute('aria-label', enabled ? 'Couper la musique et les sons' : 'Activer la musique et les sons');
    toggle.title = enabled ? 'Couper la musique et les sons' : 'Activer la musique et les sons';
    for (const key of ['sound', 'music']) {
      const control = $('settings-' + key);
      if (control) {
        control.textContent = state.settings[key] ? 'Activés' : 'Désactivés';
        if (key === 'music') control.textContent = state.settings[key] ? 'Activée' : 'Désactivée';
        control.setAttribute('aria-pressed', String(state.settings[key]));
      }
      const slider = $(key + '-volume');
      if (slider) {
        const value = Math.round(state.settings[key + 'Volume'] * 100);
        slider.value = value;
        $(key + '-volume-value').textContent = value + ' %';
        slider.setAttribute('aria-valuetext', value + ' pour cent');
      }
    }
  }

  function particles(symbol = '♡', count = 7) {
    for (let i = 0; i < count; i++) {
      const particle = document.createElement('span');
      particle.className = 'particle';
      particle.textContent = Array.isArray(symbol) ? symbol[i % symbol.length] : symbol;
      particle.style.left = `${38 + Math.random() * 24}%`;
      particle.style.top = `${51 + Math.random() * 20}%`;
      particle.style.color = ['#f4b9be', '#ffe4a0', '#fff2d9'][i % 3];
      particle.style.animationDelay = `${i * .07}s`;
      $('effects-layer').append(particle);
      setTimeout(() => particle.remove(), 2200);
    }
  }

  function sceneAnimation(name) {
    $('scene').classList.remove(name);
    void $('scene').offsetWidth;
    $('scene').classList.add(name);
    setTimeout(() => $('scene').classList.remove(name), 1500);
  }

  function speech(title, subtitle, duration = 0) {
    $('pet-speech').replaceChildren(document.createTextNode(title));
    const sub = document.createElement('span');
    sub.textContent = subtitle;
    $('pet-speech').append(sub);
    speechUntil = duration ? Date.now() + duration : 0;
  }

  function mood(pet) {
    if (pet.stage === 'egg') return ['Un petit cœur bien au chaud', 'Toc, toc… quelqu’un est là ?', 'Clique sur l’œuf pour lui donner de la chaleur.'];
    if (pet.sleeping) return ['Au pays des jolis rêves', 'Chuuut… je rêve de toi.', 'Je récupère 5 points d’énergie par minute.'];
    if (pet.needs.food < 35) return ['Une petite faim à combler', 'Mon petit ventre gargouille…', 'Quelques baies du jardin me feraient plaisir.'];
    if (pet.needs.energy < 30) return ['Une sieste lui ferait du bien', 'Mes paupières sont lourdes…', 'Un petit dodo et je serai en pleine forme.'];
    if (pet.needs.clean < 35) return ['Un peu de mousse et de douceur', 'J’ai exploré toutes les flaques !', 'On fait un bain plein de petites bulles ?'];
    if (pet.needs.happiness < 40) return ['Envie d’un moment avec toi', 'Tu viens jouer avec moi ?', 'Un câlin ou un mini-jeu et tout va mieux.'];
    return ['Heureux comme tout', 'C’est encore mieux quand tu es là ♡', 'Un petit câlin ? Clique sur moi !'];
  }

  function render(next) {
    state = next;
    const pet = active();
    audio.configure(state.settings, { sleeping: !!pet?.sleeping, miniGame: miniGameRunning });
    refreshAudioUI();
    $('coins').textContent = state.coins.toLocaleString('fr-CA');
    $('save-status').innerHTML = state.saveAvailable ? '<i></i> Ton aventure se sauvegarde toute seule' : '<i></i> Sauvegarde indisponible · exporte ton aventure dans les options';
    $('decor-lantern').hidden = !state.inventory.includes('lantern');
    $('decor-mushrooms').hidden = !state.inventory.includes('mushrooms');
    $('scene').classList.toggle('night', night || !!pet?.sleeping);
    if (!pet) {
      $('egg').hidden = true;
      $('pet-image').hidden = false;
      $('pet-accessory').hidden = true;
      $('sleep-letters').hidden = true;
      $('pet-zone').className = 'pet-zone baby';
      return;
    }
    const info = infoFor(pet);
    const isEgg = pet.stage === 'egg';
    $('pet-name').textContent = pet.name;
    $('welcome-copy').textContent = isEgg ? `${pet.name} attend de te rencontrer. Une belle amitié se prépare !` : `${pet.name} est chez lui, et toi aussi. Fais comme chez toi.`;
    $('stage-label').textContent = stages[pet.stage];
    $('species-label').textContent = info.label;
    $('pet-image').src = info.asset;
    $('pet-image').alt = `${pet.name}, ${info.label.toLowerCase()}`;
    $('pet-image').hidden = isEgg;
    $('egg').hidden = !isEgg;
    $('pet-zone').className = `pet-zone ${pet.stage}${pet.sleeping ? ' sleeping' : ''}`;
    $('pet-button').setAttribute('aria-label', isEgg ? `Réchauffer l’œuf de ${pet.name}, ${pet.eggWarmth}%` : pet.sleeping ? `Réveiller ${pet.name}` : `Faire un câlin à ${pet.name}`);
    $('pet-nametag').replaceChildren(document.createTextNode(pet.name + ' '));
    const heart = document.createElement('span'); heart.textContent = '♡'; $('pet-nametag').append(heart);
    $('sleep-letters').hidden = !pet.sleeping;
    const accessory = engine.catalog.find(item => item.id === pet.accessory);
    $('pet-accessory').textContent = accessory?.icon || '';
    $('pet-accessory').hidden = !accessory || isEgg;
    $('pet-accessory').style.top = accessory?.id === 'bow' ? '65%' : '';
    $('pet-accessory').style.right = accessory?.id === 'bow' ? '40%' : '';
    const currentMood = mood(pet);
    $('mood-line').innerHTML = `<span>${pet.sleeping ? '☾' : '♡'}</span> ${escape(currentMood[0])}`;
    if (Date.now() > speechUntil) speech(currentMood[1], currentMood[2]);
    $('sleep-label').textContent = pet.sleeping ? 'On se lève' : 'Au dodo';
    $('sleep-caption').textContent = pet.sleeping ? 'Coucou le monde' : 'De beaux rêves';
    document.querySelectorAll('[data-need]').forEach(row => {
      const value = Math.round(pet.needs[row.dataset.need]);
      row.querySelector('strong').innerHTML = `${value}<small>%</small>`;
      row.querySelector('.need-track>span').style.width = `${value}%`;
      row.querySelector('[role=progressbar]').setAttribute('aria-valuenow', value);
      row.classList.toggle('low', value < 30);
    });
    let progress, growthNumber, growthTip;
    if (isEgg) {
      progress = pet.eggWarmth;
      growthNumber = `${Math.round(pet.eggWarmth / 20)} / 5 câlins`;
      growthTip = 'Réchauffe l’œuf avec 5 petits gestes de tendresse pour le faire éclore.';
    } else if (pet.stage === 'baby') {
      progress = pet.xp / 90 * 100;
      growthNumber = `${pet.xp} / 90 amitié`;
      growthTip = 'Les soins et les mini-jeux font grandir votre amitié. Prochaine étape : junior !';
    } else if (pet.stage === 'teen') {
      progress = (pet.xp - 90) / 130 * 100;
      growthNumber = `${pet.xp} / 220 amitié`;
      growthTip = 'Ton compagnon a bien grandi ! Continue à partager des petits bonheurs.';
    } else {
      progress = 100;
      growthNumber = `${pet.xp} amitié`;
      growthTip = 'Une grande amitié ! Continue à jouer, collectionner et prendre soin de lui.';
    }
    $('growth-number').textContent = growthNumber;
    $('growth-fill').style.width = `${Math.min(100, progress)}%`;
    $('growth-tip').textContent = growthTip;
    document.querySelectorAll('[data-stage]').forEach(step => {
      step.classList.toggle('current', step.dataset.stage === pet.stage);
      step.classList.toggle('past', stageOrder.indexOf(step.dataset.stage) < stageOrder.indexOf(pet.stage));
    });
    $('scene-hint').innerHTML = `<span>✧</span> ${isEgg ? `Réchauffe ton œuf · ${Math.round(pet.eggWarmth / 20)} / 5` : pet.sleeping ? 'Une sieste toute douce · +5 énergie par minute' : `${pet.careCount} petits moments partagés ensemble`}`;
    $('little-note').textContent = isEgg ? 'Chaque clic réchauffe son petit cœur. Il sera bientôt prêt à te rencontrer.' : pet.stage === 'adult' ? 'Tu peux adopter les quatre compagnons. Chacun garde sa propre histoire.' : 'Les baies sont toujours gratuites. Ici, on trouve toujours de quoi prendre soin de son ami.';
  }

  function openDialog(kind, html) {
    if (activeDialog !== kind) sound('open');
    activeDialog = kind;
    content.innerHTML = html;
    $('dialog-close').hidden = false;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
  }

  function closeDialog(silent = false) {
    if (!silent) sound('close');
    dialog.close();
    activeDialog = '';
    document.body.style.overflow = '';
  }

  const heading = (tag, title, description) => `<div class="dialog-heading"><p class="eyebrow">${tag}</p><h2 id="dialog-title">${title}</h2><p>${description}</p></div>`;

  function adoption() {
    const available = engine.species.filter(info => !state.pets.some(pet => pet.species === info.id));
    if (!available.length) return collection();
    let choice = available[0].id;
    openDialog('adoption', heading('UNE BELLE HISTOIRE COMMENCE', 'Qui fera battre ton cœur ?', 'Choisis ton petit compagnon. Tout commence dans un œuf,<br>et grandit avec un peu d’amour.') +
      `<div class="adoption-grid">${available.map((info, index) => `<button class="adoption-card ${index === 0 ? 'selected' : ''}" data-species="${info.id}" aria-pressed="${index === 0}"><img src="${info.asset}" alt="${info.label}"><strong>${info.label}</strong><small>${info.name}</small></button>`).join('')}</div><div class="adoption-description" id="adoption-description">${escape(available[0].description)}</div><form id="adoption-form"><label class="name-field">Son petit nom<input id="pet-name-input" name="petname" maxlength="18" value="${available[0].name}" autocomplete="off" required></label><button class="primary-button" type="submit">Adopter mon compagnon <span aria-hidden="true">♡</span></button></form><p class="adoption-footer">Adoption gratuite · Tu pourras accueillir les quatre compagnons.</p>`);
    $('dialog-close').hidden = state.pets.length === 0;
    content.querySelectorAll('[data-species]').forEach(button => button.addEventListener('click', () => {
      choice = button.dataset.species;
      const info = engine.species.find(item => item.id === choice);
      content.querySelectorAll('[data-species]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', item === button); });
      $('adoption-description').textContent = info.description;
      $('pet-name-input').value = info.name;
      sound('select');
    }));
    $('adoption-form').addEventListener('submit', event => {
      event.preventDefault();
      const result = store.adopt(choice, $('pet-name-input').value);
      if (result.ok) { closeDialog(true); sound('start'); particles(['✦', '♡']); }
      toast(result.message);
    });
  }

  function collection() {
    if (!state.pets.length) return adoption();
    openDialog('collection', heading('UNE FAMILLE TOUTE DOUCE', 'Mes petits compagnons', 'Chacun grandit à son rythme et garde ses petits souvenirs.') +
      `<div class="collection-list">${state.pets.map(pet => `<button class="collection-pet" data-pet="${pet.id}"><img src="${infoFor(pet).asset}" alt=""><span><strong>${escape(pet.name)}</strong><small>${stages[pet.stage]} · ${infoFor(pet).label}${pet.sleeping ? ' · Au dodo' : ''}</small></span><span>${pet.id === state.activePetId ? 'Avec toi ♡' : 'Retrouver ↗'}</span></button>`).join('')}</div>${state.pets.length < 4 ? '<button class="primary-button" id="new-pet-button">Accueillir un nouvel ami ＋</button>' : '<p class="adoption-footer">Les quatre petits cœurs sont réunis. Ta famille est au complet ♡</p>'}`);
    content.querySelectorAll('[data-pet]').forEach(button => button.addEventListener('click', () => {
      speechUntil = 0;
      store.selectPet(button.dataset.pet);
      closeDialog(true); sound('select');
    }));
    $('new-pet-button')?.addEventListener('click', adoption);
  }

  function foodMenu() {
    openDialog('food', heading('UN PETIT FESTIN', 'Qu’est-ce qu’on grignote ?', 'Un ventre heureux, c’est le début d’une belle journée.') +
      `<div class="food-grid">${engine.foods.map(food => `<button class="food-card" data-food="${food.id}" ${state.coins < food.price ? 'disabled' : ''}><span class="food-emoji">${food.icon}</span><strong>${food.name}</strong><small>+${food.food} petit ventre<br>+${food.xp} amitié</small><span class="price">${food.price ? `${food.price} ✦` : 'Toujours gratuit ♡'}</span></button>`).join('')}</div>`);
    content.querySelectorAll('[data-food]').forEach(button => button.addEventListener('click', () => { closeDialog(true); care('feed', button.dataset.food); }));
  }

  function shop() {
    if (!active()) return adoption();
    openDialog('shop', heading('LES PETITS TRÉSORS', 'Un jardin à votre image', 'Des accessoires tout doux et quelques touches de magie.') +
      `<p class="shop-wallet">Ta tirelire : ${state.coins} étoiles ✦</p><div class="shop-grid">${engine.catalog.map(item => {
        const owned = state.inventory.includes(item.id);
        const equipped = active().accessory === item.id;
        return `<div class="shop-card ${owned ? 'owned' : ''}"><span class="shop-icon">${item.icon}</span><strong>${item.name}</strong><p>${item.description}</p><button class="secondary-button" data-shop="${item.id}" ${!owned && state.coins < item.price || owned && item.type === 'decoration' ? 'disabled' : ''}>${owned ? item.type === 'decoration' ? 'Dans ton jardin ✓' : equipped ? 'Retirer' : 'Porter' : `Adopter · ${item.price} ✦`}</button></div>`;
      }).join('')}</div><p class="adoption-footer">Gagne des étoiles dans les mini-jeux. Tous les achats se font avec les étoiles du jeu.</p>`);
    content.querySelectorAll('[data-shop]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.shop;
      const item = engine.catalog.find(entry => entry.id === id);
      const owned = state.inventory.includes(id);
      let result;
      if (state.inventory.includes(id)) result = store.interact('equip', active().accessory === id ? null : id);
      else {
        result = store.buy(id);
        if (result.ok && item.type === 'accessory') store.interact('equip', id);
      }
      toast(result.message);
      sound(result.ok ? owned ? 'equip' : 'purchase' : 'miss');
      shop();
    }));
  }

  function showHelp() {
    openDialog('help', heading('BIENVENUE DANS TON PETIT MONDE', 'Les petits gestes qui comptent', 'Pas de course : ici, on prend le temps de grandir.') +
      `<ol class="help-content"><li><strong>Choisis et nomme ton compagnon.</strong> Clique cinq fois sur son œuf pour le réchauffer et le faire éclore.</li><li><strong>Veille à ses quatre besoins.</strong> Nourris-le, lave-le, câline-le et laisse-le dormir. Les baies sont gratuites ; une sieste rend 5 points d’énergie par minute.</li><li><strong>Partage des mini-jeux.</strong> Attrape des fruits, retrouve des paires ou joue en rythme pour gagner des étoiles et de l’amitié.</li><li><strong>Grandissez ensemble.</strong> À 90 points d’amitié, ton bébé devient junior. À 220, il devient adulte : il grandit à l’écran et scintille !</li><li><strong>Crée ta petite famille.</strong> Adopte les quatre animaux et décore le jardin à la boutique. Leurs besoins évoluent doucement, même pendant ton absence (8 heures maximum).</li></ol><p class="settings-note">Le jeu se sauvegarde dans ce navigateur. Garde le même fichier et le même navigateur pour retrouver ton aventure. Tu peux aussi exporter une copie dans les options. Aucun compte, aucune publicité.</p>`);
  }

  function settings() {
    openDialog('settings', heading('TON PETIT COIN TRANQUILLE', 'Options & souvenirs', 'Garde une copie de votre histoire, juste au cas où.') +
      `<div class="audio-settings">
        <section class="audio-setting"><div class="audio-setting-heading"><div><strong id="sound-label">✧ Petits bruitages</strong><small>Câlins, bulles, gourmandises et petites victoires.</small></div><button class="secondary-button" id="settings-sound" aria-describedby="sound-label" data-sound-silent></button></div><label class="volume-label" for="sound-volume">Volume des bruitages<output id="sound-volume-value" for="sound-volume"></output></label><input id="sound-volume" type="range" min="0" max="100" step="1" value="55"><button class="audio-preview" id="preview-sound" data-sound-silent>▷ Écouter un petit son</button></section>
        <section class="audio-setting"><div class="audio-setting-heading"><div><strong id="music-label">♫ Musique douce</strong><small>Sherwood · Chris Murphy</small></div><button class="secondary-button" id="settings-music" aria-describedby="music-label" data-sound-silent></button></div><label class="volume-label" for="music-volume">Volume de la musique<output id="music-volume-value" for="music-volume"></output></label><input id="music-volume" type="range" min="0" max="100" step="1" value="20"><p class="audio-caption">Une boucle tranquille, encore plus discrète pendant les siestes et les mini-jeux.</p></section>
      </div><details class="audio-credits"><summary>Des sons gratuits, choisis avec soin · CC0</summary><p>Bruitages : <a href="https://kenney.nl/assets/interface-sounds" target="_blank" rel="noopener noreferrer">Interface Sounds — Kenney</a>.<br>Musique : <a href="https://opengameart.org/content/sherwood" target="_blank" rel="noopener noreferrer">Sherwood — Chris Murphy</a>.<br>Licences CC0, sources et crédits conservés dans le dossier du jeu.</p></details>
      <div class="settings-actions"><button class="secondary-button" id="export-save">↓ Exporter ma sauvegarde</button><label class="import-label" for="import-save">↑ Choisir une sauvegarde à restaurer</label><input type="file" id="import-save" accept="application/json,.json"><p class="settings-note">Restaurer une sauvegarde remplace la partie de ce navigateur. Exporte la partie actuelle pour en garder une copie avant de confirmer la restauration.</p></div><p class="settings-note">${state.saveAvailable ? '✓ La sauvegarde automatique fonctionne sur cet appareil.' : 'Le navigateur refuse la sauvegarde automatique. Exporte régulièrement ton aventure.'}<br>La musique démarre après ton premier clic et se met en pause quand tu quittes l’onglet. Tout fonctionne sans connexion Internet.</p>`);
    refreshAudioUI();
    for (const key of ['sound', 'music']) {
      $('settings-' + key).addEventListener('click', () => {
        store.setSetting(key, !state.settings[key]);
        if (key === 'sound' && state.settings.sound) sound('cuddle');
      });
      $(key + '-volume').addEventListener('input', event => store.setSetting(key + 'Volume', Number(event.target.value) / 100));
    }
    $('sound-volume').addEventListener('change', () => sound('tap'));
    $('preview-sound').addEventListener('click', () => {
      if (!state.settings.sound || state.settings.soundVolume === 0) return toast('Active les bruitages et monte leur volume pour écouter.');
      sound('wash');
    });
    $('export-save').addEventListener('click', () => {
      const blob = new Blob([store.exportSave()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `petits-compagnons-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); sound('export'); toast('Une copie de ton aventure est prête à être conservée.');
    });
    $('import-save').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 1000000) { toast('Ce fichier est trop volumineux pour une sauvegarde.'); event.target.value = ''; return; }
      try {
        const text = await file.text();
        openDialog('restore', heading('RETROUVER VOTRE HISTOIRE', 'Restaurer cette sauvegarde ?', `Fichier choisi : ${escape(file.name)}<br>La partie actuelle sera remplacée si le fichier est valide.`) + '<div class="settings-actions"><button class="primary-button" id="confirm-restore">Restaurer cette aventure</button><button class="secondary-button" id="cancel-restore">Garder ma partie actuelle</button></div>');
        $('cancel-restore').addEventListener('click', settings);
        $('confirm-restore').addEventListener('click', () => {
          speechUntil = 0;
          const result = store.importSave(text);
          toast(result.message);
          if (result.ok) { closeDialog(true); sound('import'); render(store.getState()); if (!active()) adoption(); }
          else { sound('miss'); settings(); }
        });
      } catch (_) { toast('Impossible de lire cette sauvegarde. Essaie un fichier JSON exporté par le jeu.'); }
    });
  }

  function toggleSound() {
    const enabled = !(state.settings.sound || state.settings.music);
    store.setSetting('sound', enabled);
    store.setSetting('music', enabled);
    if (enabled) sound('cuddle');
  }

  function care(action, payload) {
    const pet = active();
    if (!pet) return adoption();
    if (pet.stage === 'egg') action = 'warm';
    if (action === 'feed' && !payload) {
      if (pet.sleeping) return toast('Un petit réveil en douceur avant de passer à table.');
      return foodMenu();
    }
    if (action === 'games') return showGames();
    speechUntil = 0;
    const result = store.interact(action, payload);
    toast(result.message);
    if (!result.ok) { sound('miss'); return; }
    if (action === 'warm') {
      $('egg').classList.remove('warming'); void $('egg').offsetWidth; $('egg').classList.add('warming');
      particles(['♡', '✦'], 5); sound(result.hatched ? 'hatch' : 'warm');
    } else if (action === 'wash') { sceneAnimation('washing'); particles('🫧', 6); sound('wash'); }
    else if (action === 'feed') { sceneAnimation('feeding'); particles('✦', 4); sound('feed'); }
    else if (action === 'cuddle') { sceneAnimation('care-flash'); particles('♡'); sound('cuddle'); }
    else sound(active().sleeping ? 'sleep' : 'wake');
    if (result.hatched) {
      sceneAnimation('hatching'); particles(['✦', '♡', '✿'], 16);
      speech(`Coucou ! Moi, c’est ${active().name} ♡`, 'Je suis si content de te rencontrer.', 6000);
    } else if (result.stageChanged) celebrateEvolution();
  }

  function celebrateEvolution() {
    sceneAnimation('hatching'); particles(['✦', '✿', '♡'], 15); sound('evolve');
    const pet = active();
    speech('Regarde, j’ai grandi !', `${pet.name} est maintenant ${pet.stage === 'teen' ? 'junior' : 'adulte'} ♡`, 7000);
    toast(`${pet.name} a évolué ! Votre amitié le fait grandir ♡`);
  }

  async function showGames() {
    if (active()?.sleeping) return toast('Réveille ton compagnon avant de partir jouer ensemble.');
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) {} }
    $('games-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('games-section').classList.add('highlight');
    setTimeout(() => $('games-section').classList.remove('highlight'), 2500);
    toast('Choisis une petite aventure ci-dessous !');
  }

  async function startGame(type) {
    const pet = active();
    if (!pet) return adoption();
    if (pet.stage === 'egg') return toast('Encore quelques câlins sur ton œuf avant de pouvoir jouer !');
    if (pet.sleeping) return toast('Ton compagnon fait dodo. Réveille-le avant de jouer.');
    if (miniGameRunning) return;
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) {} }
    miniGameRunning = true;
    audio.configure(state.settings, { sleeping: false, miniGame: true });
    sound('open');
    let evolvedDuringGame = false;
    document.querySelector('.app-shell').inert = true;
    window.PetMiniGames.open(type, {
      sound,
      onReward(reward) {
        const result = store.reward(reward);
        if (result.stageChanged) evolvedDuringGame = true;
      },
      onClose() {
        miniGameRunning = false;
        document.querySelector('.app-shell').inert = false;
        document.querySelector(`[data-game="${type}"]`).focus();
        render(store.getState());
        if (evolvedDuringGame) celebrateEvolution();
        else sound('close');
      }
    });
  }

  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.nav === 'pets') collection();
    else if (button.dataset.nav === 'shop') shop();
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  document.querySelectorAll('[data-care]').forEach(button => button.addEventListener('click', () => care(button.dataset.care)));
  document.querySelectorAll('[data-game]').forEach(button => button.addEventListener('click', () => startGame(button.dataset.game)));
  $('pet-button').addEventListener('click', () => {
    if (Date.now() - lastTouch < 250) return;
    lastTouch = Date.now();
    care(active()?.sleeping ? 'wake' : 'cuddle');
  });
  $('collection-button').addEventListener('click', collection);
  $('settings-button').addEventListener('click', settings);
  $('sound-toggle').addEventListener('click', toggleSound);
  $('help-button').addEventListener('click', showHelp);
  $('dialog-close').addEventListener('click', () => closeDialog());
  dialog.addEventListener('cancel', event => {
    if (!state.pets.length && activeDialog === 'adoption') event.preventDefault();
    else sound('close');
  });
  dialog.addEventListener('close', () => { activeDialog = ''; document.body.style.overflow = ''; });
  $('day-button').addEventListener('click', () => setNight(false));
  $('night-button').addEventListener('click', () => setNight(true));
  function setNight(value) {
    night = value;
    $('day-button').classList.toggle('selected', !night);
    $('night-button').classList.toggle('selected', night);
    $('day-button').setAttribute('aria-pressed', !night);
    $('night-button').setAttribute('aria-pressed', night);
    render(state); sound(night ? 'night' : 'day');
  }
  $('fullscreen-button').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector('.garden-panel').requestFullscreen();
    } catch (_) { toast('Le plein écran n’est pas disponible dans ce navigateur.'); }
  });
  document.addEventListener('fullscreenchange', () => {
    const expanded = !!document.fullscreenElement;
    (document.fullscreenElement || document.body).append($('toast'));
    $('fullscreen-button').setAttribute('aria-label', expanded ? 'Quitter le plein écran' : 'Afficher le jardin en plein écran');
    $('fullscreen-button').title = expanded ? 'Quitter le plein écran' : 'Plein écran';
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) store.tick(); });
  window.addEventListener('pagehide', () => store.tick());
  // Un vrai geste débloque la musique dans les navigateurs qui limitent l’autoplay.
  document.addEventListener('pointerdown', () => audio.unlock(), { capture: true });
  document.addEventListener('keydown', event => { if (!event.repeat) audio.unlock(); }, { capture: true });
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || button.hasAttribute('data-sound-silent') || button.closest('#minigame-overlay') || performance.now() - lastSoundAt < 100) return;
    sound('tap');
  });
  store.subscribe(render);
  render(state);
  store.tick();
  setInterval(() => { if (!document.hidden) store.tick(); }, 5000);
  if (!state.pets.length) adoption();
  if (state.recoveredSave) toast('Une ancienne sauvegarde est illisible. Tu peux restaurer une copie dans les options.');
})();
