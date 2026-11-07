(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.FlowerEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REELS = 5, ROWS = 3;
  const BETS = Object.freeze([25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000]);
  // Multipliers apply to ONE line (total stake / 20). Multiples of four keep
  // the offered quarter-dollar stakes exact at cent precision on every line.
  const SYMBOLS = Object.freeze([
    { id: 'rose', name: 'Rose impériale', weight: 9, pays: { 3: 16, 4: 48, 5: 160 } },
    { id: 'orchid', name: 'Orchidée lunaire', weight: 11, pays: { 3: 12, 4: 36, 5: 120 } },
    { id: 'peony', name: 'Pivoine enchantée', weight: 14, pays: { 3: 8, 4: 28, 5: 88 } },
    { id: 'tulip', name: 'Tulipe de velours', weight: 17, pays: { 3: 8, 4: 24, 5: 72 } },
    { id: 'daisy', name: 'Marguerite perlée', weight: 19, pays: { 3: 4, 4: 16, 5: 56 } },
    { id: 'sunflower', name: 'Tournesol doré', weight: 22, pays: { 3: 4, 4: 12, 5: 40 } },
    { id: 'wild', name: 'Liane joker', weight: 4, pays: { 3: 20, 4: 60, 5: 200 } },
    { id: 'scatter', name: 'Arrosoir magique', weight: 4, pays: {} }
  ].map(symbol => Object.freeze({ ...symbol, pays: Object.freeze(symbol.pays) })));
  const PAYLINES = Object.freeze([
    [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2], [0,1,2,1,0], [2,1,0,1,2],
    [0,0,1,2,2], [2,2,1,0,0], [1,0,0,0,1], [1,2,2,2,1], [0,1,1,1,0],
    [2,1,1,1,2], [1,0,1,2,1], [1,2,1,0,1], [0,1,0,1,0], [2,1,2,1,2],
    [1,1,0,1,1], [1,1,2,1,1], [0,0,2,0,0], [2,2,0,2,2], [0,2,2,2,0]
  ].map(Object.freeze));
  const BONUS_SPINS = 10;
  const BONUS_AWARDS = Object.freeze({ 3: 10, 4: 15, 5: 20 });
  const MAX_LOCKED_REELS = 2;
  // Fixed odds; there is no adjustment to bankroll, prior wins, or losses.
  const VINE_CHANCE = .06;
  const BONUS_VINE_CHANCE = .11;
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
  function validateReels(reels, maximum = MAX_LOCKED_REELS) {
    if (!Array.isArray(reels) || reels.length > maximum || new Set(reels).size !== reels.length ||
      Array.from(reels).some(reel => !Number.isInteger(reel) || reel < 0 || reel >= REELS)) {
      fail('INVALID_REELS', 'Les rouleaux de liane doivent être distincts et dans la grille.');
    }
  }
  function getBonusSpins(count) {
    return Number.isInteger(count) && count >= 3 ? BONUS_AWARDS[Math.min(count, 5)] : 0;
  }
  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.bonusWin) || !validMoney(state.lastWin) ||
      !validMoney(state.totalSpins) || typeof state.inBonus !== 'boolean' ||
      !Number.isInteger(state.freeSpins) || state.freeSpins < 0 || state.freeSpins > 20 ||
      state.inBonus !== (state.freeSpins > 0) || ![0,10,15,20].includes(state.bonusSpinsAwarded)) {
      fail('INVALID_STATE', 'La sauvegarde du jardin est invalide.');
    }
    validateBet(state.bet); validateReels(state.lockedReels);
    if (state.inBonus) {
      validateBet(state.bonusBet);
      if (state.freeSpins > state.bonusSpinsAwarded) fail('INVALID_STATE', 'Le nombre de tours dépasse le bonus attribué.');
    } else if (state.lockedReels.length || state.bonusBet !== null) {
      fail('INVALID_STATE', 'Les lianes persistantes sont réservées aux tours gratuits.');
    }
    return true;
  }
  function createState(options = {}) {
    if (!options || typeof options !== 'object') fail('INVALID_STATE', 'Les paramètres initiaux sont invalides.');
    const state = { balance: options.balance ?? 10000, bet: options.bet ?? 100, bonusBet: null,
      inBonus: false, freeSpins: 0, bonusSpinsAwarded: 0, bonusWin: 0, lockedReels: [], totalSpins: 0, lastWin: 0 };
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
      bonusSpinsAwarded: award, bonusWin: 0, lockedReels: [], lastWin: 0 };
  }
  function spin(state, options = {}) {
    validateState(state);
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Les paramètres du tour sont invalides.');
    const { rng = Math.random, forcedGrid, forceFeature } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le hasard doit être une fonction.');
    if (forceFeature !== undefined && typeof forceFeature !== 'boolean') {
      if (!forceFeature || typeof forceFeature !== 'object' || Array.isArray(forceFeature)) fail('INVALID_FEATURE', 'La demande de liane est invalide.');
      validateReels(forceFeature.reels, 1);
      if (forceFeature.reels.length !== 1) fail('INVALID_FEATURE', 'Une liane conquiert un rouleau à la fois.');
    }
    const wasBonus = state.inBonus;
    const bet = wasBonus ? state.bonusBet : state.bet;
    if (!wasBonus && state.balance < bet) fail('INSUFFICIENT_BALANCE', 'Votre solde est insuffisant pour cette mise.');
    if (forcedGrid !== undefined) validateGrid(forcedGrid);
    const baseGrid = forcedGrid === undefined ? generateGrid(rng) : copyGrid(forcedGrid);
    const grid = copyGrid(baseGrid);
    const next = { ...state, lockedReels: [...state.lockedReels] };
    if (wasBonus) next.freeSpins--;
    else next.balance -= bet;
    for (const reel of next.lockedReels) grid[reel].fill('wild');
    const naturalScatters = baseGrid.flat().filter(id => id === 'scatter').length;
    const available = Array.from({ length: REELS }, (_, reel) => reel).filter(reel =>
      !next.lockedReels.includes(reel) && (wasBonus || !grid[reel].includes('scatter')));
    const eligible = available.length > 0 && (wasBonus ? next.lockedReels.length < MAX_LOCKED_REELS : naturalScatters < 3);
    let feature = null;
    let visibleLocks = [...next.lockedReels];
    if (eligible && forceFeature !== false) {
      const requested = forceFeature && typeof forceFeature === 'object' ? forceFeature.reels[0] : null;
      const occurs = forceFeature === true || requested !== null || randomValue(rng) < (wasBonus ? BONUS_VINE_CHANCE : VINE_CHANCE);
      if (occurs) {
        const reel = requested ?? available[Math.floor(randomValue(rng) * available.length)];
        if (available.includes(reel)) {
          grid[reel].fill('wild');
          visibleLocks = [...visibleLocks, reel].sort((a, b) => a - b);
          if (wasBonus) next.lockedReels = [...visibleLocks];
          feature = { type: 'vine', reels: [reel] };
        }
      }
    }
    const { wins, totalWin } = evaluateGrid(grid, bet);
    const scatterCount = grid.flat().filter(id => id === 'scatter').length;
    const awardedFreeSpins = wasBonus ? 0 : getBonusSpins(scatterCount);
    const bonusTriggered = awardedFreeSpins > 0;
    const bonusEnded = wasBonus && next.freeSpins === 0;
    next.balance = safeAdd(next.balance, totalWin);
    next.lastWin = totalWin; next.totalSpins = safeAdd(next.totalSpins, 1);
    if (wasBonus) next.bonusWin = safeAdd(next.bonusWin, totalWin);
    if (bonusTriggered) {
      next.inBonus = true; next.freeSpins = awardedFreeSpins; next.bonusSpinsAwarded = awardedFreeSpins;
      next.bonusBet = bet; next.bonusWin = 0; next.lockedReels = [];
    }
    if (bonusEnded) { next.inBonus = false; next.bonusBet = null; next.lockedReels = []; }
    return { state: next, grid, baseGrid, wins, totalWin, bet, scatterCount,
      bonusTriggered, bonusEnded, awardedFreeSpins, feature, lockedReels: visibleLocks, multiplier: 1 };
  }
  return Object.freeze({ REELS, ROWS, BETS, SYMBOLS, PAYLINES, BONUS_SPINS, BONUS_AWARDS, MAX_LOCKED_REELS,
    VINE_CHANCE, BONUS_VINE_CHANCE, getBonusSpins, createState, validateState, generateGrid, evaluateGrid, startDemoBonus, spin });
});
