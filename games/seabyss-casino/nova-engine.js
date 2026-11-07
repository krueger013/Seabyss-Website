(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.NovaEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REELS = 6, ROWS = 4, CELL_COUNT = REELS * ROWS, EMPTY = 'empty';
  const MIN_CLUSTER = 5, BONUS_TRIGGER_ORBS = 6, INITIAL_RESPINS = 3;
  const BETS = Object.freeze([25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000]);
  const CLUSTER_TIERS = Object.freeze([
    { min: 5, max: 5, label: '5' }, { min: 6, max: 7, label: '6–7' },
    { min: 8, max: 11, label: '8–11' }, { min: 12, max: 24, label: '12+' }
  ].map(Object.freeze));
  const pays = values => Object.freeze(Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
    const count = index + MIN_CLUSTER;
    return [count, values[count >= 12 ? 3 : count >= 8 ? 2 : count >= 6 ? 1 : 0]];
  })));
  const SYMBOLS = Object.freeze([
    { id: 'rocket', name: 'Fusée', weight: 12, pays: pays([2.56, 3.84, 9.6, 32]) },
    { id: 'planet', name: 'Planète', weight: 14, pays: pays([2.08, 3.2, 8, 25.6]) },
    { id: 'robot', name: 'Robot', weight: 15, pays: pays([1.6, 2.56, 6.4, 19.2]) },
    { id: 'crystal', name: 'Cristal cosmique', weight: 17, pays: pays([1.28, 2.08, 5.12, 16]) },
    { id: 'comet', name: 'Comète', weight: 17, pays: pays([.96, 1.6, 4.16, 12.8]) },
    { id: 'star', name: 'Étoile', weight: 17, pays: pays([.64, 1.28, 3.2, 9.6]) },
    { id: 'orb', name: 'Orbe d’énergie', weight: 10.5, pays: Object.freeze({}) }
  ].map(Object.freeze));
  const CASH_MULTIPLIERS = Object.freeze([.5, 1, 2, 3, 5, 10]);
  const JACKPOT_MULTIPLIERS = Object.freeze({ mini: 10, minor: 50, major: 250, grand: 1000 });
  const ORB_TIERS = Object.freeze([
    { kind: 'cash', multiplier: .5, weight: 3500 }, { kind: 'cash', multiplier: 1, weight: 3500 },
    { kind: 'cash', multiplier: 2, weight: 1600 }, { kind: 'cash', multiplier: 3, weight: 800 },
    { kind: 'cash', multiplier: 5, weight: 400 }, { kind: 'cash', multiplier: 10, weight: 140 },
    { kind: 'mini', multiplier: 10, weight: 50 }, { kind: 'minor', multiplier: 50, weight: 9 },
    { kind: 'major', multiplier: 250, weight: 1 }
  ].map(Object.freeze));
  const ORB_RESPIN_CHANCE = .055;
  const IDS = new Set(SYMBOLS.map(symbol => symbol.id));
  const SYMBOL_BY_ID = Object.fromEntries(SYMBOLS.map(symbol => [symbol.id, symbol]));
  const ALL_CELLS = Array.from({ length: CELL_COUNT }, (_, index) => ({ reel: Math.floor(index / ROWS), row: index % ROWS }));

  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  const validMoney = value => Number.isSafeInteger(value) && value >= 0;
  const cellKey = cell => cell.reel * ROWS + cell.row;
  const copyGrid = grid => grid.map(column => [...column]);
  const copyOrbs = orbs => orbs.map(orb => ({ ...orb }));
  const emptyGrid = () => Array.from({ length: REELS }, () => Array(ROWS).fill(EMPTY));

  function safeAdd(a, b, code = 'BALANCE_OVERFLOW') {
    const total = a + b;
    if (!validMoney(total)) fail(code, 'Le montant dépasse la limite du jeu.');
    return total;
  }
  function validateBet(bet) {
    if (!BETS.includes(bet)) fail('INVALID_BET', 'La mise doit être comprise entre 0,25 $ et 20,00 $.');
  }
  function validateGrid(grid, allowEmpty = false) {
    if (!Array.isArray(grid) || grid.length !== REELS) fail('INVALID_GRID', 'La grille doit comporter six rouleaux.');
    for (let reel = 0; reel < REELS; reel++) {
      if (!Array.isArray(grid[reel]) || grid[reel].length !== ROWS) fail('INVALID_GRID', 'Chaque rouleau doit comporter quatre cases.');
      for (let row = 0; row < ROWS; row++) {
        if (!IDS.has(grid[reel][row]) && !(allowEmpty && grid[reel][row] === EMPTY)) fail('INVALID_GRID', 'La grille contient un symbole invalide.');
      }
    }
  }
  function validateCoordinates(cells) {
    if (!Array.isArray(cells) || cells.length > CELL_COUNT) fail('INVALID_ORBS', 'Les positions des orbes sont invalides.');
    const used = new Set();
    for (const cell of cells) {
      if (!cell || !Number.isInteger(cell.reel) || cell.reel < 0 || cell.reel >= REELS ||
        !Number.isInteger(cell.row) || cell.row < 0 || cell.row >= ROWS || used.has(cellKey(cell))) {
        fail('INVALID_ORBS', 'Chaque orbe doit occuper une case distincte de la grille.');
      }
      used.add(cellKey(cell));
    }
  }
  function orbFromDescriptor(cell, bet) {
    const kind = cell.kind ?? 'cash';
    let multiplier;
    if (kind === 'cash') {
      multiplier = cell.multiplier ?? 1;
      if (!CASH_MULTIPLIERS.includes(multiplier)) fail('INVALID_ORBS', 'La valeur de cet orbe est invalide.');
    } else if (['mini', 'minor', 'major'].includes(kind)) {
      multiplier = JACKPOT_MULTIPLIERS[kind];
      if (cell.multiplier !== undefined && cell.multiplier !== multiplier) fail('INVALID_ORBS', 'Le multiplicateur du jackpot est invalide.');
    } else fail('INVALID_ORBS', 'Ce type d’orbe est inconnu.');
    const amount = Math.round(bet * multiplier);
    if (cell.amount !== undefined && cell.amount !== amount) fail('INVALID_ORBS', 'Le montant de l’orbe ne correspond pas à la mise du bonus.');
    return { reel: cell.reel, row: cell.row, kind, multiplier, amount };
  }
  const sumOrbs = cells => cells.reduce((sum, cell) => safeAdd(sum, cell.amount), 0);
  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.reserveUnits) || !validMoney(state.bonusTotal) ||
      !validMoney(state.lastWin) || !validMoney(state.totalSpins) || typeof state.inBonus !== 'boolean' ||
      !Number.isInteger(state.respins) || state.respins < 0 || state.respins > INITIAL_RESPINS) {
      fail('INVALID_STATE', 'L’état de la station est invalide.');
    }
    validateBet(state.bet);
    validateCoordinates(state.bonusCells);
    if (state.inBonus) {
      validateBet(state.bonusBet);
      if (state.respins < 1 || state.bonusCells.length < BONUS_TRIGGER_ORBS || state.bonusCells.length >= CELL_COUNT) {
        fail('INVALID_STATE', 'Le bonus conservé est invalide.');
      }
      for (const cell of state.bonusCells) {
        if (!['cash', 'mini', 'minor', 'major'].includes(cell.kind) || !validMoney(cell.amount) || cell.multiplier === undefined) {
          fail('INVALID_ORBS', 'Un orbe conservé est incomplet.');
        }
        orbFromDescriptor(cell, state.bonusBet);
      }
      if (state.bonusTotal !== sumOrbs(state.bonusCells)) fail('INVALID_STATE', 'Le total du bonus ne correspond pas aux orbes conservés.');
    } else if (state.respins !== 0 || state.bonusCells.length || state.bonusBet !== null) {
      fail('INVALID_STATE', 'Un bonus terminé ne peut pas conserver des orbes actifs.');
    }
  }
  function cloneState(state) { return { ...state, bonusCells: copyOrbs(state.bonusCells) }; }
  function createState(options = {}) {
    if (!options || typeof options !== 'object') fail('INVALID_STATE', 'Les paramètres initiaux sont invalides.');
    const { balance = 10000, bet = 100, reserveUnits = 0 } = options;
    const state = { balance, bet, reserveUnits, inBonus: false, bonusBet: null, bonusCells: [], respins: 0,
      bonusTotal: 0, lastWin: 0, totalSpins: 0 };
    validateState(state);
    return state;
  }
  function randomValue(rng) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) fail('INVALID_RANDOM', 'Le hasard doit renvoyer une valeur entre 0 inclus et 1 exclu.');
    return value;
  }
  function weightedChoice(pool, rng) {
    let roll = randomValue(rng) * pool.reduce((sum, entry) => sum + entry.weight, 0);
    for (const entry of pool) { roll -= entry.weight; if (roll < 0) return entry; }
    return pool[pool.length - 1];
  }
  function generateGrid(rng = Math.random) {
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    return Array.from({ length: REELS }, () => Array.from({ length: ROWS }, () => weightedChoice(SYMBOLS, rng).id));
  }
  function evaluateGrid(grid, bet) {
    validateGrid(grid);
    validateBet(bet);
    const visited = new Set(), wins = [];
    for (const start of ALL_CELLS) {
      const startKey = cellKey(start), symbol = grid[start.reel][start.row];
      if (visited.has(startKey)) continue;
      visited.add(startKey);
      if (symbol === 'orb') continue;
      const positions = [], queue = [{ ...start }];
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        positions.push(current);
        for (const [dr, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const reel = current.reel + dr, row = current.row + dy;
          if (reel < 0 || reel >= REELS || row < 0 || row >= ROWS || grid[reel][row] !== symbol) continue;
          const nextCell = { reel, row }, nextKey = cellKey(nextCell);
          if (!visited.has(nextKey)) { visited.add(nextKey); queue.push(nextCell); }
        }
      }
      if (positions.length < MIN_CLUSTER) continue;
      const multiplier = SYMBOL_BY_ID[symbol].pays[positions.length];
      wins.push({ symbol, count: positions.length, multiplier, amount: Math.round(bet * multiplier), positions });
    }
    return { wins, totalWin: wins.reduce((sum, win) => safeAdd(sum, win.amount), 0) };
  }
  function jackpotAmounts(bet, reserveUnits) {
    return { mini: bet * 10, minor: bet * 50, major: bet * 250,
      grand: safeAdd(bet * JACKPOT_MULTIPLIERS.grand, Math.floor(reserveUnits / 100)) };
  }
  function getJackpots(state) {
    validateState(state);
    return jackpotAmounts(state.inBonus ? state.bonusBet : state.bet, state.reserveUnits);
  }
  function orbGrid(orbs) {
    const grid = emptyGrid();
    for (const { reel, row } of orbs) grid[reel][row] = 'orb';
    return grid;
  }
  function startDemoBonus(state) {
    validateState(state);
    const next = cloneState(state);
    next.inBonus = true; next.bonusBet = state.bet; next.respins = INITIAL_RESPINS;
    next.bonusCells = ALL_CELLS.filter(cell => cell.row === cell.reel % ROWS).map(cell => orbFromDescriptor(cell, state.bet));
    next.bonusTotal = sumOrbs(next.bonusCells); next.lastWin = 0;
    return next;
  }
  function spin(state, options = {}) {
    validateState(state);
    const { rng = Math.random, forcedGrid, forceOrbs } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    if (forcedGrid !== undefined) validateGrid(forcedGrid, state.inBonus);
    if (forceOrbs !== undefined) validateCoordinates(forceOrbs);
    const wasBonus = state.inBonus, bet = wasBonus ? state.bonusBet : state.bet;
    if (!wasBonus && state.balance < bet) fail('INSUFFICIENT_BALANCE', 'Votre solde est insuffisant pour cette mise.');
    const forcedValues = forceOrbs === undefined ? null : forceOrbs.map(cell => orbFromDescriptor(cell, bet));
    const next = cloneState(state);
    let grid, preInterventionGrid, wins = [], baseWin = 0, newOrbs = [], lockedOrbs = [], bonusTriggered = false;
    let bonusEnded = false, bonusAward = 0, grandAwarded = false, grandAmount = 0, reserveContributionUnits = 0;
    let resultRespins = 0;
    if (!wasBonus) {
      next.balance -= bet;
      reserveContributionUnits = bet;
      next.reserveUnits = safeAdd(next.reserveUnits, bet, 'RESERVE_OVERFLOW');
      grid = forcedGrid === undefined ? generateGrid(rng) : copyGrid(forcedGrid);
      preInterventionGrid = copyGrid(grid);
      if (forcedValues) for (const { reel, row } of forcedValues) grid[reel][row] = 'orb';
      ({ wins, totalWin: baseWin } = evaluateGrid(grid, bet));
      const positions = ALL_CELLS.filter(cell => grid[cell.reel][cell.row] === 'orb');
      if (positions.length >= BONUS_TRIGGER_ORBS) {
        const byCell = new Map((forcedValues || []).map(orb => [cellKey(orb), orb]));
        newOrbs = positions.map(cell => byCell.get(cellKey(cell)) || orbFromDescriptor({ ...cell, ...weightedChoice(ORB_TIERS, rng) }, bet));
        lockedOrbs = copyOrbs(newOrbs);
        next.inBonus = true; next.bonusBet = bet; next.bonusCells = copyOrbs(lockedOrbs);
        next.respins = INITIAL_RESPINS; next.bonusTotal = sumOrbs(lockedOrbs);
        resultRespins = next.respins; bonusTriggered = true;
      }
    } else {
      const heldKeys = new Set(state.bonusCells.map(cellKey));
      preInterventionGrid = orbGrid(state.bonusCells);
      if (forcedValues) {
        if (forcedValues.some(cell => heldKeys.has(cellKey(cell)))) fail('OCCUPIED_CELL', 'Cette case contient déjà un orbe conservé.');
        newOrbs = copyOrbs(forcedValues);
      } else {
        for (const cell of ALL_CELLS) {
          if (heldKeys.has(cellKey(cell))) continue;
          const appears = forcedGrid === undefined ? randomValue(rng) < ORB_RESPIN_CHANCE : forcedGrid[cell.reel][cell.row] === 'orb';
          if (appears) newOrbs.push(orbFromDescriptor({ ...cell, ...weightedChoice(ORB_TIERS, rng) }, bet));
        }
      }
      lockedOrbs = [...copyOrbs(state.bonusCells), ...copyOrbs(newOrbs)];
      next.bonusCells = copyOrbs(lockedOrbs);
      next.bonusTotal = sumOrbs(lockedOrbs);
      next.respins = newOrbs.length ? INITIAL_RESPINS : next.respins - 1;
      resultRespins = next.respins;
      grid = orbGrid(lockedOrbs);
    }
    if (next.inBonus && (next.respins === 0 || lockedOrbs.length === CELL_COUNT)) {
      bonusEnded = true;
      grandAwarded = lockedOrbs.length === CELL_COUNT;
      grandAmount = grandAwarded ? jackpotAmounts(bet, next.reserveUnits).grand : 0;
      bonusAward = safeAdd(sumOrbs(lockedOrbs), grandAmount);
      next.bonusTotal = bonusAward;
      if (grandAwarded) next.reserveUnits = 0;
      next.inBonus = false; next.bonusBet = null; next.bonusCells = []; next.respins = 0;
      resultRespins = 0;
    }
    const totalWin = safeAdd(baseWin, bonusAward);
    next.balance = safeAdd(next.balance, totalWin);
    next.lastWin = totalWin;
    next.totalSpins = safeAdd(next.totalSpins, 1, 'SPIN_OVERFLOW');
    return { state: next, grid, preInterventionGrid, wins, totalWin, baseWin, bet, bonusTriggered, bonusEnded,
      newOrbs: copyOrbs(newOrbs), lockedOrbs: copyOrbs(lockedOrbs), orbCount: grid.flat().filter(symbol => symbol === 'orb').length,
      respins: resultRespins, grandAwarded, grandAmount, bonusAward, reserveContributionUnits };
  }

  return Object.freeze({ REELS, ROWS, CELL_COUNT, EMPTY, MIN_CLUSTER, BONUS_TRIGGER_ORBS, INITIAL_RESPINS, BETS,
    SYMBOLS, CLUSTER_TIERS, CASH_MULTIPLIERS, JACKPOT_MULTIPLIERS, ORB_TIERS, ORB_RESPIN_CHANCE,
    createState, generateGrid, evaluateGrid, getJackpots, startDemoBonus, spin });
});
