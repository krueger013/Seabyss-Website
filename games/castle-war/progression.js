(function (root, factory) {
  'use strict';
  const api = factory();
  if (root) root.CastleProgression = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STARTER_IDS = Object.freeze(['sentinel', 'archer', 'golem', 'swarm', 'cannon', 'mortar', 'heal', 'lightning', 'runner']);
  const DEFAULT_DECK = Object.freeze(['sentinel', 'archer', 'golem', 'swarm', 'cannon', 'heal', 'lightning', 'runner']);
  const AVATARS = Object.freeze(['crown', 'kraken', 'flame', 'frost', 'moon', 'coral']);
  const MAX_DECK_SIZE = 8, MAX_LEVEL = 50;
  const UNLOCKS = Object.freeze([
    { id: 'embermage', price: 100 },
    { id: 'frostwarden', price: 140 },
    { id: 'tidecaller', price: 180 },
    { id: 'fireball', price: 120 },
    { id: 'blizzard', price: 160 },
    { id: 'tidalwave', price: 180 },
    { id: 'aegis', price: 220 },
    { id: 'ashknight', price: 180 },
    { id: 'cinderimp', price: 120 },
    { id: 'magmabrute', price: 280 },
    { id: 'phoenix', price: 340 },
    { id: 'glacierguard', price: 200 },
    { id: 'frostarcher', price: 160 },
    { id: 'snowwolves', price: 180 },
    { id: 'icecolossus', price: 360 },
    { id: 'reefknight', price: 180 },
    { id: 'pearlsage', price: 240 },
    { id: 'tideserpent', price: 280 },
    { id: 'deepkraken', price: 380 },
    { id: 'duskassassin', price: 220 },
    { id: 'ironclad', price: 240 },
    { id: 'bonelegion', price: 160 },
    { id: 'stormlancer', price: 260 },
    { id: 'infernotower', price: 240 },
    { id: 'icetower', price: 220 },
    { id: 'tidetotem', price: 240 },
    { id: 'ballista', price: 200 },
    { id: 'stormspire', price: 300 },
    { id: 'meteor', price: 320 },
    { id: 'iceprison', price: 260 },
    { id: 'rejuvenation', price: 220 },
    { id: 'rally', price: 180 }
  ].map(Object.freeze));
  const ALL_IDS = new Set([...STARTER_IDS, ...UNLOCKS.map(item => item.id)]);
  const MAX_GOLD = 1000000000;
  const validCount = n => Number.isSafeInteger(n) && n >= 0;
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,159}$/.test(id);
  const validDeliveryId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,239}$/.test(id);
  const threshold = level => 100 * (level - 1) + 25 * (level - 1) * (level - 2);
  const MAX_XP = threshold(MAX_LEVEL);
  const safeAdd = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
  const failure = message => ({ ok: false, gold: 0, xp: 0, newCards: [], firstVictory: false, message });

  function cleanName(value) {
    // Names remain plain text. The UI must use textContent or escape HTML when
    // inserting them in a template; printable punctuation is not executable.
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(value)) return null;
    const name = value.normalize('NFC').trim().replace(/\s+/gu, ' '), length = [...name].length;
    return length >= 2 && length <= 20 ? name : null;
  }

  function levelInfo(value) {
    const profile = value && typeof value === 'object' ? value : null;
    const raw = profile ? profile.xp : value;
    const totalXp = validCount(raw) ? Math.min(raw, MAX_XP) : 0;
    let level = 1;
    while (level < MAX_LEVEL && totalXp >= threshold(level + 1)) level++;
    const xpIntoLevel = level === MAX_LEVEL ? 0 : totalXp - threshold(level);
    const xpForNext = level === MAX_LEVEL ? 0 : threshold(level + 1) - threshold(level);
    let nextReward = null;
    if (profile && level < MAX_LEVEL && Array.isArray(profile.unlocked)) {
      const cardId = UNLOCKS.find(item => !profile.unlocked.includes(item.id))?.id || null;
      nextReward = { level: level + 1, cardId, gold: cardId ? 0 : 100 };
    }
    return { level, totalXp, xpIntoLevel, xpForNext, progress: xpForNext ? xpIntoLevel / xpForNext : 1, nextReward };
  }

  function createProfile() {
    return {
      version: 2, name: 'Commander', avatar: 'crown', xp: 0, deck: [...DEFAULT_DECK],
      gold: 0, unlocked: [...STARTER_IDS], claimedBattles: [], claimedDeliveries: [],
      firstVictory: false, wins: 0, losses: 0, totalGoldEarned: 0, totalKills: 0, totalBattles: 0, battleHistory: []
    };
  }

  function restoreProfile(raw) {
    try {
      const saved = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
          (saved.version !== undefined && ![0, 1, 2].includes(saved.version))) return null;
      for (const field of ['gold', 'wins', 'losses', 'totalGoldEarned', 'xp', 'totalKills', 'totalBattles']) {
        if (saved[field] !== undefined && !validCount(saved[field])) return null;
      }
      if (saved.unlocked !== undefined && !Array.isArray(saved.unlocked)) return null;
      if (saved.claimedBattles !== undefined && !Array.isArray(saved.claimedBattles)) return null;
      if (saved.claimedDeliveries !== undefined && !Array.isArray(saved.claimedDeliveries)) return null;
      if (saved.firstVictory !== undefined && typeof saved.firstVictory !== 'boolean') return null;
      const profile = createProfile();
      profile.gold = Math.min(saved.gold || 0, MAX_GOLD);
      profile.unlocked = [...new Set([...STARTER_IDS, ...(saved.unlocked || []).filter(id => ALL_IDS.has(id))])];
      // Keep the complete claim ledger. Evicting older IDs would let an old
      // terminal save award its gold a second time after enough future battles.
      profile.claimedBattles = [...new Set((saved.claimedBattles || []).filter(validId))];
      profile.claimedDeliveries = [...new Set((saved.claimedDeliveries || []).filter(validDeliveryId))];
      profile.wins = saved.wins || 0;
      profile.losses = saved.losses || 0;
      profile.firstVictory = saved.firstVictory === true || profile.wins > 0;
      profile.totalGoldEarned = Math.max(profile.gold, saved.totalGoldEarned || 0);
      profile.name = cleanName(saved.name) || 'Commander';
      profile.avatar = AVATARS.includes(saved.avatar) ? saved.avatar : 'crown';
      // Prior victories and defeats give a conservative XP baseline, without
      // retroactively unlocking cards. Only newly crossed levels grant rewards.
      profile.xp = Math.min(saved.xp ?? (profile.wins * 100 + profile.losses * 25), MAX_XP);
      profile.deck = Array.isArray(saved.deck)
        ? [...new Set(saved.deck.filter(id => profile.unlocked.includes(id)))].slice(0, MAX_DECK_SIZE)
        : [...DEFAULT_DECK];
      profile.totalKills = saved.totalKills || 0;
      profile.totalBattles = Math.max(saved.totalBattles || 0, safeAdd(profile.wins, profile.losses));
      profile.battleHistory = (Array.isArray(saved.battleHistory) ? saved.battleHistory : [])
        .filter(validHistory).filter((entry, index, entries) => entries.findIndex(item => item.battleId === entry.battleId) === index)
        .slice(-10).map(entry => ({ battleId: entry.battleId, outcome: entry.outcome, mapId: entry.mapId,
          mode: entry.mode, difficulty: entry.difficulty, elapsed: entry.elapsed, gold: entry.gold, xp: entry.xp }));
      // History is short, but it can still protect a known receipt if an
      // imported profile omitted its older full ledger.
      profile.claimedBattles = [...new Set([...profile.claimedBattles, ...profile.battleHistory.map(entry => entry.battleId)])];
      return profile;
    } catch (_) { return null; }
  }

  function validProfile(profile) {
    return profile && profile.version === 2 && typeof profile.name === 'string' && cleanName(profile.name) === profile.name && AVATARS.includes(profile.avatar) &&
      validCount(profile.xp) && profile.xp <= MAX_XP && validCount(profile.gold) && profile.gold <= MAX_GOLD &&
      Array.isArray(profile.unlocked) && profile.unlocked.every(id => ALL_IDS.has(id)) && STARTER_IDS.every(id => profile.unlocked.includes(id)) &&
      Array.isArray(profile.deck) && profile.deck.length <= MAX_DECK_SIZE && new Set(profile.deck).size === profile.deck.length && profile.deck.every(id => profile.unlocked.includes(id)) &&
      Array.isArray(profile.claimedBattles) && profile.claimedBattles.every(validId) &&
      Array.isArray(profile.claimedDeliveries) && profile.claimedDeliveries.every(validDeliveryId) &&
      typeof profile.firstVictory === 'boolean' && validCount(profile.wins) && validCount(profile.losses) && validCount(profile.totalGoldEarned) &&
      validCount(profile.totalKills) && validCount(profile.totalBattles) && profile.totalBattles >= safeAdd(profile.wins, profile.losses) &&
      Array.isArray(profile.battleHistory) && profile.battleHistory.length <= 10 && profile.battleHistory.every(validHistory);
  }

  function validHistory(entry) {
    return entry && validId(entry.battleId) && ['won', 'lost'].includes(entry.outcome) &&
      ['abyss', 'ember', 'frost'].includes(entry.mapId) && [2, 4].includes(entry.mode) &&
      ['easy', 'normal', 'hard'].includes(entry.difficulty) && Number.isFinite(entry.elapsed) && entry.elapsed >= 0 &&
      validCount(entry.gold) && entry.gold <= MAX_GOLD && validCount(entry.xp) && entry.xp <= MAX_XP;
  }

  function setDeck(profile, ids) {
    if (!validProfile(profile)) return { ok: false, message: 'Your collection could not be loaded.' };
    if (!Array.isArray(ids) || ids.length > MAX_DECK_SIZE || new Set(ids).size !== ids.length || ids.some(id => !ALL_IDS.has(id))) {
      return { ok: false, message: 'Choose up to eight different cards for your deck.' };
    }
    if (ids.some(id => !profile.unlocked.includes(id))) return { ok: false, message: 'Unlock each card before adding it to your deck.' };
    profile.deck = [...ids];
    return { ok: true, deck: [...profile.deck], message: ids.length ? 'Deck saved. Your next battle will use these cards.' : 'Deck cleared. Add at least one card before starting a battle.' };
  }

  function updateIdentity(profile, changes) {
    if (!validProfile(profile)) return { ok: false, message: 'Your commander could not be loaded.' };
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { ok: false, message: 'Choose a commander name and crest.' };
    const name = Object.prototype.hasOwnProperty.call(changes, 'name') ? cleanName(changes.name) : profile.name;
    const avatar = Object.prototype.hasOwnProperty.call(changes, 'avatar') ? changes.avatar : profile.avatar;
    if (!name) return { ok: false, message: 'Use a name with 2–20 visible characters and no control characters.' };
    if (!AVATARS.includes(avatar)) return { ok: false, message: 'Choose one of the six commander crests.' };
    profile.name = name; profile.avatar = avatar;
    return { ok: true, name, avatar, message: 'Commander profile saved.' };
  }

  function purchase(profile, id) {
    if (!validProfile(profile)) return failure('Your collection could not be loaded.');
    const offer = UNLOCKS.find(item => item.id === id);
    if (!offer) return failure('This card is not available in the shop.');
    if (profile.unlocked.includes(id)) return failure('You already own this card.');
    if (profile.gold < offer.price) return failure(`You need ${offer.price - profile.gold} more gold to unlock this card.`);
    profile.gold -= offer.price;
    profile.unlocked.push(id);
    return { ok: true, gold: -offer.price, spent: offer.price, newCards: [id], firstVictory: false, message: 'Card unlocked! Add it to your deck before the next battle.' };
  }

  function claimDeliveries(profile, state) {
    const empty = message => ({ ok: false, gold: 0, count: 0, ids: [], message });
    if (!validProfile(profile)) return empty('Your collection could not be loaded.');
    if (!state || !validId(state.battleId) || !['playing', 'won', 'lost'].includes(state.status) ||
        !Number.isFinite(state.elapsed) || state.elapsed < 0 || !Array.isArray(state.deliveries)) return empty('No completed deliveries are available.');
    const claimed = new Set(profile.claimedDeliveries), ids = [], prefix = state.battleId + ':relic-';
    for (const receipt of state.deliveries) {
      // Receipts come from a living runner reaching its living home castle.
      // Picking up a relic, carrying it or dropping it never creates a receipt.
      if (!receipt || receipt.team !== 0 || receipt.kind !== 'gold' || receipt.gold !== 40 || receipt.delivered !== true ||
          receipt.battleId !== state.battleId || !validDeliveryId(receipt.id) || !receipt.id.startsWith(prefix) ||
          !Number.isFinite(receipt.deliveredAt) || receipt.deliveredAt < 0 || receipt.deliveredAt > state.elapsed + 0.000001) continue;
      const sequence = receipt.id.slice(prefix.length);
      if (!/^[1-9]\d*$/.test(sequence) || !Number.isSafeInteger(Number(sequence)) || claimed.has(receipt.id)) continue;
      ids.push(receipt.id); claimed.add(receipt.id);
    }
    if (!ids.length) return empty('No new gold deliveries to claim.');
    const gold = Math.min(ids.length * 40, MAX_GOLD - profile.gold);
    // The receipt list is not consumed. Persisting the profile's full ledger
    // makes a later replay of the same in-progress battle safe after a reload.
    profile.claimedDeliveries.push(...ids);
    profile.gold += gold;
    profile.totalGoldEarned = Math.min(Number.MAX_SAFE_INTEGER, profile.totalGoldEarned + gold);
    return { ok: true, gold, count: ids.length, ids, message: `${ids.length === 1 ? 'Relic delivered' : 'Relics delivered'}! +${gold} gold.` };
  }

  function terminalBattle(state) {
    if (!state || !validId(state.battleId) || !['won', 'lost'].includes(state.status) || ![2, 4].includes(state.mode) ||
        !['easy', 'normal', 'hard'].includes(state.difficulty) || !Number.isFinite(state.elapsed) || state.elapsed < 0 ||
        !state.stats || !['unitsSummoned', 'kills', 'castlesDestroyed'].every(key => validCount(state.stats[key])) ||
        !Array.isArray(state.castles) || state.castles.length !== state.mode) return false;
    for (let i = 0; i < state.mode; i++) {
      const castle = state.castles[i];
      if (!castle || castle.team !== i || !Number.isFinite(castle.hp) || castle.hp < 0 ||
          !Number.isFinite(castle.maxHp) || castle.maxHp <= 0 || castle.hp > castle.maxHp || castle.alive !== (castle.hp > 0)) return false;
    }
    return state.status === 'won'
      ? state.castles[0].alive && state.castles.slice(1).every(castle => !castle.alive)
      : !state.castles[0].alive;
  }

  function rewardBattle(profile, state) {
    if (!validProfile(profile)) return failure('Your collection could not be loaded.');
    if (!terminalBattle(state)) return failure('Finish a battle to earn rewards.');
    if (profile.claimedBattles.includes(state.battleId)) return failure('This battle’s rewards have already been claimed.');

    const won = state.status === 'won';
    const eligible = won || (state.elapsed >= 20 && state.stats.unitsSummoned >= 1);
    const firstVictory = won && !profile.firstVictory;
    const destroyed = Math.min(state.stats.castlesDestroyed, state.mode - 1, state.castles.slice(1).filter(castle => !castle.alive).length);
    const breakdown = {
      base: eligible ? (won ? 100 : 20) : 0,
      kills: eligible ? Math.min(state.stats.kills * 2, 50) : 0,
      castles: eligible ? destroyed * 20 : 0,
      conquest: won && state.mode === 4 ? 40 : 0,
      difficulty: won ? ({ easy: 0, normal: 15, hard: 30 }[state.difficulty]) : 0,
      collectionBonus: 0, levelBonus: 0
    };
    const xpBreakdown = {
      base: eligible ? (won ? 100 : 25) : 0,
      kills: eligible ? Math.min(state.stats.kills * 2, won ? 50 : 25) : 0,
      conquest: won && state.mode === 4 ? 40 : 0,
      difficulty: won ? ({ easy: 0, normal: 15, hard: 30 }[state.difficulty]) : 0
    };
    const levelBefore = levelInfo(profile).level;
    const calculatedXp = Object.values(xpBreakdown).reduce((total, value) => total + value, 0);
    const xp = Math.min(calculatedXp, MAX_XP - profile.xp);
    const levelAfter = levelInfo(profile.xp + xp).level;
    const newCards = [], levelRewards = [], owned = new Set(profile.unlocked);
    const grantCard = id => { owned.add(id); newCards.push(id); };
    if (firstVictory) {
      const bonus = !owned.has('frostwarden') ? 'frostwarden' : UNLOCKS.find(item => !owned.has(item.id))?.id;
      if (bonus) grantCard(bonus);
      else breakdown.collectionBonus = 100;
    }
    for (let level = levelBefore + 1; level <= levelAfter; level++) {
      const cardId = UNLOCKS.find(item => !owned.has(item.id))?.id || null;
      if (cardId) grantCard(cardId);
      else breakdown.levelBonus += 100;
      levelRewards.push({ level, cardId, gold: cardId ? 0 : 100 });
    }
    const calculatedGold = Object.values(breakdown).reduce((total, value) => total + value, 0);
    const gold = Math.min(calculatedGold, MAX_GOLD - profile.gold);

    // The caller persists this entire profile before removing the terminal
    // battle save. A reloaded battle ID then follows the no-mutation path above.
    profile.claimedBattles.push(state.battleId);
    profile.gold += gold;
    profile.xp += xp;
    profile.totalGoldEarned = safeAdd(profile.totalGoldEarned, gold);
    profile.unlocked.push(...newCards);
    if (won) {
      profile.wins = Math.min(Number.MAX_SAFE_INTEGER, profile.wins + 1);
      profile.firstVictory = true;
    } else profile.losses = Math.min(Number.MAX_SAFE_INTEGER, profile.losses + 1);
    profile.totalKills = safeAdd(profile.totalKills, state.stats.kills);
    profile.totalBattles = Math.max(safeAdd(profile.totalBattles, 1), safeAdd(profile.wins, profile.losses));
    profile.battleHistory.push({ battleId: state.battleId, outcome: state.status,
      mapId: ['abyss', 'ember', 'frost'].includes(state.mapId) ? state.mapId : 'abyss',
      mode: state.mode, difficulty: state.difficulty, elapsed: state.elapsed, gold, xp });
    if (profile.battleHistory.length > 10) profile.battleHistory.splice(0, profile.battleHistory.length - 10);

    const message = !eligible
      ? 'No rewards this time. Fight for at least 20 seconds and summon a troop to earn a defeat reward.'
      : `${firstVictory ? 'First victory!' : 'Battle complete!'} +${gold} gold, +${xp} XP.${newCards.length ? ` ${newCards.length} free ${newCards.length === 1 ? 'card' : 'cards'} unlocked.` : ''}${levelAfter > levelBefore ? ` Level ${levelAfter}!` : ''}`;
    return { ok: true, gold, xp, newCards, firstVictory, eligible, outcome: state.status,
      levelBefore, levelAfter, levelsGained: levelAfter - levelBefore, levelRewards, breakdown, xpBreakdown, message };
  }

  return Object.freeze({ createProfile, restoreProfile, purchase, rewardBattle, claimDeliveries,
    setDeck, updateIdentity, levelInfo, STARTER_IDS, DEFAULT_DECK, MAX_DECK_SIZE, AVATARS, MAX_LEVEL, MAX_XP, UNLOCKS });
});
