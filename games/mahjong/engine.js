(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MahjongEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const layouts = [
    { id: 'cove', name: 'La Crique', description: 'Une escale de 36 tuiles', count: 36 },
    { id: 'fortress', name: 'La Forteresse', description: '72 tuiles dans la citadelle', count: 72 },
    { id: 'kraken', name: 'Le Kraken', description: 'Le défi des 108 tuiles', count: 108 }
  ];
  const EPSILON = 0.00001;

  function numericSeed(value) {
    if (value === undefined || value === null) return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
    let hash = 2166136261;
    for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  }

  function randomSource(seed) {
    let value = seed;
    return function () {
      value = (value + 0x6d2b79f5) | 0;
      let t = Math.imul(value ^ (value >>> 15), 1 | value);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomize(values, random) {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }

  function geometry(layoutId) {
    const tiles = [];
    function layer(width, height, x, y, z) {
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) tiles.push({ id: 't' + tiles.length, x: x + col, y: y + row, z, type: 0, removed: false });
      }
    }
    if (layoutId === 'cove') {
      layer(6, 4, 0, 0, 0);
      layer(4, 2, 1, 1, 1);
      layer(2, 2, 2, 1, 2);
    } else if (layoutId === 'kraken') {
      layer(10, 6, 0, 0, 0);
      layer(8, 4, 1, 1, 1);
      layer(4, 4, 3, 1, 2);
    } else {
      layer(8, 6, 0, 0, 0);
      layer(6, 3, 1, 1, 1);
      layer(2, 3, 3, 1, 2);
    }
    return tiles;
  }

  // A tile is free when its face is uncovered and either horizontal side is open.
  // Coordinates describe the tile footprint, before any decorative layer offset.
  function freeTile(tiles, tile) {
    if (!tile || tile.removed) return false;
    let left = false;
    let right = false;
    for (const other of tiles) {
      if (other === tile || other.removed) continue;
      const overlapsY = Math.abs(other.y - tile.y) < 1 - EPSILON;
      if (!overlapsY) continue;
      if (other.z > tile.z && Math.abs(other.x - tile.x) < 1 - EPSILON) return false;
      if (other.z !== tile.z) continue;
      if (Math.abs(other.x - (tile.x - 1)) < EPSILON) left = true;
      if (Math.abs(other.x - (tile.x + 1)) < EPSILON) right = true;
    }
    return !left || !right;
  }

  function isFree(tiles, id) {
    return freeTile(tiles, tiles.find(tile => tile.id === id));
  }

  function getPairs(tiles) {
    const free = tiles.filter(tile => freeTile(tiles, tile));
    const pairs = [];
    for (let a = 0; a < free.length; a++) {
      for (let b = a + 1; b < free.length; b++) {
        if (free[a].type === free[b].type) pairs.push([free[a].id, free[b].id]);
      }
    }
    return pairs;
  }

  function removePair(tiles, a, b) {
    if (a === b) return false;
    const first = tiles.find(tile => tile.id === a);
    const second = tiles.find(tile => tile.id === b);
    if (!first || !second || first.type !== second.type || !freeTile(tiles, first) || !freeTile(tiles, second)) return false;
    first.removed = true;
    second.removed = true;
    return true;
  }

  function removalOrder(tiles, random) {
    const live = tiles.filter(tile => !tile.removed);
    if (!live.length) return [];
    if (live.length % 2) throw new Error('Le nombre de tuiles restantes doit être pair.');
    // Every initial layer has an even population, so highest-layer-first always
    // succeeds. Different pair choices can leave odd layer populations later;
    // bounded retries find a new order without expensive searches on a phone.
    for (let attempt = 0; attempt < 24; attempt++) {
      const copy = live.map(tile => ({ ...tile, removed: false }));
      const order = [];
      let remaining = copy.length;
      while (remaining) {
        const free = randomize(copy.filter(tile => freeTile(copy, tile)), random);
        if (free.length < 2) break;
        if (attempt < 12) free.sort((a, b) => b.z - a.z);
        const first = free[0];
        const second = free[1];
        first.removed = second.removed = true;
        order.push([first.id, second.id]);
        remaining -= 2;
      }
      if (!remaining) return order;
    }
    return null;
  }

  function assignTypes(tiles, order, pairTypes, random) {
    const byId = new Map(tiles.map(tile => [tile.id, tile]));
    randomize(pairTypes, random);
    order.forEach((pair, index) => {
      byId.get(pair[0]).type = pairTypes[index];
      byId.get(pair[1]).type = pairTypes[index];
    });
  }

  function createGame(layoutId, seed) {
    const selected = layouts.find(layout => layout.id === layoutId) || layouts[1];
    const normalizedSeed = numericSeed(seed);
    const random = randomSource(normalizedSeed);
    const tiles = geometry(selected.id);
    const solution = removalOrder(tiles, random);
    if (!solution) throw new Error('Impossible de préparer ce plateau.');
    const pairTypes = Array.from({ length: tiles.length / 2 }, (_, i) => i % 12);
    assignTypes(tiles, solution, pairTypes, random);
    return { tiles, solution, seed: normalizedSeed, layoutId: selected.id };
  }

  function shuffle(tiles, seed) {
    const random = randomSource(numericSeed(seed));
    const counts = new Map();
    const live = tiles.filter(tile => !tile.removed);
    for (const tile of live) counts.set(tile.type, (counts.get(tile.type) || 0) + 1);
    const pairTypes = [];
    for (const [type, count] of counts) {
      if (count % 2) throw new Error('Chaque symbole doit posséder un nombre pair de tuiles.');
      for (let n = 0; n < count / 2; n++) pairTypes.push(type);
    }
    let solution = removalOrder(tiles, random);
    let reflowed = false;
    if (!solution) {
      // A legal player choice can leave two tiles stacked with no removable pair.
      // Redeal that remainder flat, keeping IDs, removed tiles and symbol counts.
      const width = Math.min(8, Math.max(2, Math.ceil(Math.sqrt(live.length * 1.3) / 2) * 2));
      live.forEach((tile, index) => {
        tile.x = index % width;
        tile.y = Math.floor(index / width);
        tile.z = 0;
      });
      solution = removalOrder(tiles, random);
      reflowed = true;
    }
    assignTypes(tiles, solution, pairTypes, random);
    Object.defineProperty(solution, 'reflowed', { value: reflowed, enumerable: false });
    return solution;
  }

  return { layouts, createGame, isFree, getPairs, removePair, shuffle };
});
