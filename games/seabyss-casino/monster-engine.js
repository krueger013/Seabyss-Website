(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.MonsterEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REELS = 5, ROWS = 3, MIN_MATCH = 3, MAX_WAYS = 243;
  const BETS = Object.freeze([25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000]);
  const BONUS_AWARDS = Object.freeze({ 3: 10, 4: 15, 5: 20 });
  const BONUS_SPINS = 10, MAX_MULTIPLIER = 3;
  // Fixed probabilities, independent of bankroll, past wins, and session age.
  const PARTY_CHANCE = .145;
  const TRIPLE_PARTY_CHANCE = .05; // Conditional on a base-game party.
  const BONUS_PARTY_CHANCE = .18;
  // Pays multiply the TOTAL stake, per distinct left-to-right path.
  const SYMBOLS = Object.freeze([
    { id: 'mochi', name: 'Mochi', weight: 10, pays: { 3: .30, 4: .85, 5: 2.10 } },
    { id: 'puff', name: 'Puff', weight: 12, pays: { 3: .22, 4: .65, 5: 1.40 } },
    { id: 'bubbles', name: 'Bubbles', weight: 14, pays: { 3: .18, 4: .45, 5: 1.10 } },
    { id: 'sprout', name: 'Sprout', weight: 16, pays: { 3: .14, 4: .35, 5: .85 } },
    { id: 'zippy', name: 'Zippy', weight: 19, pays: { 3: .12, 4: .30, 5: .70 } },
    { id: 'luna', name: 'Luna', weight: 21, pays: { 3: .08, 4: .22, 5: .55 } },
    { id: 'wild', name: 'Étoile joker', weight: 4, pays: {} },
    { id: 'scatter', name: 'Invitation à la fête', weight: 4, pays: {} }
  ].map(symbol => Object.freeze({ ...symbol, pays: Object.freeze(symbol.pays) })));
  const IDS = new Set(SYMBOLS.map(symbol => symbol.id));
  const PAYING = SYMBOLS.filter(symbol => symbol.id !== 'wild' && symbol.id !== 'scatter');
  const NO_SCATTER = SYMBOLS.filter(symbol => symbol.id !== 'scatter');
  const copyGrid = grid => grid.map(column => [...column]);
  const validMoney = amount => Number.isSafeInteger(amount) && amount >= 0;

  function fail(code, message) {
    const error = new Error(message); error.code = code; throw error;
  }
  function safeAdd(a, b, code = 'BALANCE_OVERFLOW') {
    const total = a + b;
    if (!validMoney(total)) fail(code, 'Le montant dépasse la limite du jeu.');
    return total;
  }
  function validateBet(bet) {
    if (!BETS.includes(bet)) fail('INVALID_BET', 'Choisissez une mise de 0,25 $ à 20,00 $.');
  }
  function validateMultiplier(multiplier) {
    if (![1, 2, 3].includes(multiplier)) fail('INVALID_MULTIPLIER', 'Le multiplicateur doit être 1, 2 ou 3.');
  }
  function validateGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== REELS) fail('INVALID_GRID', 'La grille doit avoir cinq rouleaux de trois symboles.');
    for (let reel = 0; reel < REELS; reel++) {
      if (!Array.isArray(grid[reel]) || grid[reel].length !== ROWS) fail('INVALID_GRID', 'Chaque rouleau doit avoir trois symboles.');
      for (let row = 0; row < ROWS; row++) if (!IDS.has(grid[reel][row])) fail('INVALID_GRID', 'La grille contient un symbole inconnu.');
    }
  }
  function getBonusSpins(count) {
    return Number.isInteger(count) && count >= 3 ? BONUS_AWARDS[Math.min(5, count)] : 0;
  }
  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.lastWin) || !validMoney(state.bonusWin) ||
      !validMoney(state.totalSpins) || typeof state.inBonus !== 'boolean' ||
      !Number.isInteger(state.freeSpins) || state.freeSpins < 0 || state.freeSpins > 20 ||
      state.inBonus !== (state.freeSpins > 0) || ![0, 10, 15, 20].includes(state.bonusSpinsAwarded) ||
      !Array.isArray(state.lockedReels) || state.lockedReels.length) {
      fail('INVALID_STATE', 'L’état de la fête est invalide.');
    }
    validateBet(state.bet);
    validateMultiplier(state.partyMultiplier);
    if (state.inBonus) {
      validateBet(state.bonusBet);
      if (state.freeSpins > state.bonusSpinsAwarded) fail('INVALID_STATE', 'Le nombre de tours dépasse le bonus attribué.');
    } else if (state.bonusBet !== null || state.partyMultiplier !== 1) {
      fail('INVALID_STATE', 'Une fête terminée ne peut pas conserver un multiplicateur de bonus.');
    }
    return true;
  }
  function createState() {
    return { balance: 10000, bet: 100, bonusBet: null, inBonus: false, freeSpins: 0,
      bonusSpinsAwarded: 0, bonusWin: 0, lockedReels: [], totalSpins: 0, lastWin: 0, partyMultiplier: 1 };
  }
  function randomValue(rng) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) fail('INVALID_RANDOM', 'Le hasard doit renvoyer une valeur entre 0 inclus et 1 exclu.');
    return value;
  }
  function pickSymbol(rng, pool) {
    let roll = randomValue(rng) * pool.reduce((sum, symbol) => sum + symbol.weight, 0);
    for (const symbol of pool) { roll -= symbol.weight; if (roll < 0) return symbol.id; }
    return pool[pool.length - 1].id;
  }
  function generateGrid(rng = Math.random) {
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    return Array.from({ length: REELS }, () => {
      let hasScatter = false;
      return Array.from({ length: ROWS }, () => {
        const id = pickSymbol(rng, hasScatter ? NO_SCATTER : SYMBOLS);
        if (id === 'scatter') hasScatter = true;
        return id;
      });
    });
  }
  function evaluateGrid(grid, bet, partyMultiplier = 1) {
    validateGrid(grid); validateBet(bet); validateMultiplier(partyMultiplier);
    const wins = [];
    for (const symbol of PAYING) {
      const positions = [], naturalReels = [];
      let reelCount = 0, combinations = 1, pureWildWays = 1, naturalCount = 0;
      for (let reel = 0; reel < REELS; reel++) {
        const matches = [];
        let wilds = 0;
        for (let row = 0; row < ROWS; row++) {
          const id = grid[reel][row];
          if (id !== symbol.id && id !== 'wild') continue;
          matches.push({ reel, row });
          if (id === 'wild') wilds++;
        }
        if (!matches.length) break;
        reelCount++; combinations *= matches.length; pureWildWays *= wilds;
        naturalCount += matches.length - wilds;
        if (matches.length > wilds) naturalReels.push(reel);
        positions.push(...matches);
      }
      if (reelCount < MIN_MATCH) continue;
      // Each paid path needs a natural monster. Entirely-wild paths cannot
      // create six duplicate symbol awards; only the longest prefix pays.
      const ways = combinations - pureWildWays;
      if (!ways) continue;
      const winningPositions = naturalReels.length === 1
        ? positions.filter(({ reel, row }) => reel !== naturalReels[0] || grid[reel][row] !== 'wild')
        : positions;
      const multiplier = symbol.pays[reelCount];
      const amount = Math.round(bet * multiplier * ways * partyMultiplier);
      wins.push({ symbol: symbol.id, count: reelCount, reelCount, ways, naturalCount,
        wildCount: winningPositions.filter(({ reel, row }) => grid[reel][row] === 'wild').length,
        multiplier, partyMultiplier, amount, positions: winningPositions });
    }
    return { wins, totalWin: wins.reduce((sum, win) => safeAdd(sum, win.amount), 0) };
  }
  function startDemoBonus(state, scatterCount = 3) {
    validateState(state);
    const awarded = getBonusSpins(scatterCount);
    if (!awarded) fail('INVALID_SCATTER_COUNT', 'Le bonus nécessite au moins trois invitations.');
    return { ...state, lockedReels: [], inBonus: true, freeSpins: awarded, bonusSpinsAwarded: awarded,
      bonusBet: state.bet, bonusWin: 0, lastWin: 0, partyMultiplier: 1 };
  }
  function spin(state, options = {}) {
    validateState(state);
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Les paramètres du tour sont invalides.');
    const { rng = Math.random, forcedGrid, forceFeature } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    const explicitParty = forceFeature && typeof forceFeature === 'object' && !Array.isArray(forceFeature);
    if (forceFeature !== undefined && forceFeature !== false && forceFeature !== true && !explicitParty) {
      fail('INVALID_FEATURE', 'La fête demandée est invalide.');
    }
    if (explicitParty && ![2, 3].includes(forceFeature.multiplier)) fail('INVALID_FEATURE', 'Une fête doit multiplier les gains par 2 ou 3.');
    if (forcedGrid !== undefined) validateGrid(forcedGrid);
    const wasBonus = state.inBonus, bet = wasBonus ? state.bonusBet : state.bet;
    if (!wasBonus && state.balance < bet) fail('INSUFFICIENT_BALANCE', 'Votre solde est insuffisant pour cette mise.');
    const grid = forcedGrid === undefined ? generateGrid(rng) : copyGrid(forcedGrid);
    const baseGrid = copyGrid(grid);
    const next = { ...state, lockedReels: [] };
    let multiplier = wasBonus ? state.partyMultiplier : 1, feature = null;
    const eligible = !wasBonus || multiplier < MAX_MULTIPLIER;
    const party = eligible && (explicitParty || forceFeature === true ||
      (forceFeature !== false && randomValue(rng) < (wasBonus ? BONUS_PARTY_CHANCE : PARTY_CHANCE)));
    if (party) {
      const requested = explicitParty ? forceFeature.multiplier : wasBonus ? multiplier + 1 :
        randomValue(rng) < TRIPLE_PARTY_CHANCE ? 3 : 2;
      const increased = wasBonus ? Math.max(multiplier, requested) : requested;
      if (increased > multiplier) { multiplier = increased; feature = { type: 'party', multiplier }; }
    }
    if (wasBonus) { next.freeSpins--; next.partyMultiplier = multiplier; }
    else next.balance -= bet;
    const { wins, totalWin } = evaluateGrid(grid, bet, multiplier);
    const scatterCount = grid.flat().filter(id => id === 'scatter').length;
    const awardedFreeSpins = wasBonus ? 0 : getBonusSpins(scatterCount);
    const bonusTriggered = awardedFreeSpins > 0, bonusEnded = wasBonus && next.freeSpins === 0;
    next.balance = safeAdd(next.balance, totalWin);
    next.lastWin = totalWin;
    next.totalSpins = safeAdd(next.totalSpins, 1, 'SPIN_OVERFLOW');
    if (wasBonus) next.bonusWin = safeAdd(next.bonusWin, totalWin);
    if (bonusTriggered) {
      next.inBonus = true; next.freeSpins = awardedFreeSpins; next.bonusSpinsAwarded = awardedFreeSpins;
      next.bonusBet = bet; next.bonusWin = 0; next.partyMultiplier = 1;
    }
    if (bonusEnded) { next.inBonus = false; next.bonusBet = null; next.partyMultiplier = 1; }
    return { state: next, grid, baseGrid, wins, totalWin, bet, scatterCount, bonusTriggered, bonusEnded,
      awardedFreeSpins, feature, multiplier, lockedReels: [] };
  }

  return Object.freeze({ REELS, ROWS, MIN_MATCH, MAX_WAYS, BETS, BONUS_AWARDS, BONUS_SPINS, MAX_MULTIPLIER,
    PARTY_CHANCE, TRIPLE_PARTY_CHANCE, BONUS_PARTY_CHANCE, SYMBOLS, getBonusSpins, createState,
    validateState, generateGrid, evaluateGrid, startDemoBonus, spin });
});
