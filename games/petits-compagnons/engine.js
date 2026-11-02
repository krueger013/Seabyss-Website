(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PetEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SAVE_KEY = 'petits-compagnons-v1';
  const VERSION = 1;
  const MAX_OFFLINE_MS = 8 * 60 * 60 * 1000;
  const DEFAULT_SETTINGS = Object.freeze({ sound: true, music: true, soundVolume: .55, musicVolume: .20 });
  const species = [
    { id: 'cat', name: 'Mochi', label: 'Chaton feuille', description: 'Un petit gourmand qui adore les câlins et les siestes au soleil.', color: '#edbc94', asset: 'assets/cat.png' },
    { id: 'bunny', name: 'Luna', label: 'Lapin nuage', description: 'Une boule de douceur curieuse, toujours prête à jouer.', color: '#b8a8d5', asset: 'assets/bunny.png' },
    { id: 'fox', name: 'Sunny', label: 'Renard soleil', description: 'De grandes oreilles, un cœur tendre et mille aventures en tête.', color: '#efa36d', asset: 'assets/fox.png' },
    { id: 'dragon', name: 'Pistache', label: 'Dragon jardin', description: 'Un minuscule dragon qui fait pousser les sourires.', color: '#86bba3', asset: 'assets/dragon.png' }
  ];
  const catalog = [
    { id: 'flower', name: 'Fleur des prés', label: 'Fleur des prés', price: 25, type: 'accessory', icon: '🌸', description: 'Une jolie fleur à porter.' },
    { id: 'bow', name: 'Nœud papillon', label: 'Nœud papillon', price: 40, type: 'accessory', icon: '🎀', description: 'Pour les grandes et petites occasions.' },
    { id: 'crown', name: 'Couronne étoilée', label: 'Couronne étoilée', price: 90, type: 'accessory', icon: '👑', description: 'La vedette du jardin, c’est toi !' },
    { id: 'lantern', name: 'Lanterne magique', label: 'Lanterne magique', price: 60, type: 'decoration', icon: '🏮', description: 'Une douce lumière dans le jardin.' },
    { id: 'mushrooms', name: 'Petits champignons', label: 'Petits champignons', price: 45, type: 'decoration', icon: '🍄', description: 'Un coin de forêt enchantée.' }
  ];
  const foods = [
    { id: 'berries', name: 'Baies du jardin', label: 'Baies du jardin', price: 0, food: 24, xp: 6, icon: '🍓' },
    { id: 'carrot', name: 'Carotte croquante', label: 'Carotte croquante', price: 3, food: 34, xp: 8, icon: '🥕' },
    { id: 'soup', name: 'Soupe réconfortante', label: 'Soupe réconfortante', price: 6, food: 50, xp: 12, icon: '🍲' }
  ];

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const clone = value => JSON.parse(JSON.stringify(value));
  const cleanName = (name, fallback) => typeof name === 'string' ? name.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || fallback : fallback;
  const fail = message => ({ ok: false, message });
  const success = (message, extras) => Object.assign({ ok: true, message }, extras || {});

  function blankState(now) {
    return { version: VERSION, coins: 80, pets: [], activePetId: null, inventory: [], settings: Object.assign({}, DEFAULT_SETTINGS), lastTick: now };
  }

  function stageFor(pet) {
    if (pet.eggWarmth < 100) return 'egg';
    if (pet.xp >= 220) return 'adult';
    if (pet.xp >= 90) return 'teen';
    return 'baby';
  }

  function validateSave(raw, now) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION || !Array.isArray(raw.pets) || raw.pets.length > species.length || !finite(raw.coins)) {
      throw new Error('Cette sauvegarde n’est pas compatible avec le jeu.');
    }
    const result = blankState(now);
    result.coins = Math.floor(clamp(raw.coins, 0, 999999));
    result.inventory = Array.isArray(raw.inventory) ? [...new Set(raw.inventory.filter(id => catalog.some(item => item.id === id)))] : [];
    const savedSettings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) ? raw.settings : {};
    ['sound', 'music'].forEach(key => {
      if (typeof savedSettings[key] === 'boolean') result.settings[key] = savedSettings[key];
    });
    ['soundVolume', 'musicVolume'].forEach(key => {
      if (finite(savedSettings[key])) result.settings[key] = clamp(savedSettings[key], 0, 1);
    });
    result.lastTick = finite(raw.lastTick) ? clamp(raw.lastTick, 0, now) : now;
    const seenSpecies = new Set();
    const seenIds = new Set();
    result.pets = raw.pets.map((data, index) => {
      if (!data || typeof data !== 'object' || !species.some(s => s.id === data.species) || seenSpecies.has(data.species) || !data.needs || !['food', 'happiness', 'energy', 'clean'].every(key => finite(data.needs[key])) || !finite(data.xp) || !finite(data.eggWarmth)) {
        throw new Error('Un compagnon de cette sauvegarde ne peut pas être lu.');
      }
      seenSpecies.add(data.species);
      const info = species.find(s => s.id === data.species);
      let id = typeof data.id === 'string' && /^[a-zA-Z0-9_-]{1,70}$/.test(data.id) ? data.id : 'pet-' + data.species + '-' + index;
      if (seenIds.has(id)) id = 'pet-' + data.species + '-' + index;
      seenIds.add(id);
      const pet = {
        id, species: data.species, name: cleanName(data.name, info.name), stage: 'egg',
        xp: Math.floor(clamp(data.xp, 0, 999999)), eggWarmth: clamp(data.eggWarmth, 0, 100),
        needs: Object.fromEntries(['food', 'happiness', 'energy', 'clean'].map(key => [key, clamp(data.needs[key], 0, 100)])),
        sleeping: data.sleeping === true,
        createdAt: finite(data.createdAt) ? clamp(data.createdAt, 0, now) : now,
        hatchedAt: finite(data.hatchedAt) ? clamp(data.hatchedAt, 0, now) : null,
        careCount: finite(data.careCount) ? Math.floor(clamp(data.careCount, 0, 999999)) : 0,
        accessory: result.inventory.includes(data.accessory) && catalog.some(item => item.id === data.accessory && item.type === 'accessory') ? data.accessory : null
      };
      pet.stage = stageFor(pet);
      if (pet.stage === 'egg') { pet.sleeping = false; pet.xp = 0; pet.hatchedAt = null; }
      else if (pet.hatchedAt === null) pet.hatchedAt = pet.createdAt;
      return pet;
    });
    result.activePetId = result.pets.some(p => p.id === raw.activePetId) ? raw.activePetId : (result.pets[0] ? result.pets[0].id : null);
    return result;
  }

  function createStore(options) {
    options = options || {};
    const now = typeof options.now === 'function' ? options.now : Date.now;
    let storage = null;
    let saveAvailable = true;
    let recoveredSave = false;
    try { storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : (typeof localStorage !== 'undefined' ? localStorage : null); } catch (_) { saveAvailable = false; }
    if (!storage) saveAvailable = false;
    let state = blankState(now());
    const listeners = new Set();
    try {
      const saved = storage && storage.getItem(SAVE_KEY);
      if (saved) state = validateSave(JSON.parse(saved), now());
    } catch (_) { recoveredSave = true; }

    function getState() {
      return Object.assign(clone(state), { saveAvailable, recoveredSave });
    }
    function save() {
      if (!storage) return;
      try { storage.setItem(SAVE_KEY, JSON.stringify(state)); saveAvailable = true; } catch (_) { saveAvailable = false; }
    }
    function emit() {
      save();
      listeners.forEach(fn => { try { fn(getState()); } catch (error) { if (typeof console !== 'undefined') console.error('Affichage du compagnon :', error); } });
    }
    function active() { return state.pets.find(p => p.id === state.activePetId) || null; }
    function evolve(pet, xp) {
      const previous = pet.stage;
      pet.xp = clamp(pet.xp + xp, 0, 999999);
      pet.stage = stageFor(pet);
      return previous !== pet.stage;
    }
    function elapsedTick(timestamp) {
      if (!finite(timestamp) || timestamp <= state.lastTick) return false;
      const minutes = Math.min(timestamp - state.lastTick, MAX_OFFLINE_MS) / 60000;
      state.lastTick = timestamp;
      state.pets.forEach(pet => {
        if (pet.stage === 'egg') return;
        pet.needs.food = clamp(pet.needs.food - minutes * .3, 0, 100);
        pet.needs.happiness = clamp(pet.needs.happiness - minutes * .15, 0, 100);
        pet.needs.clean = clamp(pet.needs.clean - minutes * .2, 0, 100);
        pet.needs.energy = clamp(pet.needs.energy + minutes * (pet.sleeping ? 5 : -.18), 0, 100);
      });
      return true;
    }
    function tick(timestamp) {
      if (elapsedTick(timestamp === undefined ? now() : timestamp)) emit();
      return getState();
    }
    function adopt(speciesId, name) {
      const info = species.find(s => s.id === speciesId);
      if (!info) return fail('Ce petit animal n’existe pas.');
      const existing = state.pets.find(p => p.species === speciesId);
      if (existing) { state.activePetId = existing.id; emit(); return success(existing.name + ' est déjà dans ta famille.', { existing: true, petId: existing.id }); }
      const timestamp = now();
      elapsedTick(timestamp);
      const pet = {
        id: 'pet-' + speciesId + '-' + timestamp.toString(36), species: speciesId,
        name: cleanName(name, info.name), stage: 'egg', xp: 0, eggWarmth: 0,
        needs: { food: 76, happiness: 72, energy: 88, clean: 90 }, sleeping: false,
        createdAt: timestamp, hatchedAt: null, careCount: 0, accessory: null
      };
      state.pets.push(pet); state.activePetId = pet.id; emit();
      return success('L’œuf de ' + pet.name + ' t’attend !', { petId: pet.id });
    }
    function selectPet(id) {
      if (!state.pets.some(p => p.id === id)) return fail('Ce compagnon n’est pas dans ta famille.');
      elapsedTick(now()); state.activePetId = id; emit();
      return success(active().name + ' est avec toi.');
    }
    function interact(action, payload) {
      const pet = active();
      if (!pet) return fail('Choisis d’abord un petit compagnon.');
      elapsedTick(now());
      if (action === 'equip') {
        const id = payload && typeof payload === 'object' ? payload.id : payload;
        if (id === null || id === '' || id === 'none') { pet.accessory = null; emit(); return success('Accessoire retiré.'); }
        if (!state.inventory.includes(id) || !catalog.some(item => item.id === id && item.type === 'accessory')) return fail('Cet accessoire n’est pas encore dans ta collection.');
        pet.accessory = id; emit(); return success('Un nouveau look pour ' + pet.name + ' !');
      }
      if (pet.stage === 'egg') {
        if (action !== 'warm') return fail('Réchauffe d’abord ton œuf pour le faire éclore.');
        pet.eggWarmth = clamp(pet.eggWarmth + 20, 0, 100);
        pet.careCount++;
        const hatched = pet.eggWarmth >= 100;
        if (hatched) { pet.stage = 'baby'; pet.hatchedAt = now(); }
        emit();
        return success(hatched ? 'Bienvenue au monde, ' + pet.name + ' !' : 'Ton œuf se réchauffe… encore un peu de douceur !', { hatched, stageChanged: hatched });
      }
      if (action === 'sleep' || action === 'wake') {
        pet.sleeping = action === 'wake' ? false : !pet.sleeping;
        emit(); return success(pet.sleeping ? 'Chut… ' + pet.name + ' recharge ses petites batteries.' : 'Bonjour ' + pet.name + ', prêt pour une nouvelle aventure !');
      }
      if (pet.sleeping) return fail(pet.name + ' dort. Réveille-le doucement pour jouer.');
      let xp = 0;
      let message = '';
      if (action === 'feed') {
        const foodId = payload && typeof payload === 'object' ? (payload.id || payload.food) : payload;
        const meal = foods.find(f => f.id === (foodId || 'berries'));
        if (!meal) return fail('Choisis une gourmandise dans le panier.');
        if (pet.needs.food >= 96) return fail(pet.name + ' a déjà le ventre bien rempli !');
        if (state.coins < meal.price) return fail('Il te manque quelques étoiles. Les baies sont toujours gratuites !');
        state.coins -= meal.price;
        pet.needs.food = clamp(pet.needs.food + meal.food, 0, 100);
        pet.needs.happiness = clamp(pet.needs.happiness + 3, 0, 100);
        xp = meal.xp; message = 'Miam ! ' + pet.name + ' se régale.';
      } else if (action === 'wash') {
        if (pet.needs.clean >= 96) return fail(pet.name + ' est déjà tout propre !');
        pet.needs.clean = clamp(pet.needs.clean + 38, 0, 100);
        pet.needs.happiness = clamp(pet.needs.happiness + 4, 0, 100);
        xp = 8; message = 'Plouf ! ' + pet.name + ' sent bon les fleurs.';
      } else if (action === 'cuddle') {
        if (pet.needs.happiness >= 96) return fail(pet.name + ' déborde déjà de bonheur !');
        pet.needs.happiness = clamp(pet.needs.happiness + 12, 0, 100);
        xp = 5; message = 'Un gros câlin et plein de petits cœurs !';
      } else return fail('Cette action n’est pas disponible.');
      pet.careCount++;
      const stageChanged = evolve(pet, xp);
      emit(); return success(message, { stageChanged, xp });
    }
    function reward(rewardData) {
      const pet = active();
      if (!pet || pet.stage === 'egg') return fail('Ton compagnon doit éclore avant de jouer.');
      if (pet.sleeping) return fail('Ton compagnon se repose pour le moment.');
      rewardData = rewardData || {};
      if (!['coins', 'happiness', 'xp'].every(key => rewardData[key] === undefined || finite(rewardData[key]) && rewardData[key] >= 0)) return fail('Cette récompense ne peut pas être ajoutée.');
      elapsedTick(now());
      const coins = Math.floor(clamp(rewardData.coins || 0, 0, 9999));
      const xp = Math.floor(clamp(rewardData.xp || 0, 0, 9999));
      state.coins = clamp(state.coins + coins, 0, 999999);
      pet.needs.happiness = clamp(pet.needs.happiness + (rewardData.happiness || 0), 0, 100);
      pet.needs.energy = clamp(pet.needs.energy - 4, 0, 100);
      pet.needs.food = clamp(pet.needs.food - 2, 0, 100);
      const stageChanged = evolve(pet, xp);
      pet.careCount++;
      emit(); return success('Bravo ! +' + coins + ' étoiles et +' + xp + ' points d’amitié.', { coins, xp, stageChanged });
    }
    function buy(id) {
      const item = catalog.find(i => i.id === id);
      if (!item) return fail('Cet objet n’existe pas dans la boutique.');
      if (state.inventory.includes(id)) return fail('Tu possèdes déjà ce petit trésor.');
      if (state.coins < item.price) return fail('Encore ' + (item.price - state.coins) + ' étoiles pour ce petit trésor.');
      state.coins -= item.price; state.inventory.push(id);
      if (item.type === 'accessory' && active()) active().accessory = id;
      emit(); return success(item.name + ' rejoint ta collection !');
    }
    function setSetting(key, value) {
      let message;
      if (key === 'sound' || key === 'music') {
        if (typeof value !== 'boolean') return fail('Ce réglage doit être activé ou désactivé.');
        message = key === 'sound' ? (value ? 'Sons activés.' : 'Sons désactivés.') : (value ? 'Musique activée.' : 'Musique désactivée.');
      } else if (key === 'soundVolume' || key === 'musicVolume') {
        if (!finite(value) || value < 0 || value > 1) return fail('Choisis un volume entre 0 et 100 %.');
        message = (key === 'soundVolume' ? 'Volume des sons : ' : 'Volume de la musique : ') + Math.round(value * 100) + ' %.';
      } else return fail('Ce réglage n’est pas disponible.');
      state.settings[key] = value; emit(); return success(message);
    }
    function exportSave() { elapsedTick(now()); save(); return JSON.stringify(state, null, 2); }
    function importSave(text) {
      if (typeof text !== 'string' || text.length > 200000) return fail('Ce fichier de sauvegarde est trop grand ou illisible.');
      let next;
      try { next = validateSave(JSON.parse(text), now()); } catch (error) { return fail(error instanceof SyntaxError ? 'Ce fichier n’est pas une sauvegarde valide.' : error.message); }
      state = next; recoveredSave = false; elapsedTick(now()); emit();
      return success('Tes petits compagnons sont de retour !');
    }
    elapsedTick(now()); save();
    return {
      getState, adopt, selectPet, interact, tick, reward, buy, setSetting, exportSave, importSave,
      subscribe(fn) { if (typeof fn !== 'function') throw new TypeError('Un affichage doit être une fonction.'); listeners.add(fn); return () => listeners.delete(fn); }
    };
  }

  return { species, catalog, foods, createStore, SAVE_KEY, VERSION, MAX_OFFLINE_MS };
});
