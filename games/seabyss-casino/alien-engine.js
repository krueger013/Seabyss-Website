(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.AlienEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REELS = 5, ROWS = 3, BASE_UFOS = 2, BONUS_UFOS = 4, MAX_LOCKED_REELS = 5;
  const BETS = Object.freeze([25,50,75,100,150,200,250,500,1000,2000]);
  // A line receives total stake / 20. Multiples of four keep every offered
  // quarter-dollar stake exact at cent precision, including expanded reels.
  const SYMBOLS = Object.freeze([
    { id:'alien', name:'Petit homme vert', weight:9, pays:{3:20,4:64,5:200} },
    { id:'planet', name:'Planète annelée', weight:11, pays:{3:16,4:48,5:160} },
    { id:'rocket', name:'Fusée', weight:13, pays:{3:12,4:36,5:120} },
    { id:'moon', name:'Lune cosmique', weight:16, pays:{3:8,4:28,5:88} },
    { id:'corn', name:'Maïs galactique', weight:20, pays:{3:8,4:20,5:64} },
    { id:'tractor', name:'Tracteur', weight:23, pays:{3:4,4:16,5:48} },
    { id:'cow', name:'Vache cosmique', weight:2.2, pays:{3:28,4:80,5:240} },
    { id:'wild', name:'Rayon joker', weight:1.65, pays:{3:32,4:100,5:280} },
    { id:'scatter', name:'Badge soucoupe', weight:2.801, pays:{} }
  ].map(symbol => Object.freeze({...symbol,pays:Object.freeze(symbol.pays)})));
  const PAYLINES = Object.freeze([
    [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2], [0,1,2,1,0], [2,1,0,1,2],
    [0,0,1,2,2], [2,2,1,0,0], [1,0,0,0,1], [1,2,2,2,1], [0,1,1,1,0],
    [2,1,1,1,2], [1,0,1,2,1], [1,2,1,0,1], [0,1,0,1,0], [2,1,2,1,2],
    [1,1,0,1,1], [1,1,2,1,1], [0,0,2,0,0], [2,2,0,2,2], [0,2,2,2,0]
  ].map(Object.freeze));
  const BONUS_SPINS = 10, BONUS_AWARDS = Object.freeze({3:10,4:15,5:20});
  const IDS = new Set(SYMBOLS.map(symbol => symbol.id));
  const PAYING = SYMBOLS.filter(symbol => symbol.id !== 'scatter');
  // Fixed mode-specific draws and a single shared paytable. During the bonus,
  // a solitary cow gains one companion on the same reel before locks/UFOs.
  // Neither distribution depends on balance, earlier results, or held reels.
  const BASE_WEIGHTS = Object.freeze(Object.fromEntries(SYMBOLS.map(symbol => [symbol.id,symbol.weight])));
  const BONUS_WEIGHTS = Object.freeze({...BASE_WEIGHTS,cow:1.2,wild:3,scatter:4});
  const BONUS_COW_GROUP = Object.freeze({minimum:2});
  function poolsFor(weights) {
    const symbols = SYMBOLS.map(symbol => Object.freeze({id:symbol.id,weight:weights[symbol.id]}));
    const withoutScatter = symbols.filter(symbol => symbol.id !== 'scatter');
    return Object.freeze({symbols:Object.freeze(symbols),withoutScatter:Object.freeze(withoutScatter),
      weight:symbols.reduce((sum,symbol) => sum+symbol.weight,0),
      withoutScatterWeight:withoutScatter.reduce((sum,symbol) => sum+symbol.weight,0)});
  }
  const GRID_POOLS = Object.freeze({base:poolsFor(BASE_WEIGHTS),bonus:poolsFor(BONUS_WEIGHTS)});
  const copyGrid = grid => grid.map(column => [...column]);
  const validMoney = value => Number.isSafeInteger(value) && value >= 0;
  function fail(code,message) {const error = new Error(message);error.code = code;throw error;}
  function safeAdd(a,b) {
    const value = a + b;
    if (!validMoney(value)) fail('BALANCE_OVERFLOW','Le montant dépasse la limite du jeu.');
    return value;
  }
  function validateBet(bet) {if (!BETS.includes(bet)) fail('INVALID_BET','Choisissez une mise de 0,25 $ à 20 $.');}
  function validateReels(reels) {
    if (!Array.isArray(reels) || reels.length > REELS || new Set(reels).size !== reels.length ||
      !Array.from(reels).every(reel => Number.isInteger(reel) && reel >= 0 && reel < REELS)) fail('INVALID_REELS','Les rouleaux doivent être distincts et compris entre 1 et 5.');
  }
  function validateGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== REELS) fail('INVALID_GRID','La grille doit avoir cinq rouleaux.');
    for (let reel=0;reel<REELS;reel++) {
      if (!Array.isArray(grid[reel]) || grid[reel].length !== ROWS) fail('INVALID_GRID','Chaque rouleau doit avoir trois cases.');
      for (let row=0;row<ROWS;row++) if (!IDS.has(grid[reel][row])) fail('INVALID_GRID','Un symbole de la grille est invalide.');
    }
  }
  function getBonusSpins(count) {return Number.isInteger(count) && count >= 3 ? BONUS_AWARDS[Math.min(count,5)] : 0;}
  function validateState(state) {
    if (!state || !validMoney(state.balance) || !validMoney(state.lastWin) || !validMoney(state.bonusWin) || !validMoney(state.totalSpins) ||
      typeof state.inBonus !== 'boolean' || !Number.isInteger(state.freeSpins) || state.freeSpins < 0 || state.freeSpins > 20 ||
      state.inBonus !== (state.freeSpins > 0) || ![0,10,15,20].includes(state.bonusSpinsAwarded)) fail('INVALID_STATE','La sauvegarde cosmique est invalide.');
    validateBet(state.bet); validateReels(state.lockedReels); validateReels(state.ufoReels);
    // The displayed UFO formation belongs to the preceding resolution. Thus
    // two is valid at bonus entry and four is valid just after the bonus ends.
    if (![BASE_UFOS,BONUS_UFOS].includes(state.ufoReels.length)) fail('INVALID_STATE','La formation des soucoupes est invalide.');
    if (state.inBonus) {
      validateBet(state.bonusBet);
      if (state.freeSpins > state.bonusSpinsAwarded) fail('INVALID_STATE','Les tours restants dépassent le bonus attribué.');
    } else if (state.bonusBet !== null || state.lockedReels.length) fail('INVALID_STATE','Les rouleaux persistants sont réservés au bonus.');
    return true;
  }
  function createState(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_STATE','Les paramètres initiaux sont invalides.');
    const state = {balance:options.balance ?? 10000,bet:options.bet ?? 100,bonusBet:null,
      inBonus:false,freeSpins:0,bonusSpinsAwarded:0,bonusWin:0,lockedReels:[],ufoReels:[0,4],totalSpins:0,lastWin:0};
    validateState(state);return state;
  }
  function randomValue(rng) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) fail('INVALID_RANDOM','Le hasard doit renvoyer une valeur entre 0 inclus et 1 exclu.');
    return value;
  }
  function generateGrid(rng = Math.random,mode = 'base') {
    if (typeof rng !== 'function') fail('INVALID_RANDOM','Le hasard doit être une fonction.');
    if (!['base','bonus'].includes(mode)) fail('INVALID_MODE','Le tirage doit être normal ou en bonus.');
    const configuration = GRID_POOLS[mode];
    return Array.from({length:REELS},() => {
      let hasScatter = false;
      const column = Array.from({length:ROWS},() => {
        const pool = hasScatter ? configuration.withoutScatter : configuration.symbols;
        let roll = randomValue(rng) * (hasScatter ? configuration.withoutScatterWeight : configuration.weight), selected = pool[pool.length-1];
        for (const symbol of pool) {roll -= symbol.weight;if (roll < 0) {selected = symbol;break;}}
        if (selected.id === 'scatter') hasScatter = true;
        return selected.id;
      });
      if (mode === 'bonus' && column.filter(id => id === 'cow').length === 1) {
        const available = column.flatMap((id,row) => id === 'cow' ? [] : [row]);
        column[available[Math.floor(randomValue(rng)*available.length)]] = 'cow';
      }
      return column;
    });
  }
  function chooseUfoReels(count,rng = Math.random) {
    if (![BASE_UFOS,BONUS_UFOS].includes(count)) fail('INVALID_UFO_COUNT','Deux soucoupes patrouillent, ou quatre pendant le bonus.');
    if (typeof rng !== 'function') fail('INVALID_RANDOM','Le hasard doit être une fonction.');
    const available = [0,1,2,3,4], chosen = [];
    for (let ufo=0;ufo<count;ufo++) chosen.push(available.splice(Math.floor(randomValue(rng)*available.length),1)[0]);
    return chosen;
  }
  function evaluateGrid(grid,bet) {
    validateGrid(grid);validateBet(bet);
    const wins = [];
    PAYLINES.forEach((line,index) => {
      const sequence = line.map((row,reel) => grid[reel][row]);let best = null;
      for (const symbol of PAYING) {
        let count = 0;
        for (const id of sequence) {if (id === symbol.id || (id === 'wild' && symbol.id !== 'wild')) count++;else break;}
        if (count < 3) continue;
        const multiplier = symbol.pays[count],amount = Math.round(bet*multiplier/PAYLINES.length);
        if (!best || amount > best.amount || (amount === best.amount && count > best.count)) best = {
          line:index+1,index,symbol:symbol.id,count,reelCount:count,ways:1,multiplier,amount,
          positions:line.slice(0,count).map((row,reel) => ({reel,row}))};
      }
      if (best) wins.push(best);
    });
    return {wins,totalWin:wins.reduce((sum,win) => safeAdd(sum,win.amount),0)};
  }
  function startDemoBonus(state,scatterCount = 3) {
    validateState(state);const award = getBonusSpins(scatterCount);
    if (!award) fail('INVALID_SCATTER_COUNT','Un bonus nécessite au moins trois Scatters.');
    const bet = state.inBonus ? state.bonusBet : state.bet;
    return {...state,bet,bonusBet:bet,inBonus:true,freeSpins:award,bonusSpinsAwarded:award,
      bonusWin:0,lockedReels:[],ufoReels:[0,1,3,4],lastWin:0};
  }
  const copyCaptures = captures => captures.map(capture => ({...capture,positions:capture.positions.map(position => ({...position}))}));
  function spin(state,options = {}) {
    validateState(state);
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS','Les paramètres du tour sont invalides.');
    const {rng = Math.random,forcedGrid,forcedUfoReels} = options;
    if (typeof rng !== 'function') fail('INVALID_RANDOM','Le hasard doit être une fonction.');
    const wasBonus = state.inBonus,bet = wasBonus ? state.bonusBet : state.bet,ufoCount = wasBonus ? BONUS_UFOS : BASE_UFOS;
    if (forcedUfoReels !== undefined) {
      validateReels(forcedUfoReels);
      if (forcedUfoReels.length !== ufoCount) fail('INVALID_UFO_COUNT','Le nombre de soucoupes ne correspond pas au mode actif.');
    }
    if (!wasBonus && state.balance < bet) fail('INSUFFICIENT_BALANCE','Votre solde est insuffisant pour cette mise.');
    if (forcedGrid !== undefined) validateGrid(forcedGrid);
    const grid = forcedGrid === undefined ? generateGrid(rng,wasBonus ? 'bonus' : 'base') : copyGrid(forcedGrid);
    for (const reel of state.lockedReels) grid[reel].fill('wild');
    const baseGrid = copyGrid(grid),ufoReels = forcedUfoReels === undefined ? chooseUfoReels(ufoCount,rng) : [...forcedUfoReels];
    const next = {...state,bet,lockedReels:[...state.lockedReels],ufoReels:[...ufoReels]},captures = [];
    if (wasBonus) next.freeSpins--;else next.balance -= bet;
    ufoReels.forEach((reel,ufoIndex) => {
      if (state.lockedReels.includes(reel)) return;
      const positions = baseGrid[reel].flatMap((id,row) => id === 'cow' ? [{reel,row}] : []);
      if (!positions.length) return;
      captures.push({ufoIndex,reel,positions});grid[reel].fill('wild');
      if (wasBonus) next.lockedReels.push(reel);
    });
    next.lockedReels.sort((a,b) => a-b);
    const capturedReels = captures.map(capture => capture.reel),newLocks = wasBonus ? [...capturedReels] : [];
    const visibleLocks = [...new Set([...state.lockedReels,...capturedReels])].sort((a,b) => a-b);
    const {wins,totalWin} = evaluateGrid(grid,bet),scatterCount = grid.flat().filter(id => id === 'scatter').length;
    const awardedFreeSpins = wasBonus ? 0 : getBonusSpins(scatterCount),bonusTriggered = awardedFreeSpins > 0;
    const bonusEnded = wasBonus && next.freeSpins === 0;
    next.balance = safeAdd(next.balance,totalWin);next.lastWin = totalWin;next.totalSpins = safeAdd(next.totalSpins,1);
    if (wasBonus) next.bonusWin = safeAdd(next.bonusWin,totalWin);
    if (bonusTriggered) {next.inBonus = true;next.freeSpins = awardedFreeSpins;next.bonusSpinsAwarded = awardedFreeSpins;next.bonusBet = bet;next.bonusWin = 0;next.lockedReels = [];}
    if (bonusEnded) {next.inBonus = false;next.bonusBet = null;next.lockedReels = [];}
    return {state:next,grid,baseGrid,wins,totalWin,bet,scatterCount,bonusTriggered,bonusEnded,awardedFreeSpins,
      ufoReels,captures:copyCaptures(captures),capturedReels:[...capturedReels],
      capturedCows:captures.flatMap(capture => capture.positions.map(position => ({...position}))),
      newLocks,lockedReels:visibleLocks,feature:captures.length ? {type:'abduction',reels:[...capturedReels],captures:copyCaptures(captures)} : null,multiplier:1};
  }
  return Object.freeze({REELS,ROWS,BASE_UFOS,BONUS_UFOS,MAX_LOCKED_REELS,BETS,SYMBOLS,PAYLINES,BONUS_SPINS,BONUS_AWARDS,BASE_WEIGHTS,BONUS_WEIGHTS,BONUS_COW_GROUP,
    getBonusSpins,createState,validateState,validateGrid,generateGrid,chooseUfoReels,evaluateGrid,startDemoBonus,spin});
});
