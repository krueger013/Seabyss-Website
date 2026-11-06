(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.SeabyssEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Money is stored in cents. Paytable values multiply the stake on ONE line.
  const SYMBOLS = Object.freeze([
    { id: 'skull', name: 'Capitaine maudit', pays: { 3: 8, 4: 24, 5: 80 }, weight: 8 },
    { id: 'chest', name: 'Trésor englouti', pays: { 3: 6, 4: 18, 5: 60 }, weight: 10 },
    { id: 'compass', name: 'Boussole des abysses', pays: { 3: 5, 4: 12, 5: 40 }, weight: 13 },
    { id: 'anchor', name: 'Ancre oubliée', pays: { 3: 4, 4: 10, 5: 30 }, weight: 16 },
    { id: 'rum', name: 'Rhum du naufragé', pays: { 3: 3, 4: 8, 5: 24 }, weight: 20 },
    { id: 'ten', name: 'Dix des profondeurs', pays: { 3: 2, 4: 6, 5: 18 }, weight: 25 },
    { id: 'wild', name: 'Joker maudit', pays: { 3: 10, 4: 30, 5: 100 }, weight: 4 },
    { id: 'scatter', name: 'Navire fantôme', pays: {}, weight: 4 }
  ].map(symbol => Object.freeze({ ...symbol, pays: Object.freeze(symbol.pays) })));
  const BETS = Object.freeze([25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000]);
  const PAYLINES = Object.freeze([
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
    [0, 0, 1, 2, 2], [2, 2, 1, 0, 0],
    [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
    [0, 1, 1, 1, 0], [2, 1, 1, 1, 2],
    [1, 0, 1, 2, 1], [1, 2, 1, 0, 1],
    [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
    [1, 1, 0, 1, 1], [1, 1, 2, 1, 1],
    [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 2, 2, 0]
  ].map(line => Object.freeze(line)));
  const SYMBOL_IDS = new Set(SYMBOLS.map(symbol => symbol.id));
  const BONUS_SPINS = 10;
  const BONUS_AWARDS = Object.freeze({ 3: 10, 4: 15, 5: 20 });
  const STICKY_REELS = Object.freeze([1, 2, 3]);
  const SURPRISE_CHANCE = 0.04;
  const SURPRISE_COOLDOWN = 4;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function validMoney(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function getBonusSpins(scatterCount) {
    if (!Number.isInteger(scatterCount) || scatterCount < 3) return 0;
    return BONUS_AWARDS[Math.min(scatterCount, 5)];
  }

  function inferredBonusAward(state) {
    if (state.bonusSpinsAwarded !== undefined) return state.bonusSpinsAwarded;
    if (!state.inBonus) return 0;
    return state.freeSpins > 15 ? 20 : state.freeSpins > 10 ? 15 : BONUS_SPINS;
  }

  function validateBet(bet) {
    if (!BETS.includes(bet)) fail('INVALID_BET', 'La mise doit être comprise entre 0,25 $ et 20 $.');
  }

  function validateGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== 5 || grid.some(column =>
      !Array.isArray(column) || column.length !== 3 || column.some(symbol => !SYMBOL_IDS.has(symbol)))) {
      fail('INVALID_GRID', 'La grille doit comporter cinq rouleaux de trois symboles valides.');
    }
  }

  function validateLocks(lockedReels) {
    if (!Array.isArray(lockedReels) || new Set(lockedReels).size !== lockedReels.length ||
      lockedReels.some(reel => !STICKY_REELS.includes(reel))) {
      fail('INVALID_LOCKS', 'Seuls les rouleaux 2, 3 et 4 peuvent être figés.');
    }
  }

  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.bonusWin) || !validMoney(state.lastWin) ||
      !Number.isSafeInteger(state.totalSpins) || state.totalSpins < 0 ||
      !Number.isSafeInteger(state.freeSpins) || state.freeSpins < 0 || state.freeSpins > BONUS_AWARDS[5] ||
      (state.bonusSpinsAwarded !== undefined && ![0, 10, 15, 20].includes(state.bonusSpinsAwarded)) ||
      (state.spinsSinceSurprise !== undefined && (!Number.isSafeInteger(state.spinsSinceSurprise) || state.spinsSinceSurprise < 0)) ||
      typeof state.inBonus !== 'boolean' || state.inBonus !== (state.freeSpins > 0)) {
      fail('INVALID_STATE', 'L’état de la partie est invalide.');
    }
    validateBet(state.bet);
    validateLocks(state.lockedReels);
    if (state.inBonus && state.freeSpins > inferredBonusAward(state)) fail('INVALID_STATE', 'Le nombre de tours restants dépasse le bonus attribué.');
    if (!state.inBonus && state.lockedReels.length) fail('INVALID_STATE', 'Les rouleaux figés sont réservés au bonus.');
    if (state.inBonus) validateBet(state.bonusBet == null ? state.bet : state.bonusBet);
  }

  function cloneState(state) {
    // Old saves have no surprise counter: give them the same cooldown as a new game.
    return { ...state, bonusSpinsAwarded: inferredBonusAward(state), spinsSinceSurprise: state.spinsSinceSurprise ?? 0, lockedReels: [...state.lockedReels] };
  }

  function createState() {
    return {
      balance: 10000,
      bet: 100,
      freeSpins: 0,
      lockedReels: [],
      bonusWin: 0,
      inBonus: false,
      bonusBet: null,
      bonusSpinsAwarded: 0,
      lastWin: 0,
      totalSpins: 0,
      spinsSinceSurprise: 0
    };
  }

  function randomValue(rng) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      fail('INVALID_RANDOM', 'Le générateur aléatoire doit renvoyer une valeur entre 0 inclus et 1 exclu.');
    }
    return value;
  }

  function pickSymbol(rng, allowScatter) {
    const pool = allowScatter ? SYMBOLS : SYMBOLS.filter(symbol => symbol.id !== 'scatter');
    const total = pool.reduce((sum, symbol) => sum + symbol.weight, 0);
    let roll = randomValue(rng) * total;
    for (const symbol of pool) {
      roll -= symbol.weight;
      if (roll < 0) return symbol.id;
    }
    return pool[pool.length - 1].id;
  }

  function generateGrid(rng = Math.random) {
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    return Array.from({ length: 5 }, () => {
      let hasScatter = false;
      return Array.from({ length: 3 }, () => {
        const symbol = pickSymbol(rng, !hasScatter);
        if (symbol === 'scatter') hasScatter = true;
        return symbol;
      });
    });
  }

  function applyStickyWilds(grid, lockedReels = []) {
    validateGrid(grid);
    validateLocks(lockedReels);
    const resultGrid = grid.map(column => [...column]);
    const newLocks = STICKY_REELS.filter(reel => !lockedReels.includes(reel) && resultGrid[reel].includes('wild'));
    const allLocks = [...lockedReels, ...newLocks].sort((a, b) => a - b);
    for (const reel of allLocks) resultGrid[reel] = ['wild', 'wild', 'wild'];
    return { grid: resultGrid, lockedReels: allLocks, newLocks };
  }

  function evaluateGrid(grid, bet) {
    validateGrid(grid);
    validateBet(bet);
    const wins = [];
    PAYLINES.forEach((line, index) => {
      const symbols = line.map((row, reel) => grid[reel][row]);
      let best = null;
      for (const candidate of SYMBOLS) {
        if (candidate.id === 'scatter') continue;
        let count = 0;
        for (const symbol of symbols) {
          if (symbol === candidate.id || (symbol === 'wild' && candidate.id !== 'wild')) count += 1;
          else break;
        }
        if (count < 3) continue;
        const multiplier = candidate.pays[count];
        const amount = Math.round(bet * multiplier / PAYLINES.length);
        if (!best || amount > best.amount || (amount === best.amount && count > best.count)) {
          best = {
            line: index + 1,
            index,
            symbol: candidate.id,
            count,
            amount,
            multiplier,
            positions: line.slice(0, count).map((row, reel) => ({ reel, row }))
          };
        }
      }
      if (best) wins.push(best);
    });
    return { wins, totalWin: wins.reduce((sum, win) => sum + win.amount, 0) };
  }

  function startDemoBonus(state, scatterCount = 3) {
    validateState(state);
    const awardedFreeSpins = getBonusSpins(scatterCount);
    if (!awardedFreeSpins) fail('INVALID_SCATTER_COUNT', 'Une démonstration du bonus nécessite au moins trois Scatters.');
    return { ...cloneState(state), inBonus: true, freeSpins: awardedFreeSpins, bonusSpinsAwarded: awardedFreeSpins, bonusBet: state.bet, lockedReels: [], bonusWin: 0, lastWin: 0 };
  }

  function spin(state, options = {}) {
    validateState(state);
    const { rng = Math.random, forcedGrid, forceSurprise } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    const wasInBonus = state.inBonus;
    const activeBet = wasInBonus ? (state.bonusBet == null ? state.bet : state.bonusBet) : state.bet;
    if (!wasInBonus && state.balance < activeBet) fail('INSUFFICIENT_BALANCE', 'Ton solde est insuffisant pour cette mise.');
    let grid;
    if (forcedGrid !== undefined) {
      validateGrid(forcedGrid);
      grid = forcedGrid.map(column => [...column]);
    } else {
      grid = generateGrid(rng);
    }

    const preInterventionGrid = grid.map(column => [...column]);
    const next = cloneState(state);
    let newLocks = [];
    let visibleLocks = [];
    let surpriseTriggered = false;
    const surprisePositions = [];
    if (wasInBonus) {
      const sticky = applyStickyWilds(grid, next.lockedReels);
      grid = sticky.grid;
      next.lockedReels = sticky.lockedReels;
      newLocks = sticky.newLocks;
      visibleLocks = [...sticky.lockedReels];
      next.freeSpins -= 1;
    } else {
      next.balance -= activeBet;
      next.spinsSinceSurprise = Math.min(Number.MAX_SAFE_INTEGER, next.spinsSinceSurprise + 1);
      const naturalScatters = grid.flat().filter(symbol => symbol === 'scatter').length;
      // A captain intervention never replaces an already-earned natural bonus.
      surpriseTriggered = naturalScatters < 3 && (forceSurprise === true ||
        (forceSurprise !== false && next.spinsSinceSurprise >= SURPRISE_COOLDOWN && randomValue(rng) < SURPRISE_CHANCE));
      if (surpriseTriggered) {
        let scattersToPlant = 3 - naturalScatters;
        for (const reel of STICKY_REELS) {
          if (scattersToPlant === 0) break;
          if (grid[reel].includes('scatter')) continue;
          const row = Math.floor(randomValue(rng) * 3);
          grid[reel][row] = 'scatter';
          surprisePositions.push({ reel, row });
          scattersToPlant -= 1;
        }
        next.spinsSinceSurprise = 0;
      }
    }

    // Settle only the final grid: sword strikes can replace paying symbols.
    const { wins, totalWin } = evaluateGrid(grid, activeBet);
    const scatterCount = grid.flat().filter(symbol => symbol === 'scatter').length;
    const awardedFreeSpins = wasInBonus ? 0 : getBonusSpins(scatterCount);
    const bonusTriggered = awardedFreeSpins > 0;
    const bonusEnded = wasInBonus && next.freeSpins === 0;
    next.balance += totalWin;
    next.lastWin = totalWin;
    next.totalSpins += 1;
    if (wasInBonus) next.bonusWin += totalWin;
    if (bonusTriggered) {
      next.inBonus = true;
      next.freeSpins = awardedFreeSpins;
      next.bonusSpinsAwarded = awardedFreeSpins;
      next.bonusBet = activeBet;
      next.bonusWin = 0;
      next.lockedReels = [];
    }
    if (bonusEnded) {
      next.inBonus = false;
      next.lockedReels = [];
      next.bonusBet = null;
    }
    if (!validMoney(next.balance) || !validMoney(next.bonusWin)) fail('BALANCE_OVERFLOW', 'Le solde dépasse la limite du prototype.');
    return { state: next, grid, preInterventionGrid, surpriseTriggered, surprisePositions, wins, totalWin, scatterCount, awardedFreeSpins, bonusTriggered, bonusEnded, newLocks, lockedReels: visibleLocks, bet: activeBet };
  }

  return Object.freeze({ SYMBOLS, BETS, PAYLINES, BONUS_SPINS, BONUS_AWARDS, STICKY_REELS, SURPRISE_CHANCE, SURPRISE_COOLDOWN, getBonusSpins, createState, generateGrid, evaluateGrid, applyStickyWilds, startDemoBonus, spin });
});
