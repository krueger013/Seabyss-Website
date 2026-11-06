/* Autoplay bookkeeping only; the application owns animation and scheduling. */
(function () {
  'use strict';

  const COUNTS = Object.freeze([10, 25, 50, 100]);

  function createController() {
    let state = {
      active: false,
      total: 0,
      remaining: 0,
      completed: 0,
      paused: false,
      pauseReason: null,
      lastStopReason: null
    };

    function getState() {
      return { ...state };
    }

    function start(count) {
      if (!COUNTS.includes(count)) {
        throw new RangeError('Le nombre de tours automatiques doit être 10, 25, 50 ou 100.');
      }
      if (state.active) {
        throw new Error('Une série de tours automatiques est déjà en cours.');
      }
      state = {
        active: true,
        total: count,
        remaining: count,
        completed: 0,
        paused: false,
        pauseReason: null,
        lastStopReason: null
      };
      return getState();
    }

    function consumePaidSpin() {
      if (!state.active) {
        throw new Error('Aucune série de tours automatiques n’est en cours.');
      }
      if (state.remaining <= 0) {
        throw new RangeError('Tous les tours payants de cette série ont été joués.');
      }
      state.remaining -= 1;
      state.completed += 1;
      // Keep the series active until its final earned bonus has also finished.
      return getState();
    }

    function pause(reason = 'bonus') {
      if (state.active) {
        state.paused = true;
        state.pauseReason = reason;
      }
      return getState();
    }

    function resume() {
      state.paused = false;
      state.pauseReason = null;
      return getState();
    }

    function stop(reason = 'user') {
      state.active = false;
      state.paused = false;
      state.pauseReason = null;
      state.lastStopReason = reason;
      return getState();
    }

    function canSpin({ inBonus = false, balance, bet } = {}) {
      return state.active && !state.paused &&
        (Boolean(inBonus) || (state.remaining > 0 && balance >= bet));
    }

    return Object.freeze({ getState, start, consumePaidSpin, pause, resume, stop, canSpin });
  }

  const api = Object.freeze({ COUNTS, createController });
  globalThis.SeabyssAutoplay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
