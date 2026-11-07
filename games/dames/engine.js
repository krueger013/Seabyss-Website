(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PirateDraughts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SIZE = 10;
  const DIRECTIONS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const inside = (row, col) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;
  const side = piece => Math.sign(piece);
  const king = piece => Math.abs(piece) === 2;
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

  function positionKey(state) {
    return state.turn + ':' + state.board.map(piece => String(piece + 2)).join('');
  }

  function createGame() {
    const board = Array(100).fill(0);
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if ((row + col) % 2 === 1) board[row * SIZE + col] = row < 4 ? -1 : row > 5 ? 1 : 0;
      }
    }
    const state = { version: 1, board, turn: 1, winner: null, ply: 0, quietPly: 0,
      positions: {}, lastMove: null, endReason: null };
    state.positions[positionKey(state)] = 1;
    return state;
  }

  function captureMoves(board, from, piece) {
    // A captured piece remains on the board until the entire move is complete.
    // In particular, a flying king may not cross it again during the same turn.
    const occupancy = board.slice();
    occupancy[from] = 0;
    const results = [];
    const captured = new Set();
    const path = [];
    const captures = [];

    function visit(current) {
      const row = Math.floor(current / SIZE), col = current % SIZE;
      let extended = false;
      for (const [dr, dc] of DIRECTIONS) {
        let r = row + dr, c = col + dc;
        if (!inside(r, c)) continue;
        if (king(piece)) {
          while (inside(r, c) && occupancy[r * SIZE + c] === 0) { r += dr; c += dc; }
          if (!inside(r, c)) continue;
        }
        const victim = r * SIZE + c;
        if (!occupancy[victim] || side(occupancy[victim]) === side(piece) || captured.has(victim)) continue;
        r += dr; c += dc;
        while (inside(r, c) && occupancy[r * SIZE + c] === 0) {
          extended = true;
          const landing = r * SIZE + c;
          captured.add(victim); captures.push(victim); path.push(landing);
          visit(landing);
          path.pop(); captures.pop(); captured.delete(victim);
          if (!king(piece)) break;
          r += dr; c += dc;
        }
      }
      if (!extended && captures.length) results.push({ from, to: current, path: path.slice(), captures: captures.slice() });
    }
    visit(from);
    return results;
  }

  function generateMoves(state) {
    const { board, turn } = state;
    let captures = [], longest = 0;
    for (let from = 0; from < 100; from++) {
      if (side(board[from]) !== turn) continue;
      for (const move of captureMoves(board, from, board[from])) {
        if (move.captures.length > longest) { longest = move.captures.length; captures = []; }
        if (move.captures.length === longest) captures.push(move);
      }
    }
    if (captures.length) return captures;
    const moves = [];
    for (let from = 0; from < 100; from++) {
      const piece = board[from];
      if (side(piece) !== turn) continue;
      const row = Math.floor(from / SIZE), col = from % SIZE;
      for (const [dr, dc] of DIRECTIONS) {
        if (!king(piece) && dr !== -turn) continue;
        let r = row + dr, c = col + dc;
        while (inside(r, c) && !board[r * SIZE + c]) {
          const to = r * SIZE + c;
          moves.push({ from, to, path: [to], captures: [] });
          if (!king(piece)) break;
          r += dr; c += dc;
        }
      }
    }
    return moves;
  }

  function legalMoves(state) {
    return state.winner != null ? [] : generateMoves(state);
  }

  function pieceCounts(state) {
    const result = { gold: { men: 0, kings: 0, total: 0 }, teal: { men: 0, kings: 0, total: 0 } };
    for (const piece of state.board) {
      if (!piece) continue;
      const group = piece > 0 ? result.gold : result.teal;
      group[king(piece) ? 'kings' : 'men']++;
      group.total++;
    }
    return result;
  }

  function sameMove(a, b) {
    return a && b && a.from === b.from && a.to === b.to && Array.isArray(b.path) && Array.isArray(b.captures) &&
      a.path.length === b.path.length && a.captures.length === b.captures.length &&
      a.path.every((value, index) => value === b.path[index]) && a.captures.every((value, index) => value === b.captures[index]);
  }

  function advance(state, move, finish) {
    const board = state.board.slice();
    let piece = board[move.from];
    const wasMan = !king(piece);
    board[move.from] = 0;
    for (const captured of move.captures) board[captured] = 0;
    // Reaching the back rank in the middle of a capture does not crown a man.
    if (wasMan && (piece === 1 && move.to < 10 || piece === -1 && move.to >= 90)) piece *= 2;
    board[move.to] = piece;
    const result = { version: 1, board, turn: -state.turn, winner: null,
      ply: (state.ply || 0) + 1, quietPly: wasMan || move.captures.length ? 0 : (state.quietPly || 0) + 1,
      positions: { ...(state.positions || {}) },
      lastMove: { from: move.from, to: move.to, path: move.path.slice(), captures: move.captures.slice() }, endReason: null };
    const key = positionKey(result);
    result.positions[key] = (result.positions[key] || 0) + 1;
    if (finish && !generateMoves(result).length) {
      result.winner = state.turn;
      result.endReason = board.some(value => side(value) === result.turn) ? 'blocked' : 'captured';
    } else if (result.positions[key] >= 3) {
      result.winner = 0; result.endReason = 'repetition';
    } else if (result.quietPly >= 50) {
      result.winner = 0; result.endReason = 'quiet';
    }
    return result;
  }

  function applyMove(state, requestedMove) {
    if (state.winner != null) throw new Error('Cette partie est déjà terminée.');
    const move = generateMoves(state).find(candidate => sameMove(candidate, requestedMove));
    if (!move) throw new Error('Ce déplacement ne respecte pas les règles de la partie.');
    return advance(state, move, true);
  }

  function evaluate(state) {
    let score = 0;
    for (let index = 0; index < 100; index++) {
      const piece = state.board[index];
      if (!piece) continue;
      const row = Math.floor(index / SIZE), col = index % SIZE;
      const center = 4.5 - Math.abs(4.5 - col);
      const progression = piece > 0 ? 9 - row : row;
      const value = king(piece) ? 330 + center * 3 : 100 + progression * 4 + center * 2;
      score += side(piece) * value;
    }
    return score * state.turn;
  }

  function chooseMove(state, difficulty = 'moyen') {
    const initial = legalMoves(state);
    if (!initial.length) return null;
    if (initial.length === 1) return initial[0];
    const settings = {
      facile: { depth: 1, nodes: 2000, ms: 100 }, easy: { depth: 1, nodes: 2000, ms: 100 },
      moyen: { depth: 3, nodes: 9000, ms: 240 }, medium: { depth: 3, nodes: 9000, ms: 240 },
      difficile: { depth: 5, nodes: 22000, ms: 420 }, hard: { depth: 5, nodes: 22000, ms: 420 }
    };
    const config = settings[difficulty] || settings.moyen;
    const deadline = now() + config.ms;
    let nodes = 0, aborted = false;
    const ordering = (a, b) => b.captures.length - a.captures.length || a.from - b.from || a.to - b.to;

    function search(current, depth, alpha, beta, distance) {
      if (++nodes > config.nodes || (nodes % 64 === 0 && now() >= deadline)) { aborted = true; return evaluate(current); }
      const options = generateMoves(current);
      if (!options.length) return -100000 + distance;
      if (current.winner === 0) return 0;
      // Extend a mandatory capture at the horizon to avoid valuing a doomed piece.
      if (depth <= 0 && (!options[0].captures.length || distance >= config.depth + 5)) return evaluate(current);
      let best = -Infinity;
      options.sort(ordering);
      for (const option of options) {
        const score = -search(advance(current, option, false), depth - 1, -beta, -alpha, distance + 1);
        if (score > best) best = score;
        if (score > alpha) alpha = score;
        if (alpha >= beta || aborted) break;
      }
      return best;
    }

    let bestMove = initial[0];
    initial.sort(ordering);
    for (let depth = 1; depth <= config.depth; depth++) {
      let iterationBest = bestMove, bestScore = -Infinity;
      // Start the next search with the previous best move, without changing ties.
      const ordered = [bestMove, ...initial.filter(move => move !== bestMove)];
      for (const move of ordered) {
        const score = -search(advance(state, move, false), depth - 1, -Infinity, -bestScore, 1);
        if (score > bestScore) { bestScore = score; iterationBest = move; }
        if (aborted) break;
      }
      if (!aborted) bestMove = iterationBest;
      if (aborted || now() >= deadline) break;
    }
    return bestMove;
  }

  function validateState(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.board) || state.board.length !== 100 ||
      ![1, -1].includes(state.turn) || ![null, 0, 1, -1].includes(state.winner)) return false;
    if (state.board.some((piece, index) => ![0, 1, -1, 2, -2].includes(piece) ||
      piece !== 0 && (Math.floor(index / SIZE) + index % SIZE) % 2 !== 1 ||
      piece === 1 && index < 10 || piece === -1 && index >= 90)) return false;
    const counts = pieceCounts(state);
    if (counts.gold.total > 20 || counts.teal.total > 20 || !counts.gold.total && !counts.teal.total) return false;
    for (const name of ['ply', 'quietPly']) if (!Number.isSafeInteger(state[name]) || state[name] < 0) return false;
    if (state.quietPly > state.ply || !state.positions || typeof state.positions !== 'object' || Array.isArray(state.positions)) return false;
    if (Object.keys(state.positions).length > 10000 || Object.entries(state.positions).some(([key, count]) =>
      !/^-?1:[0-4]{100}$/.test(key) || !Number.isInteger(count) || count < 1 || count > 3)) return false;
    if (!state.positions[positionKey(state)]) return false;
    const movable = generateMoves(state).length > 0;
    if (state.winner === null && (!movable || state.quietPly >= 50 || state.positions[positionKey(state)] >= 3)) return false;
    if ((state.winner === 1 || state.winner === -1) && (movable || state.winner !== -state.turn)) return false;
    if (state.winner === 0 && state.quietPly < 50 && state.positions[positionKey(state)] < 3) return false;
    return true;
  }

  return Object.freeze({ SIZE, createGame, legalMoves, applyMove, chooseMove, pieceCounts, positionKey, validateState });
});
