(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.MedievalEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REELS = 5, ROWS = 3;
  const BETS = Object.freeze([25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000]);
  // Multipliers apply to ONE line (total stake / 20). Multiples of four keep
  // the offered quarter-dollar stakes exact at cent precision on every line.
  const SYMBOLS = Object.freeze([
    { id: 'king', name: 'Roi des dragons', weight: 7, pays: { 3: 28, 4: 100, 5: 320 } },
    { id: 'queen', name: 'Reine de la couronne', weight: 9, pays: { 3: 20, 4: 72, 5: 240 } },
    { id: 'knight', name: 'Chevalier royal', weight: 11, pays: { 3: 16, 4: 56, 5: 200 } },
    { id: 'castle', name: 'Citadelle', weight: 13, pays: { 3: 12, 4: 44, 5: 160 } },
    { id: 'chalice', name: 'Calice enchanté', weight: 15, pays: { 3: 8, 4: 32, 5: 100 } },
    { id: 'shield', name: 'Bouclier royal', weight: 17, pays: { 3: 4, 4: 24, 5: 80 } },
    { id: 'sword', name: 'Épée légendaire', weight: 20, pays: { 3: 4, 4: 20, 5: 60 } },
    { id: 'wild', name: 'Sceau du dragon', weight: 4, pays: { 3: 36, 4: 120, 5: 400 } },
    { id: 'scatter', name: 'Coffre du siège', weight: 4, pays: {} }
  ].map(symbol => Object.freeze({ ...symbol, pays: Object.freeze(symbol.pays) })));
  const PAYLINES = Object.freeze([
    [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2], [0,1,2,1,0], [2,1,0,1,2],
    [0,0,1,2,2], [2,2,1,0,0], [1,0,0,0,1], [1,2,2,2,1], [0,1,1,1,0],
    [2,1,1,1,2], [1,0,1,2,1], [1,2,1,0,1], [0,1,0,1,0], [2,1,2,1,2],
    [1,1,0,1,1], [1,1,2,1,1], [0,0,2,0,0], [2,2,0,2,2], [0,2,2,2,0]
  ].map(Object.freeze));
  const BONUS_SPINS = 6;
  const BONUS_AWARDS = Object.freeze({ 3: 6, 4: 8, 5: 10 });
  const MAX_BREATH_REELS = 2, MAX_SIEGE_KEYS = 9;
  const GATE_THRESHOLDS = Object.freeze([3, 6, 9]);
  const GATE_MULTIPLIERS = Object.freeze([2, 4, 8]);
  // Fixed odds, independent of bankroll, past wins, losses, and gate progress.
  const DRAGON_CHANCE = .065;
  const BONUS_DRAGON_CHANCE = .12;
  const DOUBLE_BREATH_CHANCE = .08; // Conditional on a dragon intervention.
  const IDS = new Set(SYMBOLS.map(symbol => symbol.id));
  const WITHOUT_SCATTER = SYMBOLS.filter(symbol => symbol.id !== 'scatter');
  const PAYING = WITHOUT_SCATTER;
  const WEIGHT = SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
  const WITHOUT_SCATTER_WEIGHT = WITHOUT_SCATTER.reduce((sum, symbol) => sum + symbol.weight, 0);
  const copyGrid = grid => grid.map(column => [...column]);
  const validMoney = value => Number.isSafeInteger(value) && value >= 0;

  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function safeAdd(a, b) {
    const value = a + b;
    if (!validMoney(value)) fail('BALANCE_OVERFLOW', 'Le montant dépasse la limite du jeu.');
    return value;
  }
  function validateBet(bet) {
    if (!BETS.includes(bet)) fail('INVALID_BET', 'Choisissez une mise de 0,25 $ à 20 $.');
  }
  function validateGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== REELS) fail('INVALID_GRID', 'La grille doit avoir cinq rouleaux.');
    for (let reel = 0; reel < REELS; reel++) {
      if (!Array.isArray(grid[reel]) || grid[reel].length !== ROWS) fail('INVALID_GRID', 'Chaque rouleau doit avoir trois cases.');
      for (let row = 0; row < ROWS; row++) if (!IDS.has(grid[reel][row])) fail('INVALID_GRID', 'Un symbole de la grille est invalide.');
    }
  }
  function validateReels(reels, maximum = MAX_BREATH_REELS) {
    if (!Array.isArray(reels) || reels.length > maximum || new Set(reels).size !== reels.length ||
      Array.from(reels).some(reel => !Number.isInteger(reel) || reel < 0 || reel >= REELS)) {
      fail('INVALID_REELS', 'Les rouleaux du souffle doivent être distincts et dans la grille.');
    }
  }
  function getBonusSpins(count) {
    return Number.isInteger(count) && count >= 3 ? BONUS_AWARDS[Math.min(count, 5)] : 0;
  }
  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.bonusWin) || !validMoney(state.lastWin) ||
      !validMoney(state.totalSpins) || typeof state.inBonus !== 'boolean' ||
      !Number.isInteger(state.freeSpins) || state.freeSpins < 0 || state.freeSpins > 10 ||
      state.inBonus !== (state.freeSpins > 0) || ![0,6,8,10].includes(state.bonusSpinsAwarded) ||
      !Array.isArray(state.lockedReels) || state.lockedReels.length ||
      !Number.isInteger(state.siegeKeys) || state.siegeKeys < 0 || state.siegeKeys > MAX_SIEGE_KEYS ||
      !Number.isInteger(state.gatesOpened) || state.gatesOpened !== Math.floor(state.siegeKeys / 3)) {
      fail('INVALID_STATE', 'La sauvegarde du siège est invalide.');
    }
    validateBet(state.bet);
    if (state.inBonus) {
      validateBet(state.bonusBet);
      if (state.freeSpins > state.bonusSpinsAwarded) fail('INVALID_STATE', 'Le nombre d’assauts dépasse le bonus attribué.');
    } else if (state.bonusBet !== null || state.siegeKeys !== 0 || state.gatesOpened !== 0) {
      fail('INVALID_STATE', 'Les clés du siège ne persistent que pendant le bonus.');
    }
    return true;
  }
  function createState(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_STATE', 'Les paramètres initiaux sont invalides.');
    const state = { balance: options.balance ?? 10000, bet: options.bet ?? 100, bonusBet: null,
      inBonus: false, freeSpins: 0, bonusSpinsAwarded: 0, bonusWin: 0, lockedReels: [], totalSpins: 0, lastWin: 0, siegeKeys: 0, gatesOpened: 0 };
    validateState(state);
    return state;
  }
  function randomValue(rng) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) fail('INVALID_RANDOM', 'Le hasard doit renvoyer une valeur entre 0 inclus et 1 exclu.');
    return value;
  }
  function generateGrid(rng = Math.random) {
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le hasard doit être une fonction.');
    return Array.from({ length: REELS }, () => {
      let hasScatter = false;
      return Array.from({ length: ROWS }, () => {
        const pool = hasScatter ? WITHOUT_SCATTER : SYMBOLS;
        let roll = randomValue(rng) * (hasScatter ? WITHOUT_SCATTER_WEIGHT : WEIGHT);
        let selected = pool[pool.length - 1];
        for (const symbol of pool) { roll -= symbol.weight; if (roll < 0) { selected = symbol; break; } }
        if (selected.id === 'scatter') hasScatter = true;
        return selected.id;
      });
    });
  }
  function evaluateGrid(grid, bet) {
    validateGrid(grid); validateBet(bet);
    const wins = [];
    PAYLINES.forEach((line, index) => {
      const sequence = line.map((row, reel) => grid[reel][row]);
      let best = null;
      for (const symbol of PAYING) {
        let count = 0;
        for (const id of sequence) {
          if (id === symbol.id || (id === 'wild' && symbol.id !== 'wild')) count++;
          else break;
        }
        if (count < 3) continue;
        const multiplier = symbol.pays[count];
        const amount = Math.round(bet * multiplier / PAYLINES.length);
        if (!best || amount > best.amount || (amount === best.amount && count > best.count)) {
          best = { line: index + 1, index, symbol: symbol.id, count, reelCount: count, ways: 1,
            multiplier, amount, positions: line.slice(0, count).map((row, reel) => ({ reel, row })) };
        }
      }
      if (best) wins.push(best);
    });
    return { wins, totalWin: wins.reduce((sum, win) => safeAdd(sum, win.amount), 0) };
  }
  function startDemoBonus(state, scatterCount = 3) {
    validateState(state);
    const award = getBonusSpins(scatterCount);
    if (!award) fail('INVALID_SCATTER_COUNT', 'Un bonus nécessite au moins trois Scatters.');
    return { ...state, bonusBet: state.bet, inBonus: true, freeSpins: award,
      bonusSpinsAwarded: award, bonusWin: 0, lockedReels: [], lastWin: 0, siegeKeys: 0, gatesOpened: 0 };
  }
  function spin(state, options = {}) {
    validateState(state);
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Les paramètres du tour sont invalides.');
    const { rng = Math.random, forcedGrid, forceFeature } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le hasard doit être une fonction.');
    if (forceFeature !== undefined && typeof forceFeature !== 'boolean') {
      if (!forceFeature || typeof forceFeature !== 'object' || Array.isArray(forceFeature)) fail('INVALID_FEATURE', 'La demande de souffle est invalide.');
      validateReels(forceFeature.reels);
      if (!forceFeature.reels.length) fail('INVALID_FEATURE', 'Un souffle vise un ou deux rouleaux.');
    }
    const wasBonus = state.inBonus;
    const bet = wasBonus ? state.bonusBet : state.bet;
    if (!wasBonus && state.balance < bet) fail('INSUFFICIENT_BALANCE', 'Votre solde est insuffisant pour cette mise.');
    if (forcedGrid !== undefined) validateGrid(forcedGrid);
    const baseGrid = forcedGrid === undefined ? generateGrid(rng) : copyGrid(forcedGrid);
    const grid = copyGrid(baseGrid);
    const next = { ...state, lockedReels: [] };
    const naturalChests = [];
    for (let reel = 0; reel < REELS; reel++) for (let row = 0; row < ROWS; row++) {
      if (baseGrid[reel][row] === 'scatter') naturalChests.push({ reel, row });
    }
    const scatterCount = naturalChests.length;
    let collectedKeys = 0, gateWin = 0;
    const openedGates = [];
    if (wasBonus) {
      next.freeSpins--;
      // Collect before the breath: a chest replaced by a joker still gives its key.
      collectedKeys = Math.min(scatterCount, MAX_SIEGE_KEYS - next.siegeKeys);
      next.siegeKeys += collectedKeys;
      const gatesNow = Math.floor(next.siegeKeys / 3);
      for (let index = next.gatesOpened; index < gatesNow; index++) {
        const amount = Math.round(bet * GATE_MULTIPLIERS[index]);
        openedGates.push({ gate: index + 1, keys: GATE_THRESHOLDS[index], multiplier: GATE_MULTIPLIERS[index], amount });
        gateWin = safeAdd(gateWin, amount);
      }
      next.gatesOpened = gatesNow;
    } else {
      next.balance -= bet;
    }
    const available = Array.from({ length: REELS }, (_, reel) => reel)
      .filter(reel => wasBonus || !grid[reel].includes('scatter'));
    const eligible = available.length > 0 && (wasBonus || scatterCount < 3);
    let feature = null;
    let breathedReels = [];
    if (eligible && forceFeature !== false) {
      const requested = forceFeature && typeof forceFeature === 'object' ? forceFeature.reels : null;
      const occurs = forceFeature === true || requested !== null ||
        randomValue(rng) < (wasBonus ? BONUS_DRAGON_CHANCE : DRAGON_CHANCE);
      if (occurs) {
        if (requested) {
          breathedReels = requested.filter(reel => available.includes(reel));
        } else {
          const count = Math.min(available.length, randomValue(rng) < DOUBLE_BREATH_CHANCE ? 2 : 1);
          for (let i = 0; i < count; i++) breathedReels.push(available.splice(Math.floor(randomValue(rng) * available.length), 1)[0]);
        }
        breathedReels.sort((a, b) => a - b);
        for (const reel of breathedReels) grid[reel].fill('wild');
        if (breathedReels.length) feature = { type: 'dragon', reels: [...breathedReels] };
      }
    }
    const { wins, totalWin: lineWin } = evaluateGrid(grid, bet);
    const totalWin = safeAdd(lineWin, gateWin);
    const awardedFreeSpins = wasBonus ? 0 : getBonusSpins(scatterCount);
    const bonusTriggered = awardedFreeSpins > 0;
    const bonusEnded = wasBonus && next.freeSpins === 0;
    next.balance = safeAdd(next.balance, totalWin);
    next.lastWin = totalWin; next.totalSpins = safeAdd(next.totalSpins, 1);
    if (wasBonus) next.bonusWin = safeAdd(next.bonusWin, totalWin);
    const siegeKeys = next.siegeKeys, gatesOpened = next.gatesOpened;
    if (bonusTriggered) {
      next.inBonus = true; next.freeSpins = awardedFreeSpins; next.bonusSpinsAwarded = awardedFreeSpins;
      next.bonusBet = bet; next.bonusWin = 0; next.siegeKeys = 0; next.gatesOpened = 0;
    }
    if (bonusEnded) { next.inBonus = false; next.bonusBet = null; next.siegeKeys = 0; next.gatesOpened = 0; }
    return { state: next, grid, baseGrid, wins, totalWin, lineWin, gateWin, bet, scatterCount,
      visibleScatterCount: grid.flat().filter(id => id === 'scatter').length,
      bonusTriggered, bonusEnded, awardedFreeSpins, feature, lockedReels: [...breathedReels], multiplier: 1,
      siegeKeys, gatesOpened, collectedKeys, collectedKeyPositions: wasBonus ? naturalChests.slice(0, collectedKeys) : [], openedGates };
  }
  return Object.freeze({ REELS, ROWS, BETS, SYMBOLS, PAYLINES, BONUS_SPINS, BONUS_AWARDS, MAX_BREATH_REELS,
    MAX_SIEGE_KEYS, GATE_THRESHOLDS, GATE_MULTIPLIERS, DRAGON_CHANCE, BONUS_DRAGON_CHANCE, DOUBLE_BREATH_CHANCE,
    getBonusSpins, createState, validateState, generateGrid, evaluateGrid, startDemoBonus, spin });
});
