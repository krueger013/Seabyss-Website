(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  if (root) root.CastleEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIDTH = 1000, HEIGHT = 700, MANA_RATE = 0.65, MAX_TOWERS = 3;
  const STARTER_IDS = Object.freeze(['sentinel', 'archer', 'golem', 'swarm', 'cannon', 'mortar', 'heal', 'lightning', 'runner']);
  const ELEMENTS = Object.freeze({
    physical: Object.freeze({ name: 'Physical', color: '#d8d7c3', strongAgainst: null, weakAgainst: null }),
    fire: Object.freeze({ name: 'Fire', color: '#ff9a50', strongAgainst: 'ice', weakAgainst: 'water' }),
    ice: Object.freeze({ name: 'Ice', color: '#b4dfff', strongAgainst: 'water', weakAgainst: 'fire' }),
    water: Object.freeze({ name: 'Water', color: '#58e2dc', strongAgainst: 'fire', weakAgainst: 'ice' })
  });
  const CARD_DEFS = Object.freeze([
    { id: 'sentinel', name: 'Sentinel', cost: 2, kind: 'unit', description: 'A sturdy frontline soldier who shields your troops and fights at close range.', hp: 125, damage: 19, range: 30, speed: 44, cooldown: 1.05 },
    { id: 'archer', name: 'Tide Archer', cost: 3, kind: 'unit', element: 'water', affinity: 'water', description: 'Fires water arrows from a distance. Resists water, but is vulnerable to ice.', hp: 72, damage: 21, range: 145, speed: 36, cooldown: 1.25 },
    { id: 'golem', name: 'Coral Golem', cost: 5, kind: 'unit', affinity: 'ice', description: 'A heavily armored giant. Deals 50% more physical damage to buildings. Resists ice, but is vulnerable to fire.', hp: 420, damage: 32, range: 37, speed: 26, cooldown: 1.5 },
    { id: 'swarm', name: 'Crab Swarm', cost: 3, kind: 'unit', description: 'Summons three swift little monsters to surround your enemies.', hp: 48, damage: 10, range: 24, speed: 63, cooldown: 0.85, count: 3 },
    { id: 'cannon', name: 'Abyss Cannon', cost: 4, kind: 'tower', description: 'A stationary weapon that guards your castle. Build up to three weapons.', hp: 260, damage: 31, range: 220, speed: 0, cooldown: 1.65 },
    { id: 'mortar', name: 'Siege Mortar', cost: 6, kind: 'tower', description: 'Bombards clustered enemies from long range. Build up to three weapons.', hp: 220, damage: 47, range: 325, speed: 0, cooldown: 3.1, splash: 55 },
    { id: 'heal', name: 'Healing Spring', cost: 3, kind: 'spell', description: 'Restores 130 HP to your troops and 80 HP to your buildings within the area.', hp: 0, damage: 0, range: 115, speed: 0, cooldown: 1 },
    { id: 'lightning', name: 'Abyssal Lightning', cost: 4, kind: 'spell', description: 'Deals 110 neutral damage to enemies within the area, or 45 damage to castles.', hp: 0, damage: 110, castleDamage: 45, range: 90, speed: 0, cooldown: 1 },
    { id: 'embermage', name: 'Ember Mage', cost: 4, kind: 'unit', element: 'fire', affinity: 'fire', description: 'Hurls firebolts that burn troops for 4 damage per second for 3 seconds. Resists fire; vulnerable to water.', hp: 90, damage: 25, range: 150, speed: 34, cooldown: 1.5, burnDps: 4, burnDuration: 3 },
    { id: 'frostwarden', name: 'Frost Warden', cost: 4, kind: 'unit', element: 'ice', affinity: 'ice', description: 'An armored ice warrior. Hits slow movement and attacks by 35% for 2 seconds. Resists ice; vulnerable to fire.', hp: 240, damage: 24, range: 35, speed: 32, cooldown: 1.3, slowDuration: 2, slowFactor: 0.65 },
    { id: 'tidecaller', name: 'Tidecaller', cost: 4, kind: 'unit', element: 'water', affinity: 'water', description: 'A long-range water mage who counters fire troops. Resists water; vulnerable to ice.', hp: 110, damage: 30, range: 155, speed: 36, cooldown: 1.45 },
    { id: 'fireball', name: 'Fireball', cost: 4, kind: 'spell', element: 'fire', description: 'Deals 125 fire damage in an area, or 45 to castles. Burns troops for 6 damage per second for 4 seconds.', hp: 0, damage: 125, castleDamage: 45, range: 95, speed: 0, cooldown: 1, burnDps: 6, burnDuration: 4 },
    { id: 'blizzard', name: 'Blizzard', cost: 4, kind: 'spell', element: 'ice', description: 'Deals 65 ice damage, or 30 to castles. Slows enemy movement and attacks by 45% for 4 seconds.', hp: 0, damage: 65, castleDamage: 30, range: 125, speed: 0, cooldown: 1, slowDuration: 4, slowFactor: 0.55 },
    { id: 'tidalwave', name: 'Tidal Wave', cost: 5, kind: 'spell', element: 'water', description: 'Deals 105 water damage across a wide area, or 40 to castles. Extinguishes burning allies in the area.', hp: 0, damage: 105, castleDamage: 40, range: 145, speed: 0, cooldown: 1 },
    { id: 'aegis', name: 'Abyssal Aegis', cost: 4, kind: 'spell', description: 'Grants your troops and buildings in the area a ward that reduces all incoming damage by 40% for 8 seconds.', hp: 0, damage: 0, range: 145, speed: 0, cooldown: 1, wardDuration: 8 },
    { id: 'runner', name: 'Relic Runner', cost: 2, kind: 'unit', role: 'collector', description: 'Deploy for 2 aether. This fragile, unarmed collector walks to the central relic, picks it up, and must return alive to your castle: double aether regeneration for 60 seconds, or 40 permanent gold. One runner at a time; 20-second dispatch cooldown.', hp: 28, damage: 0, range: 0, speed: 70, carryingSpeed: 58, cooldown: 20 }
  ].map(card => Object.freeze({ element: 'physical', affinity: 'neutral', ...card,
    resistance: card.affinity || null, weakness: card.affinity ? ELEMENTS[card.affinity].weakAgainst : null })));
  const BY_ID = Object.fromEntries(CARD_DEFS.map(card => [card.id, card]));
  const COLORS = ['#56e2e2', '#ff767b', '#eab768', '#bc94ff'];
  const NAMES = ['Your Citadel', 'Red Bastion', 'Sunfire Crown', 'Twilight Keep'];
  const POSITIONS = [{ x: 500, y: 590 }, { x: 500, y: 110 }, { x: 120, y: 350 }, { x: 880, y: 350 }];
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const living = entity => entity.hp > 0;
  let battleSequence = 0;
  function availableCards(ids) {
    const owned = new Set([...STARTER_IDS, ...(Array.isArray(ids) ? ids : [])]);
    return CARD_DEFS.filter(card => owned.has(card.id)).map(card => card.id);
  }
  function battleId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return 'battle-' + globalThis.crypto.randomUUID();
    return 'battle-' + Date.now().toString(36) + '-' + (++battleSequence).toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function legacyBattleId(saved) {
    const text = JSON.stringify(saved);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
    return 'legacy-' + hash.toString(36) + '-' + Math.floor(saved.elapsed * 1000).toString(36);
  }
  function statusDefaults() { return { burnTime: 0, burnDps: 0, burnTeam: null, slowTime: 0, slowFactor: 1, wardTime: 0 }; }
  function elementalMultiplier(element, affinity) {
    if (!ELEMENTS[element] || element === 'physical' || !ELEMENTS[affinity] || affinity === 'physical') return 1;
    return element === affinity ? 0.65 : ELEMENTS[element].strongAgainst === affinity ? 1.35 : 1;
  }

  function random(state) {
    state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0;
    return state.rng / 4294967296;
  }

  function createGame(options = {}) {
    const mode = Number(options.mode) === 4 ? 4 : 2;
    const difficulty = ['easy', 'normal', 'hard'].includes(options.difficulty) ? options.difficulty : 'normal';
    return {
      version: 1, battleId: battleId(), availableCards: availableCards(options.availableCards), mode, difficulty, mapId: ['abyss', 'ember', 'frost'].includes(options.mapId) ? options.mapId : 'abyss', width: WIDTH, height: HEIGHT,
      castles: POSITIONS.slice(0, mode).map((position, team) => ({
        id: 'castle-' + team, team, ...position, name: NAMES[team], color: COLORS[team],
        hp: 1000, maxHp: 1000, alive: true, mana: 7, maxMana: 10,
        targetTeam: team === 0 ? 1 : (mode === 2 ? 0 : (team + 1) % mode),
        attackTimer: 0, aiTimer: 2 + team * 0.7, decisionCount: 0,
        moving: false, attackAnim: 0, hitFlash: 0, element: 'physical', affinity: 'neutral', ...statusDefaults(),
        aetherBoostTime: 0, runnerCooldown: 0, goldDelivered: 0
      })),
      units: [], towers: [], projectiles: [], effects: [], elapsed: 0,
      relic: null, relicSequence: 0, nextRelicAt: 12, deliveries: [],
      status: 'playing', targetTeam: 1, selectedCard: null, nextId: 1,
      rng: Number.isInteger(options.seed) ? options.seed >>> 0 : 371921,
      stats: { unitsSummoned: 0, towersBuilt: 0, spellsCast: 0, damageDealt: 0, kills: 0, castlesDestroyed: 0, runnersSent: 0, relicsDelivered: 0, goldDelivered: 0 },
      winnerTeam: null
    };
  }

  function effect(state, kind, x, y, team, radius = 25, duration = 0.45) {
    state.effects.push({ id: 'effect-' + state.nextId++, kind, x, y, team, radius, life: duration, maxLife: duration });
    if (state.effects.length > 120) state.effects.splice(0, state.effects.length - 120);
  }

  function getCastle(state, team) { return state.castles.find(castle => castle.team === team); }

  function checkCast(state, cardId, x, y, team) {
    const card = BY_ID[cardId], home = getCastle(state, team);
    if (!state || state.status !== 'playing') return { ok: false, message: 'The battle is over.' };
    if (!card || !home || !home.alive) return { ok: false, message: 'This card is unavailable.' };
    if (team === 0 && !(state.availableCards || STARTER_IDS).includes(cardId)) return { ok: false, message: 'Unlock this card in the Armory before using it.' };
    if (card.role === 'collector') {
      if (!state.relic) return { ok: false, message: 'Wait for a relic to appear at the center.' };
      if (state.units.some(unit => unit.team === team && unit.cardId === 'runner' && living(unit))) return { ok: false, message: 'Your runner is already on the battlefield.' };
      if (home.runnerCooldown > 0.000001) return { ok: false, message: 'Your next runner is ready in ' + Math.ceil(home.runnerCooldown) + ' seconds.' };
      if (home.mana + 0.00001 < card.cost) return { ok: false, message: 'Not enough aether. A runner costs 2 aether.' };
      return { ok: true, message: '' };
    }
    if (home.mana + 0.00001 < card.cost) return { ok: false, message: 'Not enough aether. Wait for it to recharge.' };
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 18 || x > WIDTH - 18 || y < 18 || y > HEIGHT - 18) return { ok: false, message: 'Choose a spot on the battlefield.' };
    if (card.kind !== 'spell') {
      const d = distance(home, { x, y });
      const radius = card.kind === 'tower' ? 155 : 205;
      if (d > radius) return { ok: false, message: card.kind === 'tower' ? 'Build near your castle, inside the highlighted area.' : 'Summon troops inside your castle’s territory.' };
      if (state.castles.some(castle => castle.alive && distance(castle, { x, y }) < 65)) return { ok: false, message: 'Leave some space around the castle.' };
      if (card.kind === 'tower') {
        if (state.towers.filter(tower => tower.team === team && living(tower)).length >= MAX_TOWERS) return { ok: false, message: 'Three weapons maximum. Wait until a slot opens up.' };
        if (state.towers.some(tower => living(tower) && distance(tower, { x, y }) < 62)) return { ok: false, message: 'That spot is too close to another weapon.' };
      } else if (state.units.filter(unit => unit.team === team && unit.cardId !== 'runner' && living(unit)).length + (card.count || 1) > 45) {
        return { ok: false, message: 'Your army is at full strength for now.' };
      }
    }
    return { ok: true, message: '' };
  }

  function canCast(state, cardId, x, y) {
    if (!state || !Array.isArray(state.castles)) return { ok: false, message: 'Start a battle first.' };
    return checkCast(state, cardId, x, y, 0);
  }

  function directionToTarget(state, team) {
    const home = getCastle(state, team);
    const target = getCastle(state, team === 0 ? state.targetTeam : home.targetTeam) || state.castles.find(c => c.team !== team && c.alive);
    return target ? Math.atan2(target.y - home.y, target.x - home.x) : -Math.PI / 2;
  }

  function defaultPlacement(state, cardId, team = 0) {
    const home = getCastle(state, team), card = BY_ID[cardId];
    if (!home || !card) return { x: 500, y: 450 };
    if (card.role === 'collector') {
      const angle = Math.atan2(350 - home.y, 500 - home.x);
      return { x: home.x + Math.cos(angle) * 70, y: home.y + Math.sin(angle) * 70 };
    }
    if (card.id === 'heal' || card.id === 'aegis') {
      const wounded = state.units.filter(u => u.team === team && u.hp < u.maxHp * 0.65).sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
      return wounded ? { x: wounded.x, y: wounded.y } : { x: home.x, y: home.y };
    }
    if (card.kind === 'spell') {
      const near = state.units.filter(u => u.team !== team && living(u)).sort((a, b) => distance(a, home) - distance(b, home))[0];
      const target = getCastle(state, team === 0 ? state.targetTeam : home.targetTeam);
      return near ? { x: near.x, y: near.y } : { x: target ? target.x : home.x, y: target ? target.y : home.y };
    }
    const angle = directionToTarget(state, team);
    const offsets = card.kind === 'tower' ? [-0.65, 0.65, 0, -1.3, 1.3, Math.PI] : [0, -0.25, 0.25];
    for (const offset of offsets) {
      const point = { x: clamp(home.x + Math.cos(angle + offset) * 132, 22, WIDTH - 22), y: clamp(home.y + Math.sin(angle + offset) * 132, 22, HEIGHT - 22) };
      if (card.kind !== 'tower' || !state.towers.some(t => living(t) && distance(t, point) < 62)) return point;
    }
    return { x: clamp(home.x + Math.cos(angle) * 132, 22, WIDTH - 22), y: clamp(home.y + Math.sin(angle) * 132, 22, HEIGHT - 22) };
  }

  function damage(state, target, amount, sourceTeam, element = 'physical') {
    if (!living(target)) return;
    amount *= elementalMultiplier(element, target.affinity || BY_ID[target.cardId]?.affinity);
    if (target.wardTime > 0) amount *= 0.6;
    const dealt = Math.min(target.hp, amount);
    target.hp = Math.max(0, target.hp - amount);
    target.lastHitTeam = sourceTeam;
    target.hitFlash = 0.15;
    if (sourceTeam === 0 && target.team !== 0) state.stats.damageDealt += dealt;
  }

  function applyAttackStatus(target, card, sourceTeam) {
    if (!living(target)) return;
    if (card.burnDuration && BY_ID[target.cardId]?.kind === 'unit') {
      // Refresh one burn instead of stacking unlimited damage from many mages.
      if (!(target.burnTime > 0) || card.burnDps >= target.burnDps) {
        target.burnTime = Math.max(target.burnTime || 0, card.burnDuration);
        target.burnDps = card.burnDps;
        target.burnTeam = sourceTeam;
      }
    }
    if (card.slowDuration) {
      target.slowTime = Math.max(target.slowTime || 0, card.slowDuration);
      target.slowFactor = Math.min(target.slowFactor || 1, card.slowFactor);
    }
  }

  function castForTeam(state, cardId, x, y, team) {
    const result = checkCast(state, cardId, x, y, team);
    if (!result.ok) return result;
    const card = BY_ID[cardId], home = getCastle(state, team);
    if (card.role === 'collector') {
      ({ x, y } = defaultPlacement(state, cardId, team));
      home.runnerCooldown = card.cooldown;
    }
    home.mana = Math.max(0, home.mana - card.cost);
    if (card.kind === 'spell') {
      if (team === 0) state.stats.spellsCast++;
      if (card.id === 'heal') {
        for (const entity of [...state.units, ...state.towers, ...state.castles]) {
          if (entity.team === team && living(entity) && distance(entity, { x, y }) <= card.range) {
            entity.hp = Math.min(entity.maxHp, entity.hp + (entity.cardId && BY_ID[entity.cardId].kind === 'unit' ? 130 : 80));
          }
        }
        effect(state, 'heal', x, y, team, card.range, 0.85);
      } else if (card.id === 'aegis') {
        for (const entity of [...state.units, ...state.towers, ...state.castles]) {
          if (entity.team === team && living(entity) && distance(entity, { x, y }) <= card.range) entity.wardTime = card.wardDuration;
        }
        effect(state, 'aegis', x, y, team, card.range, 1.1);
      } else {
        for (const entity of [...state.units, ...state.towers, ...state.castles]) {
          if (entity.team !== team && living(entity) && distance(entity, { x, y }) <= card.range) {
            damage(state, entity, entity.id.startsWith('castle-') ? card.castleDamage : card.damage, team, card.element);
            applyAttackStatus(entity, card, team);
          } else if (card.id === 'tidalwave' && entity.team === team && distance(entity, { x, y }) <= card.range) {
            entity.burnTime = 0; entity.burnDps = 0; entity.burnTeam = null;
          }
        }
        effect(state, card.id, x, y, team, card.range, card.id === 'blizzard' ? 1.2 : 0.75);
      }
    } else {
      const count = card.count || 1;
      for (let index = 0; index < count; index++) {
        const spreadAngle = (index / count) * Math.PI * 2;
        const entity = {
          id: (card.kind === 'tower' ? 'tower-' : 'unit-') + state.nextId++, team, cardId,
          x: clamp(x + (count > 1 ? Math.cos(spreadAngle) * 17 : 0), 18, WIDTH - 18),
          y: clamp(y + (count > 1 ? Math.sin(spreadAngle) * 17 : 0), 18, HEIGHT - 18),
          hp: card.hp, maxHp: card.hp, targetId: null, attackTimer: 0.25,
          facing: directionToTarget(state, team), hitFlash: 0, moving: false, attackAnim: 0,
          element: card.element, affinity: card.affinity, ...statusDefaults(),
          ...(card.role === 'collector' ? { role: 'collector', carrying: null, task: 'outbound', pickupTime: 0, facing: Math.atan2(350 - y, 500 - x) } : {})
        };
        if (card.kind === 'tower') state.towers.push(entity); else state.units.push(entity);
        effect(state, 'spawn', entity.x, entity.y, team, card.kind === 'tower' ? 38 : 24, 0.6);
      }
      if (team === 0) {
        if (card.kind === 'tower') state.stats.towersBuilt++;
        else if (card.role === 'collector') state.stats.runnersSent++;
        else state.stats.unitsSummoned += count;
      }
    }
    resolveDeaths(state);
    return { ok: true, message: card.role === 'collector' ? 'Runner dispatched. Protect the return journey!' : card.kind === 'tower' ? card.name + ' built!' : card.kind === 'spell' ? card.name + ' cast!' : card.name + ' summoned!' };
  }

  function playCard(state, cardId, x, y) {
    if (!state || !Array.isArray(state.castles)) return { ok: false, message: 'Start a battle first.' };
    if (x === undefined || y === undefined) ({ x, y } = defaultPlacement(state, cardId));
    return castForTeam(state, cardId, x, y, 0);
  }

  function setTarget(state, team) {
    const target = getCastle(state, Number(team));
    if (!target || !target.alive || target.team === 0 || state.status !== 'playing') return false;
    state.targetTeam = target.team;
    state.castles[0].targetTeam = target.team;
    return true;
  }

  function pickEnemyCastle(state, home) {
    const enemies = state.castles.filter(c => c.team !== home.team && c.alive);
    if (!enemies.length) return null;
    if (state.mode === 2) return enemies[0];
    // Nearby kingdoms are the natural rivals; the player is never given a hidden aggro bonus.
    return enemies.map(castle => ({ castle, score: distance(castle, home) + castle.hp * 0.16 + random(state) * 130 }))
      .sort((a, b) => a.score - b.score)[0].castle;
  }

  function enemyAI(state, home, dt) {
    home.aiTimer -= dt;
    if (home.aiTimer > 0) return;
    const delay = state.difficulty === 'easy' ? 2.5 : state.difficulty === 'hard' ? 0.9 : 1.5;
    home.aiTimer = delay + random(state) * 0.8;
    home.decisionCount++;
    const currentTarget = getCastle(state, home.targetTeam);
    if (!currentTarget || !currentTarget.alive || home.decisionCount % 5 === 0) {
      const target = pickEnemyCastle(state, home);
      if (target) home.targetTeam = target.team;
    }
    const threats = state.units.filter(u => u.team !== home.team && living(u) && distance(u, home) < 220);
    const ownTowers = state.towers.filter(t => t.team === home.team && living(t));
    const ownUnits = state.units.filter(u => u.team === home.team && living(u));
    let cardId;
    if (state.difficulty !== 'easy' && home.mana >= 4 && threats.length >= 4) {
      cardId = 'lightning';
    } else if (state.difficulty === 'hard' && home.mana >= 3 && ownUnits.some(u => u.cardId === 'golem' && u.hp < 160)) {
      cardId = 'heal';
    } else if (home.mana >= 4 && ownTowers.length < (state.difficulty === 'easy' ? 1 : 2) && (threats.length > 0 || home.decisionCount === 2 || home.decisionCount % 9 === 0)) {
      cardId = home.mana >= 7 && ownTowers.length === 1 ? 'mortar' : 'cannon';
    } else if (home.mana >= 5 && (ownUnits.some(u => u.cardId === 'archer') || home.decisionCount % 4 === 0)) {
      cardId = 'golem';
    } else if (home.mana >= 3 && (ownUnits.some(u => u.cardId === 'golem' || u.cardId === 'sentinel') || home.decisionCount % 3 === 0)) {
      cardId = random(state) > 0.32 ? 'archer' : 'swarm';
    } else if (home.mana >= 2 && (home.mana >= 3.8 || threats.length > 0 || ownUnits.length === 0)) {
      cardId = 'sentinel';
    }
    const unlockUnitsAt = state.difficulty === 'easy' ? 150 : state.difficulty === 'hard' ? 20 : 60;
    const unlockSpellsAt = state.difficulty === 'easy' ? 240 : state.difficulty === 'hard' ? 45 : 120;
    if (state.elapsed >= unlockUnitsAt && home.mana >= 4 && home.decisionCount % 3 === 0) {
      const enemyAffinity = threats[0]?.affinity || BY_ID[threats[0]?.cardId]?.affinity;
      const counter = ELEMENTS[enemyAffinity]?.weakAgainst;
      cardId = counter ? { fire: 'embermage', ice: 'frostwarden', water: 'tidecaller' }[counter] : ['embermage', 'frostwarden', 'tidecaller'][(home.team + Math.floor(home.decisionCount / 3)) % 3];
    }
    if (state.elapsed >= unlockSpellsAt && home.mana >= 4) {
      if (threats.length >= 3) {
        const affinity = threats[0].affinity || BY_ID[threats[0].cardId]?.affinity;
        const counter = ELEMENTS[affinity]?.weakAgainst;
        cardId = counter === 'water' && home.mana >= 5 ? 'tidalwave' : counter === 'ice' ? 'blizzard' : 'fireball';
      } else if (ownUnits.length >= 3 && threats.length > 0 && home.decisionCount % 5 === 0) cardId = 'aegis';
    }
    if (!cardId) return;
    const placement = defaultPlacement(state, cardId, home.team);
    if (BY_ID[cardId].kind === 'unit') {
      placement.x = clamp(placement.x + (random(state) - 0.5) * 38, 22, WIDTH - 22);
      placement.y = clamp(placement.y + (random(state) - 0.5) * 38, 22, HEIGHT - 22);
    }
    castForTeam(state, cardId, placement.x, placement.y, home.team);
  }

  function radius(entity) {
    if (entity.id.startsWith('castle-')) return 45;
    if (entity.id.startsWith('tower-')) return 21;
    if (entity.cardId === 'runner') return 9;
    return entity.cardId === 'golem' ? 18 : entity.cardId === 'frostwarden' ? 16 : entity.cardId === 'swarm' ? 9 : 12;
  }

  function spawnRelic(state) {
    if (state.relic || state.nextRelicAt === null || state.elapsed + 0.000001 < state.nextRelicAt) return;
    state.relicSequence++;
    state.relic = {
      id: state.battleId + ':relic-' + state.relicSequence,
      kind: state.relicSequence % 2 === 1 ? 'aether' : 'gold',
      x: 500, y: 350, carrierId: null, spawnedAt: state.elapsed
    };
    state.nextRelicAt = null;
    effect(state, 'relic-spawn', 500, 350, 0, 45, 1);
  }

  function dropRelic(state, unit) {
    if (!state.relic || state.relic.carrierId !== unit.id) return;
    state.relic.x = 500;
    state.relic.y = 350;
    state.relic.carrierId = null;
    state.relic.spawnedAt = state.elapsed;
    unit.carrying = null;
    unit.task = 'outbound';
    unit.pickupTime = 0;
    effect(state, 'relic-drop', 500, 350, unit.team, 42, 0.8);
  }

  function sendEnemyRunner(state, home) {
    if (!state.relic || home.runnerCooldown > 0 || home.mana + 0.00001 < BY_ID.runner.cost || state.units.some(unit => unit.team === home.team && unit.cardId === 'runner' && living(unit))) return;
    const delay = state.difficulty === 'easy' ? 4 : state.difficulty === 'hard' ? 1 : 2;
    if (state.elapsed - state.relic.spawnedAt < delay) return;
    const spot = defaultPlacement(state, 'runner', home.team);
    castForTeam(state, 'runner', spot.x, spot.y, home.team);
  }

  function moveCollector(state, unit, dt) {
    const home = getCastle(state, unit.team), relic = state.relic;
    const carrying = relic && relic.carrierId === unit.id;
    unit.carrying = carrying ? relic.kind : null;
    unit.task = carrying ? 'returning' : 'outbound';
    if (!carrying) unit.pickupTime = 0;
    if (carrying && unit.pickupTime > 0) {
      const pause = Math.min(dt, unit.pickupTime);
      unit.pickupTime = Math.max(0, unit.pickupTime - pause);
      unit.task = unit.pickupTime > 0.000001 ? 'collecting' : 'returning';
      unit.moving = false;
      dt -= pause;
      if (unit.pickupTime > 0.000001 || dt <= 0.000001) return;
    }
    const target = carrying ? home : { x: 500, y: 350 };
    const startX = unit.x, startY = unit.y, dx = target.x - unit.x, dy = target.y - unit.y, dist = Math.hypot(dx, dy);
    const arrival = carrying ? 48 : 12;
    unit.targetId = carrying ? home.id : (relic ? relic.id : null);
    if (dist > arrival) {
      unit.facing = Math.atan2(dy, dx);
      const speed = carrying ? BY_ID.runner.carryingSpeed : BY_ID.runner.speed;
      const travel = Math.min(speed * dt * (unit.slowTime > 0 ? unit.slowFactor : 1), dist - arrival);
      unit.x += dx / dist * travel;
      unit.y += dy / dist * travel;
    } else if (!carrying) unit.task = 'waiting';
    unit.moving = unit.x !== startX || unit.y !== startY;
    if (!carrying && relic && !relic.carrierId && distance(unit, relic) <= 22) {
      relic.carrierId = unit.id;
      unit.carrying = relic.kind;
      unit.task = 'collecting';
      unit.pickupTime = 0.65;
      unit.moving = false;
      effect(state, 'relic-pickup', unit.x, unit.y, unit.team, 32, 0.6);
    }
  }

  function finishRelicJourney(state) {
    if (!state.relic?.carrierId) return;
    const unit = state.units.find(candidate => candidate.id === state.relic.carrierId);
    if (!unit || !living(unit)) return;
    const home = getCastle(state, unit.team);
    state.relic.x = unit.x;
    state.relic.y = unit.y;
    if (!home?.alive || unit.pickupTime > 0 || distance(unit, home) > 48.01) return;
    const relic = state.relic;
    if (!state.deliveries.some(receipt => receipt.id === relic.id)) {
      const gold = relic.kind === 'gold' ? 40 : 0;
      state.deliveries.push({ id: relic.id, battleId: state.battleId, team: unit.team, kind: relic.kind, gold, delivered: true, deliveredAt: state.elapsed });
      if (relic.kind === 'aether') home.aetherBoostTime = 60;
      else home.goldDelivered += gold;
      if (unit.team === 0) {
        state.stats.relicsDelivered++;
        state.stats.goldDelivered += gold;
      }
    }
    effect(state, 'relic-delivery', home.x, home.y, unit.team, 65, 1.2);
    state.relic = null;
    state.nextRelicAt = state.elapsed + 45;
    // A successful runner enters the keep safely, freeing the dispatch slot.
    state.units = state.units.filter(candidate => candidate !== unit);
  }

  function shot(state, from, target, kind, amount, splash = 0) {
    const card = BY_ID[from.cardId] || { element: 'physical' };
    const flight = kind === 'mortar' ? 0.52 : Math.max(0.13, distance(from, target) / 750);
    state.projectiles.push({ id: 'shot-' + state.nextId++, x: from.x, y: from.y - 9, startX: from.x, startY: from.y - 9,
      tx: target.x, ty: target.y, team: from.team, kind, element: card.element, life: flight, maxLife: flight });
    if (state.projectiles.length > 160) state.projectiles.shift();
    damage(state, target, amount, from.team, card.element);
    applyAttackStatus(target, card, from.team);
    if (splash) {
      for (const other of [...state.units, ...state.towers]) {
        if (other !== target && other.team !== from.team && living(other) && distance(other, target) < splash) {
          damage(state, other, amount * 0.65, from.team, card.element);
          applyAttackStatus(other, card, from.team);
        }
      }
      effect(state, 'hit', target.x, target.y, from.team, splash, 0.3);
    }
  }

  function moveUnit(state, unit, dt, entities) {
    unit.moving = false;
    if (!living(unit)) return;
    if (unit.cardId === 'runner') { moveCollector(state, unit, dt); return; }
    const startX = unit.x, startY = unit.y;
    const card = BY_ID[unit.cardId], home = getCastle(state, unit.team);
    let goal = getCastle(state, unit.team === 0 ? state.targetTeam : home.targetTeam);
    if (!goal || !goal.alive || goal.team === unit.team) {
      goal = state.castles.find(c => c.team !== unit.team && c.alive);
      if (!goal) return;
    }
    let target = null, best = Infinity;
    const aggro = card.range > 80 ? 220 : 170;
    for (const enemy of entities) {
      if (enemy.team === unit.team || !living(enemy)) continue;
      const d = distance(unit, enemy) - radius(enemy);
      if (d < aggro && d < best) { target = enemy; best = d; }
    }
    if (!target) target = goal;
    unit.targetId = target.id;
    const dx = target.x - unit.x, dy = target.y - unit.y, dist = Math.hypot(dx, dy);
    unit.facing = Math.atan2(dy, dx);
    const speedFactor = unit.slowTime > 0 ? unit.slowFactor : 1;
    unit.attackTimer = Math.max(0, unit.attackTimer - dt * speedFactor);
    if (dist <= card.range + radius(target)) {
      if (unit.attackTimer <= 0) {
        const siege = unit.cardId === 'golem' && (target.id.startsWith('castle-') || target.id.startsWith('tower-'));
        const amount = card.damage * (siege ? 1.5 : 1);
        if (card.range > 80) shot(state, unit, target, card.element === 'fire' ? 'fire' : unit.cardId === 'tidecaller' ? 'water' : 'arrow', amount);
        else { damage(state, target, amount, unit.team, card.element); applyAttackStatus(target, card, unit.team); effect(state, 'hit', target.x, target.y, unit.team, 15, 0.18); }
        unit.attackTimer = card.cooldown;
        unit.attackAnim = 0.25;
      }
    } else if (dist > 0) {
      const travel = Math.min(card.speed * dt * speedFactor, dist - card.range - radius(target));
      unit.x += dx / dist * travel;
      unit.y += dy / dist * travel;
    }
    unit.x = clamp(unit.x, 18, WIDTH - 18);
    unit.y = clamp(unit.y, 18, HEIGHT - 18);
    unit.moving = unit.x !== startX || unit.y !== startY;
  }

  function attackFromBuilding(state, building, dt, enemies) {
    if (!living(building)) return;
    const card = building.cardId ? BY_ID[building.cardId] : { range: 180, damage: 14, cooldown: 1.35 };
    building.attackTimer = Math.max(0, building.attackTimer - dt * (building.slowTime > 0 ? building.slowFactor : 1));
    let target = null, best = Infinity;
    for (const enemy of enemies) {
      if (enemy.team === building.team || !living(enemy)) continue;
      const d = distance(building, enemy);
      if (d <= card.range + radius(enemy) && d < best) { best = d; target = enemy; }
    }
    building.targetId = target ? target.id : null;
    if (target) {
      building.facing = Math.atan2(target.y - building.y, target.x - building.x);
      if (building.attackTimer <= 0) {
        shot(state, building, target, building.cardId || 'castle', card.damage, card.splash || 0);
        building.attackTimer = card.cooldown;
        building.attackAnim = 0.25;
      }
    }
  }

  function resolveDeaths(state) {
    for (const unit of state.units) if (!living(unit)) {
      dropRelic(state, unit);
      effect(state, 'destroy', unit.x, unit.y, unit.team, 22, 0.45);
      if (unit.lastHitTeam === 0 && unit.team !== 0) state.stats.kills++;
    }
    for (const tower of state.towers) if (!living(tower)) effect(state, 'destroy', tower.x, tower.y, tower.team, 35, 0.6);
    state.units = state.units.filter(living);
    state.towers = state.towers.filter(living);
    for (const castle of state.castles) {
      if (castle.alive && castle.hp <= 0) {
        castle.alive = false;
        castle.hp = 0;
        for (const unit of state.units) if (unit.team === castle.team) dropRelic(state, unit);
        state.units = state.units.filter(u => u.team !== castle.team);
        state.towers = state.towers.filter(t => t.team !== castle.team);
        if (castle.lastHitTeam === 0) state.stats.castlesDestroyed++;
        effect(state, 'eliminated', castle.x, castle.y, castle.team, 90, 1.5);
      }
    }
    const player = getCastle(state, 0);
    const survivors = state.castles.filter(c => c.alive);
    if (!player.alive) {
      state.status = 'lost';
      state.winnerTeam = survivors.length === 1 ? survivors[0].team : null;
    } else if (survivors.length === 1) {
      state.status = 'won';
      state.winnerTeam = 0;
    }
    if (!getCastle(state, state.targetTeam)?.alive) {
      const next = survivors.find(c => c.team !== 0);
      if (next) { state.targetTeam = next.team; player.targetTeam = next.team; }
    }
  }

  function updateVisuals(state, dt) {
    for (const entity of [...state.units, ...state.towers, ...state.castles]) {
      entity.hitFlash = Math.max(0, (entity.hitFlash || 0) - dt);
      entity.attackAnim = Math.max(0, (entity.attackAnim || 0) - dt);
      entity.moving = false;
    }
    for (const projectile of state.projectiles) {
      projectile.life -= dt;
      const progress = clamp(1 - projectile.life / projectile.maxLife, 0, 1);
      projectile.x = projectile.startX + (projectile.tx - projectile.startX) * progress;
      projectile.y = projectile.startY + (projectile.ty - projectile.startY) * progress;
      if (projectile.kind === 'mortar') projectile.y -= Math.sin(progress * Math.PI) * 65;
    }
    state.projectiles = state.projectiles.filter(p => p.life > 0);
    for (const visual of state.effects) visual.life -= dt;
    state.effects = state.effects.filter(visual => visual.life > 0);
  }

  function updateStatuses(state, dt) {
    for (const entity of [...state.units, ...state.towers, ...state.castles]) {
      if (entity.burnTime > 0 && living(entity)) {
        damage(state, entity, entity.burnDps * Math.min(dt, entity.burnTime), entity.burnTeam, 'fire');
        entity.burnTime = Math.max(0, entity.burnTime - dt);
        if (!entity.burnTime) { entity.burnDps = 0; entity.burnTeam = null; }
      }
      entity.wardTime = Math.max(0, (entity.wardTime || 0) - dt);
      entity.slowTime = Math.max(0, (entity.slowTime || 0) - dt);
      if (!entity.slowTime) entity.slowFactor = 1;
    }
  }

  function step(state, dt) {
    state.elapsed += dt;
    updateVisuals(state, dt);
    updateStatuses(state, dt);
    resolveDeaths(state);
    if (state.status !== 'playing') return;
    spawnRelic(state);
    for (const castle of state.castles) if (castle.alive) {
      const boostedSeconds = Math.min(dt, castle.aetherBoostTime || 0);
      castle.mana = Math.min(castle.maxMana, castle.mana + MANA_RATE * (dt + boostedSeconds));
      castle.aetherBoostTime = Math.max(0, (castle.aetherBoostTime || 0) - dt);
      castle.runnerCooldown = Math.max(0, (castle.runnerCooldown || 0) - dt);
      if (castle.team !== 0) { enemyAI(state, castle, dt); sendEnemyRunner(state, castle); }
    }
    const entities = [...state.units, ...state.towers, ...state.castles];
    for (const unit of state.units) moveUnit(state, unit, dt, entities);
    // A light separation keeps a whole army legible without changing its route.
    for (let i = 0; i < state.units.length; i++) for (let j = i + 1; j < state.units.length; j++) {
      const a = state.units[i], b = state.units[j];
      if (a.team !== b.team) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), gap = (radius(a) + radius(b)) * 0.7;
      if (d < gap) {
        const ax = a.x, ay = a.y, bx = b.x, by = b.y;
        const push = Math.min((gap - d) * 0.5, 15 * dt), nx = d > 0.01 ? dx / d : 1, ny = d > 0.01 ? dy / d : 0;
        a.x = clamp(a.x - nx * push, 18, WIDTH - 18); a.y = clamp(a.y - ny * push, 18, HEIGHT - 18);
        b.x = clamp(b.x + nx * push, 18, WIDTH - 18); b.y = clamp(b.y + ny * push, 18, HEIGHT - 18);
        a.moving ||= a.x !== ax || a.y !== ay;
        b.moving ||= b.x !== bx || b.y !== by;
      }
    }
    for (const tower of state.towers) attackFromBuilding(state, tower, dt, entities);
    for (const castle of state.castles) if (castle.alive) attackFromBuilding(state, castle, dt, state.units);
    resolveDeaths(state);
    if (state.status === 'playing') finishRelicJourney(state);
  }

  function advance(state, dt) {
    if (!state || state.status !== 'playing' || !Number.isFinite(dt) || dt <= 0) return state;
    let remaining = Math.min(dt, 0.25);
    while (remaining > 0.000001 && state.status === 'playing') {
      const interval = Math.min(remaining, 0.05);
      step(state, interval);
      remaining -= interval;
    }
    return state;
  }

  function restoreGame(raw) {
    try {
      const saved = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw));
      if (!saved || saved.version !== 1 || ![2, 4].includes(saved.mode) || !['easy', 'normal', 'hard'].includes(saved.difficulty) || !['abyss', 'ember', 'frost'].includes(saved.mapId) ||
          !['playing', 'won', 'lost'].includes(saved.status) || !Number.isFinite(saved.elapsed) || saved.elapsed < 0 ||
          !Number.isInteger(saved.nextId) || saved.nextId < 1 || !Array.isArray(saved.castles) || saved.castles.length !== saved.mode ||
          !Array.isArray(saved.units) || saved.units.length > 184 || !Array.isArray(saved.towers) || saved.towers.length > 12) return null;
      const state = createGame({ mode: saved.mode, difficulty: saved.difficulty, mapId: saved.mapId, availableCards: saved.availableCards });
      state.battleId = typeof saved.battleId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(saved.battleId) ? saved.battleId : legacyBattleId(saved);
      const validNumber = value => Number.isFinite(value);
      const restoreStatuses = item => {
        const activeBurn = Number.isInteger(item.burnTeam) && item.burnTeam >= 0 && item.burnTeam < saved.mode;
        const slowTime = clamp(Number(item.slowTime) || 0, 0, 4);
        return {
          burnTime: activeBurn ? clamp(Number(item.burnTime) || 0, 0, 4) : 0,
          burnDps: activeBurn ? clamp(Number(item.burnDps) || 0, 0, 6) : 0,
          burnTeam: activeBurn ? item.burnTeam : null,
          slowTime, slowFactor: slowTime > 0 ? clamp(Number(item.slowFactor) || 1, 0.1, 1) : 1,
          wardTime: clamp(Number(item.wardTime) || 0, 0, 8)
        };
      };
      for (let i = 0; i < saved.mode; i++) {
        const castle = saved.castles[i];
        if (!castle || castle.id !== 'castle-' + i || castle.team !== i || !validNumber(castle.hp) || castle.hp < 0 || castle.hp > 1000 || !validNumber(castle.mana)) return null;
        Object.assign(state.castles[i], {
          hp: castle.hp, alive: castle.hp > 0, mana: clamp(castle.mana, 0, 10),
          targetTeam: Number.isInteger(castle.targetTeam) ? castle.targetTeam : (i === 0 ? 1 : 0),
          attackTimer: clamp(Number(castle.attackTimer) || 0, 0, 10), aiTimer: clamp(Number(castle.aiTimer) || 0, 0, 10),
          decisionCount: Math.max(0, Math.floor(Number(castle.decisionCount) || 0)), ...restoreStatuses(castle),
          aetherBoostTime: clamp(Number(castle.aetherBoostTime) || 0, 0, 60),
          runnerCooldown: clamp(Number(castle.runnerCooldown) || 0, 0, 20),
          goldDelivered: Math.max(0, Math.floor(Number(castle.goldDelivered) || 0))
        });
      }
      const ids = new Set(state.castles.map(c => c.id));
      for (const kind of ['units', 'towers']) {
        for (const item of saved[kind]) {
          const def = item && BY_ID[item.cardId];
          if (!def || def.kind !== (kind === 'units' ? 'unit' : 'tower') || typeof item.id !== 'string' || !new RegExp('^' + (kind === 'units' ? 'unit' : 'tower') + '-\\d+$').test(item.id) || ids.has(item.id) ||
              !Number.isInteger(item.team) || !state.castles[item.team]?.alive || !validNumber(item.x) || !validNumber(item.y) || !validNumber(item.hp) || item.hp <= 0 || item.hp > def.hp) return null;
          ids.add(item.id);
          state[kind].push({ id: item.id, team: item.team, cardId: def.id, x: clamp(item.x, 18, WIDTH - 18), y: clamp(item.y, 18, HEIGHT - 18),
            hp: item.hp, maxHp: def.hp, targetId: typeof item.targetId === 'string' ? item.targetId : null,
            facing: Number(item.facing) || 0, attackTimer: clamp(Number(item.attackTimer) || 0, 0, 10), hitFlash: 0, moving: false, attackAnim: 0,
            element: def.element, affinity: def.affinity, ...restoreStatuses(item),
            ...(def.role === 'collector' ? { role: 'collector', carrying: null, task: 'outbound', pickupTime: clamp(Number(item.pickupTime) || 0, 0, 0.65) } : {}) });
        }
      }
      if (state.castles.some(castle => state.towers.filter(t => t.team === castle.team).length > MAX_TOWERS)) return null;
      if (state.castles.some(castle => state.units.filter(unit => unit.team === castle.team && unit.cardId === 'runner').length > 1)) return null;
      state.elapsed = saved.elapsed;
      state.nextId = Math.max(saved.nextId, ...[...ids].map(id => (Number(id.split('-').pop()) || 0) + 1));
      state.rng = Number.isInteger(saved.rng) ? saved.rng >>> 0 : state.rng;
      state.targetTeam = state.castles[saved.targetTeam]?.alive && saved.targetTeam !== 0 ? saved.targetTeam : (state.castles.find(c => c.team !== 0 && c.alive)?.team || 1);
      state.castles[0].targetTeam = state.targetTeam;
      state.selectedCard = state.availableCards.includes(saved.selectedCard) ? saved.selectedCard : null;
      for (const key of Object.keys(state.stats)) state.stats[key] = Math.max(0, Number.isFinite(saved.stats?.[key]) ? saved.stats[key] : 0);
      // Delivery receipts are durable facts. Rebuilding a carried relic never
      // creates a receipt or grants a reward; only a live return can do that.
      const sequenceFromId = id => {
        const prefix = state.battleId + ':relic-';
        if (typeof id !== 'string' || !id.startsWith(prefix) || !/^[1-9]\d*$/.test(id.slice(prefix.length))) return null;
        const value = Number(id.slice(prefix.length));
        return Number.isSafeInteger(value) ? value : null;
      };
      state.relicSequence = Number.isSafeInteger(saved.relicSequence) && saved.relicSequence >= 0 ? saved.relicSequence : 0;
      if (saved.deliveries !== undefined && !Array.isArray(saved.deliveries)) return null;
      const receiptIds = new Set();
      for (const receipt of saved.deliveries || []) {
        const sequence = sequenceFromId(receipt?.id);
        if (!sequence || receipt.battleId !== state.battleId || !Number.isInteger(receipt.team) || receipt.team < 0 || receipt.team >= state.mode ||
            receipt.kind !== (sequence % 2 ? 'aether' : 'gold') || receipt.gold !== (receipt.kind === 'gold' ? 40 : 0) || receipt.delivered !== true ||
            !Number.isFinite(receipt.deliveredAt) || receipt.deliveredAt < 0 || receipt.deliveredAt > state.elapsed + 0.001) return null;
        if (!receiptIds.has(receipt.id)) {
          state.deliveries.push({ id: receipt.id, battleId: state.battleId, team: receipt.team, kind: receipt.kind, gold: receipt.gold, delivered: true, deliveredAt: receipt.deliveredAt });
          receiptIds.add(receipt.id);
        }
        state.relicSequence = Math.max(state.relicSequence, sequence);
      }
      if (saved.relic) {
        const sequence = sequenceFromId(saved.relic.id);
        if (!sequence || saved.relic.kind !== (sequence % 2 ? 'aether' : 'gold') || receiptIds.has(saved.relic.id)) return null;
        state.relicSequence = Math.max(state.relicSequence, sequence);
        const carrier = state.units.find(unit => unit.id === saved.relic.carrierId && unit.cardId === 'runner');
        state.relic = { id: saved.relic.id, kind: saved.relic.kind, x: carrier ? carrier.x : 500, y: carrier ? carrier.y : 350,
          carrierId: carrier ? carrier.id : null, spawnedAt: clamp(Number(saved.relic.spawnedAt) || 0, 0, state.elapsed) };
        state.nextRelicAt = null;
        if (carrier) { carrier.carrying = state.relic.kind; carrier.task = carrier.pickupTime > 0 ? 'collecting' : 'returning'; }
      } else {
        state.relic = null;
        state.nextRelicAt = Number.isFinite(saved.nextRelicAt) ? Math.max(state.elapsed, saved.nextRelicAt) : state.relicSequence ? state.elapsed + 45 : Math.max(12, state.elapsed);
      }
      for (const runner of state.units.filter(unit => unit.cardId === 'runner' && !unit.carrying)) {
        runner.task = distance(runner, { x: 500, y: 350 }) <= 12.01 ? 'waiting' : 'outbound';
        runner.pickupTime = 0;
      }
      resolveDeaths(state);
      if (saved.status !== state.status) return null;
      return state;
    } catch (_) { return null; }
  }

  return Object.freeze({ WIDTH, HEIGHT, MANA_RATE, MAX_TOWERS, STARTER_IDS, ELEMENTS, CARD_DEFS, elementalMultiplier, createGame, advance, playCard, canCast, setTarget, defaultPlacement, restoreGame });
});
