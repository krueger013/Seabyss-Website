(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.FelineEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REELS = 5, ROWS = 3;
  const BETS = Object.freeze([25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000]);
  // Multipliers apply to ONE line (total stake / 20). Multiples of four keep
  // the offered quarter-dollar stakes exact at cent precision on every line.
  const SYMBOLS = Object.freeze([
    { id: 'lion', name: 'Lion royal', weight: 7, pays: { 3: 24, 4: 84, 5: 272 } },
    { id: 'tiger', name: 'Tigre de feu', weight: 9, pays: { 3: 16, 4: 60, 5: 204 } },
    { id: 'leopard', name: 'Léopard doré', weight: 11, pays: { 3: 12, 4: 48, 5: 168 } },
    { id: 'panther', name: 'Panthère de nuit', weight: 13, pays: { 3: 12, 4: 36, 5: 136 } },
    { id: 'cheetah', name: 'Guépard des plaines', weight: 15, pays: { 3: 8, 4: 28, 5: 84 } },
    { id: 'ruby', name: 'Rubis sauvage', weight: 17, pays: { 3: 4, 4: 20, 5: 68 } },
    { id: 'flower', name: 'Fleur de la jungle', weight: 20, pays: { 3: 4, 4: 16, 5: 52 } },
    { id: 'wild', name: 'Griffe joker', weight: 4, pays: { 3: 32, 4: 100, 5: 340 } },
    { id: 'scatter', name: 'Totem de la roue', weight: 4, pays: {} }
  ].map(symbol => Object.freeze({ ...symbol, pays: Object.freeze(symbol.pays) })));
  const PAYLINES = Object.freeze([
    [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2], [0,1,2,1,0], [2,1,0,1,2],
    [0,0,1,2,2], [2,2,1,0,0], [1,0,0,0,1], [1,2,2,2,1], [0,1,1,1,0],
    [2,1,1,1,2], [1,0,1,2,1], [1,2,1,0,1], [0,1,0,1,0], [2,1,2,1,2],
    [1,1,0,1,1], [1,1,2,1,1], [0,0,2,0,0], [2,2,0,2,2], [0,2,2,2,0]
  ].map(Object.freeze));
  const BONUS_SPINS = 10;
  const MAX_CLAW_REELS = 2;
  const REEL_GUARDIANS = Object.freeze(['lion', 'tiger', 'leopard', 'panther', 'cheetah']);
  // Fixed odds, independent of balance, previous wins/losses, and session age.
  const CLAW_CHANCE = .0425;
  const BONUS_CLAW_CHANCE = .09;
  const DOUBLE_CLAW_CHANCE = .05;
  const WHEEL_CASH_MULTIPLIERS = Object.freeze([200, 100, 50, 25, 10]);
  const WHEEL_WEIGHTS = Object.freeze([.2, 10, .8, 10, 2, 10, 7, 10, 40, 10]);
  const WHEEL_TOTAL_WEIGHT = WHEEL_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const WHEEL_SEGMENTS = Object.freeze(Array.from({ length: 10 }, (_, index) => {
    const free = index % 2 === 1;
    const symbol = free ? null : REEL_GUARDIANS[index / 2];
    const multiplier = free ? 0 : WHEEL_CASH_MULTIPLIERS[index / 2];
    return Object.freeze({ index, id: free ? 'free-' + REEL_GUARDIANS[(index - 1) / 2] : symbol,
      type: free ? 'free' : 'cash', symbol, multiplier, freeSpins: free ? BONUS_SPINS : 0,
      weight: WHEEL_WEIGHTS[index], probability: WHEEL_WEIGHTS[index] / WHEEL_TOTAL_WEIGHT,
      label: free ? '10 tours gratuits' : SYMBOLS.find(entry => entry.id === symbol).name + ' ×' + multiplier });
  }));
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
  function validateReels(reels, maximum = MAX_CLAW_REELS) {
    if (!Array.isArray(reels) || reels.length > maximum || new Set(reels).size !== reels.length ||
      Array.from(reels).some(reel => !Number.isInteger(reel) || reel < 0 || reel >= REELS)) {
      fail('INVALID_REELS', 'Les rouleaux griffés doivent être distincts et dans la grille.');
    }
  }
  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.lastWin) || !validMoney(state.bonusWin) ||
      !validMoney(state.totalSpins) || typeof state.inBonus !== 'boolean' ||
      !Number.isInteger(state.freeSpins) || state.freeSpins < 0 || state.freeSpins > BONUS_SPINS ||
      state.inBonus !== (state.freeSpins > 0) || ![0, BONUS_SPINS].includes(state.bonusSpinsAwarded) ||
      !Array.isArray(state.reelLocks) || state.reelLocks.length !== REELS ||
      Array.from(state.reelLocks).some(turns => turns !== 0 && turns !== 1) ||
      state.reelLocks.filter(Boolean).length > MAX_CLAW_REELS) {
      fail('INVALID_STATE', 'La sauvegarde de la jungle est invalide.');
    }
    validateBet(state.bet);
    const held = state.reelLocks.some(Boolean);
    if (held) {
      validateBet(state.lockBet);
      if (state.bet !== state.lockBet) fail('BET_LOCKED', 'La mise reste figée tant qu’un rouleau est griffé.');
    } else if (state.lockBet !== null) fail('INVALID_STATE', 'Une mise de griffe nécessite un rouleau conservé.');
    if (state.inBonus) {
      validateBet(state.bonusBet);
      if (state.bonusSpinsAwarded !== BONUS_SPINS || (held && state.lockBet !== state.bonusBet)) fail('INVALID_STATE', 'Le bonus doit conserver sa mise initiale.');
    } else if (state.bonusBet !== null) fail('INVALID_STATE', 'Aucun bonus actif ne peut conserver de mise de bonus.');
    if (state.pendingWheel !== null) {
      if (!state.pendingWheel || typeof state.pendingWheel !== 'object' || Array.isArray(state.pendingWheel) || state.inBonus || held) {
        fail('INVALID_STATE', 'La roue en attente est invalide.');
      }
      validateBet(state.pendingWheel.bet);
    }
    if (state.lastWheel !== null) {
      const receipt = state.lastWheel;
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !Number.isInteger(receipt.index) || receipt.index < 0 || receipt.index >= WHEEL_SEGMENTS.length) fail('INVALID_STATE', 'Le reçu de la roue est invalide.');
      validateBet(receipt.bet);
      const segment = WHEEL_SEGMENTS[receipt.index];
      if (receipt.type !== segment.type || receipt.symbol !== segment.symbol || receipt.multiplier !== segment.multiplier ||
        receipt.freeSpins !== segment.freeSpins || receipt.amount !== receipt.bet * segment.multiplier) {
        fail('INVALID_STATE', 'Le prix de la roue ne correspond pas au reçu.');
      }
    }
    return true;
  }
  function cloneState(state) {
    return { ...state, reelLocks: [...state.reelLocks],
      pendingWheel: state.pendingWheel ? { ...state.pendingWheel } : null,
      lastWheel: state.lastWheel ? { ...state.lastWheel } : null };
  }
  function createState(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_STATE', 'Les paramètres initiaux sont invalides.');
    const state = { balance: options.balance ?? 10000, bet: options.bet ?? 100, bonusBet: null,
      inBonus: false, freeSpins: 0, bonusSpinsAwarded: 0, bonusWin: 0, totalSpins: 0, lastWin: 0,
      reelLocks: [0,0,0,0,0], lockBet: null, pendingWheel: null, lastWheel: null };
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
  function startDemoWheel(state) {
    validateState(state);
    const bet = state.inBonus ? state.bonusBet : (state.lockBet ?? state.bet);
    return { ...cloneState(state), bet, inBonus: false, freeSpins: 0, bonusBet: null,
      bonusSpinsAwarded: 0, bonusWin: 0, lastWin: 0, reelLocks: [0,0,0,0,0],
      lockBet: null, pendingWheel: { bet }, lastWheel: null };
  }
  function resolveWheel(state, options = {}) {
    validateState(state);
    if (!state.pendingWheel) fail('NO_PENDING_WHEEL', 'Cette roue a déjà été résolue ou n’a pas été gagnée.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Les paramètres de la roue sont invalides.');
    const { rng = Math.random, forcedIndex } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le hasard doit être une fonction.');
    let index = forcedIndex;
    if (index === undefined) {
      let roll = randomValue(rng) * WHEEL_TOTAL_WEIGHT;
      index = WHEEL_SEGMENTS.length - 1;
      for (const entry of WHEEL_SEGMENTS) { roll -= entry.weight; if (roll < 0) { index = entry.index; break; } }
    }
    if (!Number.isInteger(index) || index < 0 || index >= WHEEL_SEGMENTS.length) fail('INVALID_SEGMENT', 'La case de la roue est invalide.');
    const segment = WHEEL_SEGMENTS[index], bet = state.pendingWheel.bet;
    const amount = bet * segment.multiplier, awardedFreeSpins = segment.freeSpins;
    const receipt = { index, type: segment.type, bet, amount, freeSpins: awardedFreeSpins,
      multiplier: segment.multiplier, symbol: segment.symbol };
    const next = cloneState(state);
    next.balance = safeAdd(next.balance, amount);
    next.bet = bet; next.pendingWheel = null; next.lastWheel = { ...receipt }; next.lastWin = amount;
    next.inBonus = awardedFreeSpins > 0; next.freeSpins = awardedFreeSpins; next.bonusSpinsAwarded = awardedFreeSpins;
    next.bonusBet = awardedFreeSpins ? bet : null; next.bonusWin = 0;
    return { state: next, index, segment: { ...segment }, prize: amount, amount, totalWin: amount,
      awardedFreeSpins, freeSpins: awardedFreeSpins, bet, bonusTriggered: awardedFreeSpins > 0 };
  }
  function spin(state, options = {}) {
    validateState(state);
    if (state.pendingWheel) fail('WHEEL_PENDING', 'Résolvez la roue avant de relancer les rouleaux.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Les paramètres du tour sont invalides.');
    const { rng = Math.random, forcedGrid, forceFeature } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le hasard doit être une fonction.');
    if (forceFeature !== undefined && typeof forceFeature !== 'boolean') {
      if (!forceFeature || typeof forceFeature !== 'object' || Array.isArray(forceFeature)) fail('INVALID_FEATURE', 'La demande de griffe est invalide.');
      validateReels(forceFeature.reels);
      if (!forceFeature.reels.length) fail('INVALID_FEATURE', 'Une griffe vise un ou deux rouleaux.');
    }
    const wasBonus = state.inBonus;
    const bet = wasBonus ? state.bonusBet : (state.lockBet ?? state.bet);
    if (!wasBonus && state.balance < bet) fail('INSUFFICIENT_BALANCE', 'Votre solde est insuffisant pour cette mise.');
    if (forcedGrid !== undefined) validateGrid(forcedGrid);
    const baseGrid = forcedGrid === undefined ? generateGrid(rng) : copyGrid(forcedGrid);
    const activeReels = state.reelLocks.flatMap((turns, reel) => turns ? [reel] : []);
    for (const reel of activeReels) baseGrid[reel].fill('wild');
    const grid = copyGrid(baseGrid);
    const next = cloneState(state);
    next.bet = bet; next.reelLocks = [0,0,0,0,0]; next.lockBet = null;
    if (wasBonus) next.freeSpins--;
    else next.balance -= bet;
    const scatterCount = baseGrid.flat().filter(id => id === 'scatter').length;
    const available = Array.from({ length: REELS }, (_, reel) => reel)
      .filter(reel => !activeReels.includes(reel) && (wasBonus || !grid[reel].includes('scatter')));
    const eligible = available.length > 0 && (wasBonus || scatterCount < 3);
    let feature = null, newReels = [];
    if (eligible && forceFeature !== false) {
      const requested = forceFeature && typeof forceFeature === 'object' ? forceFeature.reels : null;
      const occurs = forceFeature === true || requested !== null ||
        randomValue(rng) < (wasBonus ? BONUS_CLAW_CHANCE : CLAW_CHANCE);
      if (occurs) {
        if (requested) newReels = requested.filter(reel => available.includes(reel));
        else {
          const count = Math.min(available.length, randomValue(rng) < DOUBLE_CLAW_CHANCE ? 2 : 1);
          for (let i = 0; i < count; i++) newReels.push(available.splice(Math.floor(randomValue(rng) * available.length), 1)[0]);
        }
        newReels.sort((a, b) => a - b);
        for (const reel of newReels) { grid[reel].fill('wild'); next.reelLocks[reel] = 1; }
        if (newReels.length) { feature = { type: 'claw', reels: [...newReels] }; next.lockBet = bet; }
      }
    }
    const { wins, totalWin } = evaluateGrid(grid, bet);
    const wheelTriggered = !wasBonus && scatterCount >= 3;
    const bonusEnded = wasBonus && next.freeSpins === 0;
    next.balance = safeAdd(next.balance, totalWin);
    next.lastWin = totalWin; next.totalSpins = safeAdd(next.totalSpins, 1);
    if (wasBonus) next.bonusWin = safeAdd(next.bonusWin, totalWin);
    if (wheelTriggered) { next.pendingWheel = { bet }; next.lastWheel = null; next.bonusWin = 0; next.bonusSpinsAwarded = 0; }
    if (bonusEnded) { next.inBonus = false; next.bonusBet = null; }
    return { state: next, grid, baseGrid, wins, totalWin, bet, scatterCount, feature,
      lockedReels: [...activeReels, ...newReels].sort((a, b) => a - b), reelLocks: [...next.reelLocks], lockBet: next.lockBet,
      bonusTriggered: wheelTriggered, wheelTriggered, bonusEnded, awardedFreeSpins: 0, multiplier: 1 };
  }
  return Object.freeze({ REELS, ROWS, BETS, SYMBOLS, PAYLINES, BONUS_SPINS, MAX_CLAW_REELS, REEL_GUARDIANS,
    CLAW_CHANCE, BONUS_CLAW_CHANCE, DOUBLE_CLAW_CHANCE, WHEEL_CASH_MULTIPLIERS, WHEEL_WEIGHTS, WHEEL_SEGMENTS,
    createState, validateState, generateGrid, evaluateGrid, startDemoWheel, resolveWheel, spin });
});
