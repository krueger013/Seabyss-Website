(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.MoonEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // All balances and awards are integer cents. Multipliers use the TOTAL stake.
  const SYMBOLS = Object.freeze([
    { id: 'vampire', name: 'Seigneur vampire', weight: 10, pays: { 3: .20, 4: .60, 5: 1.50 } },
    { id: 'wolf', name: 'Loup-garou', weight: 12, pays: { 3: .16, 4: .45, 5: 1.00 } },
    { id: 'grimoire', name: 'Grimoire interdit', weight: 14, pays: { 3: .12, 4: .30, 5: .75 } },
    { id: 'potion', name: 'Potion ensorcelée', weight: 16, pays: { 3: .10, 4: .25, 5: .60 } },
    { id: 'moon', name: 'Lune de sang', weight: 19, pays: { 3: .08, 4: .20, 5: .50 } },
    { id: 'ring', name: 'Anneau ancestral', weight: 21, pays: { 3: .06, 4: .15, 5: .40 } },
    { id: 'wild', name: 'Cristal joker', weight: 4, pays: {} },
    { id: 'scatter', name: 'Sceau de la sorcière', weight: 4, pays: {} }
  ].map(symbol => Object.freeze({ ...symbol, pays: Object.freeze(symbol.pays) })));
  const BETS = Object.freeze([25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000]);
  const BONUS_AWARDS = Object.freeze({ 3: 10, 4: 15, 5: 20 });
  const BONUS_SPINS = 10;
  const MIN_MATCH = 3;
  const MAX_WAYS = 243;
  const FREEZE_CHANCE = .32;
  const BASE_FREEZE_CHANCE = .07;
  const SURPRISE_CHANCE = .03;
  const SURPRISE_COOLDOWN = 4;
  // Leave three unfrozen positions so the witch cannot force an all-wild board.
  const MAX_FROZEN_CELLS = 12;
  const IDS = new Set(SYMBOLS.map(symbol => symbol.id));
  const PAYING = SYMBOLS.filter(symbol => symbol.id !== 'wild' && symbol.id !== 'scatter');
  const ALL_CELLS = Array.from({ length: 15 }, (_, index) => ({ reel: Math.floor(index / 3), row: index % 3 }));

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  const cellKey = ({ reel, row }) => reel * 3 + row;
  const copyCells = cells => cells.map(cell => ({ reel: cell.reel, row: cell.row }));
  const copyGrid = grid => grid.map(column => [...column]);
  const validMoney = value => Number.isSafeInteger(value) && value >= 0;

  function getBonusSpins(count) {
    return Number.isInteger(count) && count >= 3 ? BONUS_AWARDS[Math.min(5, count)] : 0;
  }

  function validateBet(bet) {
    if (!BETS.includes(bet)) fail('INVALID_BET', 'Choisissez une mise de 0,25 $ à 20,00 $.');
  }

  function validateGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== 5) fail('INVALID_GRID', 'La grille doit avoir cinq rouleaux de trois symboles.');
    for (let reel = 0; reel < 5; reel++) {
      const column = grid[reel];
      if (!Array.isArray(column) || column.length !== 3) fail('INVALID_GRID', 'Chaque rouleau doit avoir trois symboles.');
      for (let row = 0; row < 3; row++) if (!IDS.has(column[row])) fail('INVALID_GRID', 'La grille contient un symbole invalide.');
    }
  }

  function validateCells(cells, limit = MAX_FROZEN_CELLS) {
    if (!Array.isArray(cells) || cells.length > limit) fail('INVALID_CELLS', 'Les cases de gel sont invalides.');
    const seen = new Set();
    for (const cell of cells) {
      if (!cell || !Number.isInteger(cell.reel) || cell.reel < 0 || cell.reel > 4 ||
        !Number.isInteger(cell.row) || cell.row < 0 || cell.row > 2 || seen.has(cellKey(cell))) {
        fail('INVALID_CELLS', 'Chaque case de gel doit être distincte et dans la grille.');
      }
      seen.add(cellKey(cell));
    }
  }

  function inferredAward(state) {
    if (state.bonusSpinsAwarded !== undefined) return state.bonusSpinsAwarded;
    if (!state.inBonus) return 0;
    return state.freeSpins > 15 ? 20 : state.freeSpins > 10 ? 15 : 10;
  }

  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.lastWin) || !validMoney(state.bonusWin) ||
      !Number.isSafeInteger(state.totalSpins) || state.totalSpins < 0 ||
      !Number.isInteger(state.freeSpins) || state.freeSpins < 0 || state.freeSpins > 20 ||
      typeof state.inBonus !== 'boolean' || state.inBonus !== (state.freeSpins > 0) ||
      (state.spinsSinceSurprise !== undefined && !validMoney(state.spinsSinceSurprise)) ||
      (state.bonusSpinsAwarded !== undefined && ![0, 10, 15, 20].includes(state.bonusSpinsAwarded))) {
      fail('INVALID_STATE', 'L’état de la partie est invalide.');
    }
    validateBet(state.bet);
    validateCells(state.frozenCells);
    if (!state.inBonus && state.frozenCells.length) fail('INVALID_STATE', 'Le gel de base ne persiste pas entre les tours.');
    if (state.inBonus) {
      validateBet(state.bonusBet ?? state.bet);
      if (state.freeSpins > inferredAward(state)) fail('INVALID_STATE', 'Le nombre de tours restants dépasse le bonus attribué.');
    }
  }

  function cloneState(state) {
    return { ...state, frozenCells: copyCells(state.frozenCells), bonusSpinsAwarded: inferredAward(state),
      bonusBet: state.inBonus ? (state.bonusBet ?? state.bet) : null, spinsSinceSurprise: state.spinsSinceSurprise ?? 0 };
  }

  function createState() {
    return { balance: 10000, bet: 100, inBonus: false, freeSpins: 0, bonusBet: null, bonusSpinsAwarded: 0,
      bonusWin: 0, frozenCells: [], lastWin: 0, totalSpins: 0, spinsSinceSurprise: 0 };
  }

  function randomValue(rng) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) fail('INVALID_RANDOM', 'Le hasard doit renvoyer une valeur entre 0 inclus et 1 exclu.');
    return value;
  }

  function generateGrid(rng = Math.random) {
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    return Array.from({ length: 5 }, () => {
      let hasScatter = false;
      return Array.from({ length: 3 }, () => {
        const pool = hasScatter ? SYMBOLS.filter(symbol => symbol.id !== 'scatter') : SYMBOLS;
        let roll = randomValue(rng) * pool.reduce((sum, symbol) => sum + symbol.weight, 0);
        let selected = pool[pool.length - 1];
        for (const symbol of pool) { roll -= symbol.weight; if (roll < 0) { selected = symbol; break; } }
        if (selected.id === 'scatter') hasScatter = true;
        return selected.id;
      });
    });
  }

  function evaluateGrid(grid, bet) {
    validateGrid(grid);
    validateBet(bet);
    const wins = [];
    for (const symbol of PAYING) {
      const positions = [];
      const naturalReels = [];
      let reelCount = 0, combinations = 1, pureWildWays = 1, naturalCount = 0, wildCount = 0;
      // Every path starts on reel 1 and takes one matching cell per consecutive
      // reel. Rows are unrestricted; only the longest matching prefix pays.
      for (let reel = 0; reel < grid.length; reel++) {
        const matches = [];
        let wildsOnReel = 0;
        for (let row = 0; row < grid[reel].length; row++) {
          const id = grid[reel][row];
          if (id !== symbol.id && id !== 'wild') continue;
          matches.push({ reel, row });
          if (id === 'wild') wildsOnReel++;
        }
        if (!matches.length) break;
        reelCount++;
        combinations *= matches.length;
        pureWildWays *= wildsOnReel;
        naturalCount += matches.length - wildsOnReel;
        if (matches.length > wildsOnReel) naturalReels.push(reel);
        wildCount += wildsOnReel;
        positions.push(...matches);
      }
      if (reelCount < MIN_MATCH) continue;
      // A crystal can occur in distinct winning paths. Removing all-wild paths
      // gives every paid path a natural symbol and therefore one unique group.
      const ways = combinations - pureWildWays;
      if (!ways) continue;
      // If only one reel contains a natural symbol, choosing a wild on THAT
      // reel would make the whole path wild. Those cells must not glow as wins.
      const winningPositions = naturalReels.length === 1
        ? positions.filter(({ reel, row }) => reel !== naturalReels[0] || grid[reel][row] !== 'wild')
        : positions;
      wildCount = winningPositions.filter(({ reel, row }) => grid[reel][row] === 'wild').length;
      const multiplier = symbol.pays[reelCount];
      wins.push({ symbol: symbol.id, count: reelCount, reelCount, ways, naturalCount, wildCount,
        multiplier, amount: Math.round(bet * multiplier * ways), positions: winningPositions });
    }
    return { wins, totalWin: wins.reduce((sum, win) => sum + win.amount, 0) };
  }

  function applyFrozenCells(grid, cells) {
    validateGrid(grid);
    validateCells(cells);
    const result = copyGrid(grid);
    cells.forEach(({ reel, row }) => { result[reel][row] = 'wild'; });
    return result;
  }

  function pickCells(pool, count, rng) {
    const available = copyCells(pool);
    const chosen = [];
    for (let i = 0; i < count && available.length; i++) chosen.push(available.splice(Math.floor(randomValue(rng) * available.length), 1)[0]);
    return chosen;
  }

  function startDemoBonus(state, scatterCount = 3) {
    validateState(state);
    const awarded = getBonusSpins(scatterCount);
    if (!awarded) fail('INVALID_SCATTER_COUNT', 'Le bonus nécessite au moins trois Scatters.');
    return { ...cloneState(state), inBonus: true, freeSpins: awarded, bonusBet: state.bet, bonusSpinsAwarded: awarded,
      bonusWin: 0, lastWin: 0, frozenCells: [] };
  }

  function spin(state, options = {}) {
    validateState(state);
    const { rng = Math.random, forcedGrid, forceSurprise, forceFreezeCells } = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le générateur aléatoire doit être une fonction.');
    if (forceFreezeCells !== undefined) validateCells(forceFreezeCells, 3);
    if (forceSurprise === true && forceFreezeCells?.length) fail('CONFLICTING_FORCES', 'Un tour ne peut pas forcer simultanément les deux interventions.');
    const wasBonus = state.inBonus;
    const bet = wasBonus ? (state.bonusBet ?? state.bet) : state.bet;
    if (!wasBonus && state.balance < bet) fail('INSUFFICIENT_BALANCE', 'Votre solde est insuffisant pour cette mise.');
    if (forcedGrid !== undefined) validateGrid(forcedGrid);
    let grid = forcedGrid === undefined ? generateGrid(rng) : copyGrid(forcedGrid);
    const preInterventionGrid = copyGrid(grid);
    const next = cloneState(state);
    let surpriseTriggered = false;
    let surpriseKind = null;
    let wantsFreeze = false;
    const surprisePositions = [];
    let frozenCells = wasBonus ? copyCells(next.frozenCells) : [];
    if (wasBonus) {
      grid = applyFrozenCells(grid, frozenCells);
      next.freeSpins -= 1;
      wantsFreeze = forceFreezeCells !== undefined ? forceFreezeCells.length > 0 :
        frozenCells.length < MAX_FROZEN_CELLS && randomValue(rng) < FREEZE_CHANCE;
    } else {
      next.balance -= bet;
      next.spinsSinceSurprise = Math.min(Number.MAX_SAFE_INTEGER, next.spinsSinceSurprise + 1);
      const naturalScatters = grid.flat().filter(symbol => symbol === 'scatter').length;
      if (naturalScatters < 3) {
        if (forceSurprise === true) surpriseTriggered = true;
        else if (forceFreezeCells?.length) wantsFreeze = true;
        else {
          const bonusChance = forceSurprise !== false && next.spinsSinceSurprise >= SURPRISE_COOLDOWN ? SURPRISE_CHANCE : 0;
          const freezeChance = forceFreezeCells === undefined ? BASE_FREEZE_CHANCE : 0;
          if (bonusChance || freezeChance) {
            const roll = randomValue(rng);
            surpriseTriggered = roll < bonusChance;
            wantsFreeze = !surpriseTriggered && roll < bonusChance + freezeChance;
          }
        }
        if (surpriseTriggered) {
          const availableReels = [0, 1, 2, 3, 4].filter(reel => !grid[reel].includes('scatter'));
          for (let missing = 3 - naturalScatters; missing > 0; missing--) {
            const reel = availableReels.splice(Math.floor(randomValue(rng) * availableReels.length), 1)[0];
            const row = Math.floor(randomValue(rng) * 3);
            grid[reel][row] = 'scatter';
            surprisePositions.push({ reel, row });
          }
          surpriseKind = 'bonus';
          next.spinsSinceSurprise = 0;
        }
      }
    }

    const preFreezeGrid = copyGrid(grid);
    let newFrozenCells = [];
    if (wantsFreeze) {
      const oldKeys = new Set(frozenCells.map(cellKey));
      const available = ALL_CELLS.filter(cell => !oldKeys.has(cellKey(cell)) && (wasBonus || grid[cell.reel][cell.row] !== 'scatter'));
      const capacity = wasBonus ? MAX_FROZEN_CELLS - frozenCells.length : 3;
      if (forceFreezeCells !== undefined) {
        const availableKeys = new Set(available.map(cellKey));
        newFrozenCells = copyCells(forceFreezeCells.filter(cell => availableKeys.has(cellKey(cell))).slice(0, capacity));
      } else {
        const count = Math.min(capacity, 1 + Math.floor(randomValue(rng) * 3), available.length);
        newFrozenCells = pickCells(available, count, rng);
      }
      frozenCells = [...frozenCells, ...newFrozenCells];
      grid = applyFrozenCells(grid, frozenCells);
      if (newFrozenCells.length) surpriseKind = 'freeze';
    }
    const freezeTriggered = newFrozenCells.length > 0;
    if (wasBonus) next.frozenCells = copyCells(frozenCells);
    const { wins, totalWin } = evaluateGrid(grid, bet);
    const scatterCount = grid.flat().filter(symbol => symbol === 'scatter').length;
    const awardedFreeSpins = wasBonus ? 0 : getBonusSpins(scatterCount);
    const bonusTriggered = awardedFreeSpins > 0;
    const bonusEnded = wasBonus && next.freeSpins === 0;
    next.balance += totalWin;
    next.lastWin = totalWin;
    next.totalSpins += 1;
    if (wasBonus) next.bonusWin += totalWin;
    if (bonusTriggered) {
      next.inBonus = true;
      next.freeSpins = awardedFreeSpins;
      next.bonusSpinsAwarded = awardedFreeSpins;
      next.bonusBet = bet;
      next.bonusWin = 0;
      next.frozenCells = [];
    }
    if (bonusEnded) { next.inBonus = false; next.bonusBet = null; next.frozenCells = []; }
    if (!validMoney(next.balance) || !validMoney(next.bonusWin)) fail('BALANCE_OVERFLOW', 'Le solde dépasse la limite du jeu.');
    return { state: next, grid, preInterventionGrid, preFreezeGrid, wins, totalWin, scatterCount, bet,
      awardedFreeSpins, bonusTriggered, bonusEnded, surpriseTriggered, surpriseKind, surprisePositions,
      freezeTriggered, newFrozenCells: copyCells(newFrozenCells), frozenCells: copyCells(frozenCells) };
  }

  return Object.freeze({ SYMBOLS, BETS, BONUS_AWARDS, BONUS_SPINS, MIN_MATCH, MAX_WAYS, FREEZE_CHANCE, BASE_FREEZE_CHANCE,
    SURPRISE_CHANCE, SURPRISE_COOLDOWN, MAX_FROZEN_CELLS, getBonusSpins, createState, generateGrid, evaluateGrid,
    applyFrozenCells, startDemoBonus, spin });
});
