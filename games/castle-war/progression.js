(function (root, factory) {
  'use strict';
  const api = factory();
  if (root) root.CastleProgression = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STARTER_IDS = Object.freeze(['sentinel', 'archer', 'golem', 'swarm', 'cannon', 'mortar', 'heal', 'lightning', 'runner']);
  const UNLOCKS = Object.freeze([
    { id: 'embermage', price: 100 },
    { id: 'frostwarden', price: 140 },
    { id: 'tidecaller', price: 180 },
    { id: 'fireball', price: 120 },
    { id: 'blizzard', price: 160 },
    { id: 'tidalwave', price: 180 },
    { id: 'aegis', price: 220 }
  ].map(Object.freeze));
  const ALL_IDS = new Set([...STARTER_IDS, ...UNLOCKS.map(item => item.id)]);
  const MAX_GOLD = 1000000000;
  const validCount = n => Number.isSafeInteger(n) && n >= 0;
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,159}$/.test(id);
  const validDeliveryId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,239}$/.test(id);
  const failure = message => ({ ok: false, gold: 0, newCards: [], firstVictory: false, message });

  function createProfile() {
    return {
      version: 1, gold: 0, unlocked: [...STARTER_IDS], claimedBattles: [], claimedDeliveries: [],
      firstVictory: false, wins: 0, losses: 0, totalGoldEarned: 0
    };
  }

  function restoreProfile(raw) {
    try {
      const saved = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
          (saved.version !== undefined && saved.version !== 0 && saved.version !== 1)) return null;
      for (const field of ['gold', 'wins', 'losses', 'totalGoldEarned']) {
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
      return profile;
    } catch (_) { return null; }
  }

  function validProfile(profile) {
    return profile && profile.version === 1 && validCount(profile.gold) && profile.gold <= MAX_GOLD &&
      Array.isArray(profile.unlocked) && profile.unlocked.every(id => ALL_IDS.has(id)) && STARTER_IDS.every(id => profile.unlocked.includes(id)) &&
      Array.isArray(profile.claimedBattles) && profile.claimedBattles.every(validId) &&
      Array.isArray(profile.claimedDeliveries) && profile.claimedDeliveries.every(validDeliveryId) &&
      typeof profile.firstVictory === 'boolean' && validCount(profile.wins) && validCount(profile.losses) && validCount(profile.totalGoldEarned);
  }

  function purchase(profile, id) {
    if (!validProfile(profile)) return failure('Your collection could not be loaded.');
    const offer = UNLOCKS.find(item => item.id === id);
    if (!offer) return failure('This card is not available in the shop.');
    if (profile.unlocked.includes(id)) return failure('You already own this card.');
    if (profile.gold < offer.price) return failure(`You need ${offer.price - profile.gold} more gold to unlock this card.`);
    profile.gold -= offer.price;
    profile.unlocked.push(id);
    return { ok: true, gold: -offer.price, spent: offer.price, newCards: [id], firstVictory: false, message: 'Card unlocked! It is now available in your battles.' };
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
      collectionBonus: 0
    };
    const newCards = [];
    if (firstVictory) {
      const bonus = !profile.unlocked.includes('frostwarden') ? 'frostwarden' : UNLOCKS.find(item => !profile.unlocked.includes(item.id))?.id;
      if (bonus) newCards.push(bonus);
      else breakdown.collectionBonus = 100;
    }
    const calculatedGold = Object.values(breakdown).reduce((total, value) => total + value, 0);
    const gold = Math.min(calculatedGold, MAX_GOLD - profile.gold);

    // The caller persists this entire profile before removing the terminal
    // battle save. A reloaded battle ID then follows the no-mutation path above.
    profile.claimedBattles.push(state.battleId);
    profile.gold += gold;
    profile.totalGoldEarned = Math.min(Number.MAX_SAFE_INTEGER, profile.totalGoldEarned + gold);
    profile.unlocked.push(...newCards);
    if (won) {
      profile.wins = Math.min(Number.MAX_SAFE_INTEGER, profile.wins + 1);
      profile.firstVictory = true;
    } else profile.losses = Math.min(Number.MAX_SAFE_INTEGER, profile.losses + 1);

    const message = !eligible
      ? 'No gold this time. Fight for at least 20 seconds and summon a troop to earn a defeat reward.'
      : firstVictory && newCards.length
        ? `First victory! +${gold} gold and a free card unlocked.`
        : `Battle complete! +${gold} gold.`;
    return { ok: true, gold, newCards, firstVictory, eligible, outcome: state.status, breakdown, message };
  }

  return Object.freeze({ createProfile, restoreProfile, purchase, rewardBattle, claimDeliveries, STARTER_IDS, UNLOCKS });
});
