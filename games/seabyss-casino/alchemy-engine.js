(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.AlchemyEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REELS = 5, ROWS = 5, MIN_MATCH = 8, MAX_CASCADES = 6;
  const BONUS_PICKS = 3, INGREDIENT_COUNT = 6;
  const BETS = Object.freeze([25,50,75,100,150,200,250,500,1000,2000]);
  const PAY_THRESHOLDS = Object.freeze([8,10,12,15,20]);
  const table = base => Object.freeze(Object.fromEntries(PAY_THRESHOLDS.map((count, i) => [count, Number((base * [1,2,4,8,16][i]).toFixed(4))])));
  // One award per symbol family, anywhere on the grid; no adjacency or wilds.
  // Star belongs to the bonus's final catalyst and is never rolled on the grid.
  const SYMBOLS = Object.freeze([
    { id: 'ruby', name: 'Rubis', weight: 10, pays: table(5) },
    { id: 'emerald', name: 'Émeraude', weight: 11, pays: table(4) },
    { id: 'sapphire', name: 'Saphir', weight: 12, pays: table(3.52) },
    { id: 'mushroom', name: 'Champignon', weight: 13, pays: table(3) },
    { id: 'flower', name: 'Fleur mystique', weight: 14, pays: table(2.52) },
    { id: 'moon', name: 'Lune', weight: 16, pays: table(2) },
    { id: 'bottle', name: 'Fiole', weight: 20, pays: table(1.48) },
    { id: 'cauldron', name: 'Chaudron', weight: 1.5, pays: Object.freeze({}) },
    { id: 'star', name: 'Catalyseur', weight: 0, bonusOnly: true, pays: Object.freeze({}) }
  ].map(Object.freeze));
  const INGREDIENTS = Object.freeze([
    { multiplier: .8, weight: 30 }, { multiplier: 1.6, weight: 30 },
    { multiplier: 2.4, weight: 20 }, { multiplier: 4, weight: 10 },
    { multiplier: 8, weight: 6 }, { multiplier: 16, weight: 3 }, { multiplier: 40, weight: 1 }
  ].map(Object.freeze));
  const CATALYSTS = Object.freeze([
    { multiplier: 1, weight: 86 }, { multiplier: 2, weight: 12 }, { multiplier: 3, weight: 2 }
  ].map(Object.freeze));
  const PAYING = SYMBOLS.slice(0,7);
  const GRID_SYMBOLS = SYMBOLS.filter(symbol => !symbol.bonusOnly);
  const IDS = new Set(GRID_SYMBOLS.map(symbol => symbol.id));
  const GRID_WEIGHT = GRID_SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
  const validMoney = value => Number.isSafeInteger(value) && value >= 0;
  const copyGrid = grid => grid.map(column => [...column]);
  const copyIngredient = ingredient => ({ ...ingredient });
  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function safeAdd(a,b) {
    const value = a + b;
    if (!validMoney(value)) fail('BALANCE_OVERFLOW', 'Le montant dépasse la limite du jeu.');
    return value;
  }
  function validateBet(bet) { if (!BETS.includes(bet)) fail('INVALID_BET', 'Choisissez une mise de 0,25 $ à 20 $.'); }
  function validateGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== REELS) fail('INVALID_GRID', 'La grille doit avoir cinq colonnes.');
    for (let reel = 0; reel < REELS; reel++) {
      if (!Array.isArray(grid[reel]) || grid[reel].length !== ROWS) fail('INVALID_GRID', 'Chaque colonne doit avoir cinq cases.');
      for (let row = 0; row < ROWS; row++) if (!IDS.has(grid[reel][row])) fail('INVALID_GRID', 'Un symbole de la grille est invalide.');
    }
  }
  function validMultiplier(value) { return INGREDIENTS.some(ingredient => ingredient.multiplier === value); }
  function validateIngredient(ingredient, bet) {
    if (!ingredient || !validMultiplier(ingredient.multiplier) || ingredient.amount !== Math.round(bet * ingredient.multiplier)) fail('INVALID_STATE', 'Un ingrédient sauvegardé est invalide.');
  }
  function validIndices(indices, maxLength) {
    return Array.isArray(indices) && indices.length <= maxLength && new Set(indices).size === indices.length &&
      Array.from(indices).every(index => Number.isInteger(index) && index >= 0 && index < INGREDIENT_COUNT);
  }
  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.lastWin) || !validMoney(state.totalSpins) ||
      typeof state.inBonus !== 'boolean' || state.inBonus !== (state.bonus !== null)) fail('INVALID_STATE', 'La sauvegarde de l’alchimiste est invalide.');
    validateBet(state.bet);
    if (state.bonus !== null) {
      const bonus = state.bonus;
      if (!bonus || !Array.isArray(bonus.ingredients) || bonus.ingredients.length !== INGREDIENT_COUNT ||
        !validIndices(bonus.selected, BONUS_PICKS - 1) || ![1,2,3].includes(bonus.catalyst)) fail('INVALID_STATE', 'Le chaudron sauvegardé est invalide.');
      validateBet(bonus.bet);
      for (let index = 0; index < INGREDIENT_COUNT; index++) validateIngredient(bonus.ingredients[index], bonus.bet);
      const sum = bonus.selected.reduce((total,index) => total + bonus.ingredients[index].amount, 0);
      if (sum !== bonus.sum) fail('INVALID_STATE', 'Le total du chaudron est invalide.');
    }
    if (state.lastBonus !== null) {
      const receipt = state.lastBonus;
      if (!receipt || !validIndices(receipt.selected, BONUS_PICKS) || receipt.selected.length !== BONUS_PICKS ||
        !Array.isArray(receipt.ingredients) || receipt.ingredients.length !== BONUS_PICKS || ![1,2,3].includes(receipt.catalyst)) fail('INVALID_STATE', 'Le reçu du chaudron est invalide.');
      validateBet(receipt.bet);
      for (let index = 0; index < BONUS_PICKS; index++) {
        validateIngredient(receipt.ingredients[index], receipt.bet);
        if (receipt.ingredients[index].index !== receipt.selected[index]) fail('INVALID_STATE', 'Les choix du reçu sont invalides.');
      }
      if (receipt.baseAmount !== receipt.ingredients.reduce((sum,ingredient) => sum + ingredient.amount, 0) ||
        receipt.amount !== receipt.baseAmount * receipt.catalyst) fail('INVALID_STATE', 'Le prix du reçu est invalide.');
    }
    return true;
  }
  function cloneReceipt(receipt) { return receipt ? { ...receipt, selected: [...receipt.selected], ingredients: receipt.ingredients.map(copyIngredient) } : null; }
  function cloneState(state) {
    return { ...state, bonus: state.bonus ? { ...state.bonus, ingredients: state.bonus.ingredients.map(copyIngredient), selected: [...state.bonus.selected] } : null,
      lastBonus: cloneReceipt(state.lastBonus) };
  }
  function createState(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_STATE', 'Les paramètres initiaux sont invalides.');
    const state = { balance: options.balance ?? 10000, bet: options.bet ?? 100, totalSpins: 0, lastWin: 0,
      inBonus: false, bonus: null, lastBonus: null };
    validateState(state);
    return state;
  }
  function randomValue(rng) {
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le hasard doit être une fonction.');
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) fail('INVALID_RANDOM', 'Le hasard doit renvoyer une valeur entre 0 inclus et 1 exclu.');
    return value;
  }
  function weighted(items, total, rng) {
    let roll = randomValue(rng) * total;
    for (const item of items) { roll -= item.weight; if (roll < 0) return item; }
    return items[items.length - 1];
  }
  function generateGrid(rng = Math.random) { return Array.from({ length: REELS }, () => Array.from({ length: ROWS }, () => weighted(GRID_SYMBOLS, GRID_WEIGHT, rng).id)); }
  function evaluateGrid(grid, bet, multiplier = 1) {
    validateGrid(grid); validateBet(bet);
    if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > MAX_CASCADES) fail('INVALID_MULTIPLIER', 'La réaction doit être comprise entre 1 et 6.');
    const positions = Object.fromEntries(GRID_SYMBOLS.map(symbol => [symbol.id, []]));
    for (let reel = 0; reel < REELS; reel++) for (let row = 0; row < ROWS; row++) positions[grid[reel][row]].push({ reel, row });
    const wins = []; let totalWin = 0, baseWin = 0;
    for (const symbol of PAYING) {
      const cells = positions[symbol.id], count = cells.length;
      if (count < MIN_MATCH) continue;
      const threshold = PAY_THRESHOLDS.filter(value => value <= count).at(-1), pay = symbol.pays[threshold];
      const baseAmount = Math.round(bet * pay), amount = Math.round(bet * pay * multiplier);
      wins.push({ symbol: symbol.id, count, threshold, positions: cells, amount, baseAmount, multiplier: pay, reactionMultiplier: multiplier });
      totalWin = safeAdd(totalWin, amount); baseWin = safeAdd(baseWin, baseAmount);
    }
    return { wins, totalWin, baseWin, cauldronCount: positions.cauldron.length };
  }
  function validateBonusOptions(rng, forcedIngredients, forcedCatalyst) {
    if (typeof rng !== 'function') fail('INVALID_RANDOM', 'Le hasard doit être une fonction.');
    if (forcedIngredients !== undefined && (!Array.isArray(forcedIngredients) || forcedIngredients.length !== INGREDIENT_COUNT ||
      !Array.from(forcedIngredients).every(validMultiplier))) fail('INVALID_INGREDIENTS', 'Le chaudron doit contenir six ingrédients valides.');
    if (forcedCatalyst !== undefined && ![1,2,3].includes(forcedCatalyst)) fail('INVALID_MULTIPLIER', 'Le catalyseur doit être ×1, ×2 ou ×3.');
  }
  function makeBonus(bet, rng, forcedIngredients, forcedCatalyst) {
    validateBonusOptions(rng, forcedIngredients, forcedCatalyst);
    const ingredients = Array.from({ length: INGREDIENT_COUNT }, (_, index) => {
      const multiplier = forcedIngredients === undefined ? weighted(INGREDIENTS, 100, rng).multiplier : forcedIngredients[index];
      return { multiplier, amount: Math.round(bet * multiplier) };
    });
    return { bet, ingredients, selected: [], sum: 0, catalyst: forcedCatalyst ?? weighted(CATALYSTS, 100, rng).multiplier };
  }
  function startDemoBonus(state, options = {}) {
    validateState(state);
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Les paramètres sont invalides.');
    const bet = state.bonus ? state.bonus.bet : state.bet, next = cloneState(state);
    next.bet = bet; next.inBonus = true; next.lastBonus = null; next.lastWin = 0;
    next.bonus = makeBonus(bet, options.rng ?? Math.random, options.forcedIngredients, options.forcedCatalyst);
    return next;
  }
  function pickIngredient(state, index) {
    validateState(state);
    if (!state.inBonus) fail('NO_ACTIVE_BONUS', 'Le chaudron est déjà terminé ou n’a pas été gagné.');
    if (!Number.isInteger(index) || index < 0 || index >= INGREDIENT_COUNT) fail('INVALID_INGREDIENT', 'Choisissez un des six ingrédients.');
    if (state.bonus.selected.includes(index)) fail('ALREADY_PICKED', 'Cet ingrédient a déjà été versé.');
    const next = cloneState(state), bonus = next.bonus;
    const ingredient = { index, ...bonus.ingredients[index] };
    bonus.selected.push(index); bonus.sum = safeAdd(bonus.sum, ingredient.amount); next.bet = bonus.bet;
    const picksLeft = BONUS_PICKS - bonus.selected.length, baseAward = bonus.sum;
    const bonusEnded = picksLeft === 0, catalyst = bonusEnded ? bonus.catalyst : null;
    let totalWin = 0, receipt = null;
    if (bonusEnded) {
      totalWin = baseAward * catalyst;
      if (!validMoney(totalWin)) fail('BALANCE_OVERFLOW', 'Le prix dépasse la limite du jeu.');
      receipt = { bet: bonus.bet, selected: [...bonus.selected], ingredients: bonus.selected.map(selected => ({ index: selected, ...bonus.ingredients[selected] })),
        baseAmount: baseAward, catalyst, amount: totalWin };
      next.balance = safeAdd(next.balance, totalWin); next.lastWin = totalWin;
      next.inBonus = false; next.bonus = null; next.lastBonus = cloneReceipt(receipt);
    }
    return { state: next, ingredient, picksLeft, baseAward, catalyst, totalWin, prize: totalWin, bonusEnded, receipt: cloneReceipt(receipt) };
  }
  function refill(grid, removedPositions, rng, forced) {
    if (forced !== undefined && (!Array.isArray(forced) || forced.length !== removedPositions.length || !Array.from(forced).every(id => IDS.has(id)))) {
      fail('INVALID_REFILL', 'Le remplissage doit fournir un symbole valide pour chaque case gagnante.');
    }
    const removed = new Set(removedPositions.map(position => position.reel * ROWS + position.row));
    let cursor = 0;
    return grid.map((column,reel) => {
      const retained = column.filter((_,row) => !removed.has(reel * ROWS + row));
      const incoming = Array.from({ length: ROWS - retained.length }, () => forced === undefined ? weighted(GRID_SYMBOLS, GRID_WEIGHT, rng).id : forced[cursor++]);
      return [...incoming, ...retained];
    });
  }
  function spin(state, options = {}) {
    validateState(state);
    if (state.inBonus) fail('BONUS_PENDING', 'Terminez les trois choix du chaudron avant de lancer un tour.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Les paramètres du tour sont invalides.');
    const { rng = Math.random, forcedGrid, forcedRefills, forcedIngredients, forcedCatalyst } = options;
    validateBonusOptions(rng, forcedIngredients, forcedCatalyst);
    if (forcedRefills !== undefined && (!Array.isArray(forcedRefills) || forcedRefills.length > MAX_CASCADES - 1 ||
      !Array.from(forcedRefills).every(list => Array.isArray(list) && list.length > 0 && list.length <= REELS * ROWS && Array.from(list).every(id => IDS.has(id))))) fail('INVALID_REFILL', 'La liste de remplissages est invalide.');
    if (state.balance < state.bet) fail('INSUFFICIENT_FUNDS', 'Le solde ne permet pas cette mise.');
    let grid = forcedGrid === undefined ? generateGrid(rng) : (validateGrid(forcedGrid), copyGrid(forcedGrid));
    const initialGrid = copyGrid(grid), next = cloneState(state), bet = state.bet, cascades = [], wins = [];
    next.balance -= bet; next.totalSpins = safeAdd(next.totalSpins, 1); next.lastWin = 0;
    let totalWin = 0, bonusTriggered = false, cascadeLimitReached = false, refillsUsed = 0;
    for (let multiplier = 1; multiplier <= MAX_CASCADES; multiplier++) {
      const evaluated = evaluateGrid(grid, bet, multiplier);
      const removedPositions = evaluated.wins.flatMap(win => win.positions.map(position => ({ ...position })));
      const frame = { grid: copyGrid(grid), wins: evaluated.wins, multiplier, baseWin: evaluated.baseWin,
        totalWin: evaluated.totalWin, cauldronCount: evaluated.cauldronCount, removedPositions, nextGrid: null };
      cascades.push(frame); wins.push(...evaluated.wins.map(win => ({ ...win, cascade: multiplier - 1, positions: win.positions.map(position => ({ ...position })) })));
      totalWin = safeAdd(totalWin, evaluated.totalWin);
      if (evaluated.cauldronCount >= 3) {
        bonusTriggered = true; next.inBonus = true; next.lastBonus = null;
        next.bonus = makeBonus(bet, rng, forcedIngredients, forcedCatalyst);
        break;
      }
      if (!removedPositions.length) break;
      if (multiplier === MAX_CASCADES) { cascadeLimitReached = true; break; }
      grid = refill(grid, removedPositions, rng, forcedRefills?.[refillsUsed++]);
      frame.nextGrid = copyGrid(grid);
    }
    next.balance = safeAdd(next.balance, totalWin); next.lastWin = totalWin;
    return { state: next, grid: copyGrid(grid), initialGrid, cascades, wins, totalWin, bet, bonusTriggered,
      bonusEnded: false, cascadeLimitReached };
  }
  return Object.freeze({ REELS, ROWS, MIN_MATCH, MAX_CASCADES, BONUS_PICKS, INGREDIENT_COUNT,
    BETS, PAY_THRESHOLDS, SYMBOLS, INGREDIENTS, CATALYSTS, createState, validateState, validateGrid,
    generateGrid, evaluateGrid, startDemoBonus, pickIngredient, spin });
});
