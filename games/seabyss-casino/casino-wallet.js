// Shared fictional balance. Session commits store the credit and its game state
// in one localStorage value. Web Locks or IndexedDB serialize shared transactions.
(function (root) {
  'use strict';
  const key = 'seabyss-casino-wallet-v1';
  const lockName = 'seabyss-casino-wallet';
  const hourlyAmount = 5000, hourlyInterval = 3600000;
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const owns = (object, property) => Object.prototype.hasOwnProperty.call(object, property);
  let memory = null;
  let pendingWrite = false;
  let transactionQueue = Promise.resolve();
  let lockDatabase = null;
  function problem(code, message) { return Object.assign(new Error(message), { code }); }
  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function writeRecord(record, requirePersistence = false) {
    if (!valid(record.balance)) fail('INVALID_AMOUNT', 'Solde invalide.');
    const encoded = JSON.stringify(record);
    // A gift must save its balance and next claim time together. A failed save
    // must not award spendable credit that could be claimed again after reload.
    if (requirePersistence) {
      try { localStorage.setItem(key, encoded); }
      catch (_) { fail('REWARD_STORAGE_UNAVAILABLE', 'Le cadeau nécessite le stockage local. Autorisez-le puis réessayez.'); }
      memory = record;
      pendingWrite = false;
      return record;
    }
    memory = record;
    try {
      localStorage.setItem(key, encoded);
      pendingWrite = false;
    } catch (_) { pendingWrite = true; }
    return record;
  }
  function readRecord() {
    // A failed write leaves an older stored balance. Keep the current session's
    // complete record until a later write succeeds, including pending game state.
    if (pendingWrite && memory) return memory;
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (valid(saved?.balance)) return memory = { ...saved, sessions: isObject(saved.sessions) ? saved.sessions : {} };
    } catch (_) { /* Storage is optional. */ }
    if (memory) return memory;
    let balance = 10000;
    try {
      const legacy = JSON.parse(localStorage.getItem('seabyss-casino-session-v1'));
      if (valid(legacy?.state?.balance)) balance = legacy.state.balance;
    } catch (_) { /* A new casino starts with 100 fictional dollars. */ }
    return writeRecord({ balance, sessions: {} });
  }
  function read() { return readRecord().balance; }
  function queueLocally(callback) {
    const result = transactionQueue.then(callback);
    transactionQueue = result.catch(() => {});
    return result;
  }
  function openLockDatabase() {
    if (lockDatabase) return lockDatabase;
    lockDatabase = new Promise((resolve, reject) => {
      let request, settled = false;
      const unavailable = () => {
        if (settled) return;
        settled = true;
        reject(problem('WALLET_LOCK_UNAVAILABLE', 'Le verrou partagé du portefeuille est indisponible.'));
      };
      try { request = root.indexedDB.open(lockName, 1); }
      catch (_) { unavailable(); return; }
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains('transactions')) request.result.createObjectStore('transactions');
        } catch (_) { unavailable(); }
      };
      request.onerror = unavailable;
      request.onblocked = unavailable;
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        settled = true;
        database.onversionchange = () => { database.close(); lockDatabase = null; };
        resolve(database);
      };
    }).catch(error => { lockDatabase = null; throw error; });
    return lockDatabase;
  }
  function indexedTransaction(database, callback) {
    return new Promise((resolve, reject) => {
      let transaction, result, operationError;
      try { transaction = database.transaction('transactions', 'readwrite'); }
      catch (_) { lockDatabase = null; reject(problem('WALLET_LOCK_UNAVAILABLE', 'Le verrou partagé du portefeuille est indisponible.')); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(operationError || problem('WALLET_LOCK_UNAVAILABLE', 'L’opération du portefeuille a été interrompue.'));
      // A readwrite transaction owns this store across tabs before its request
      // fires. Keep localStorage read + write synchronous inside that callback.
      const request = transaction.objectStore('transactions').get(lockName);
      request.onsuccess = () => {
        try {
          if (callback.constructor?.name === 'AsyncFunction') fail('WALLET_ASYNC_TRANSACTION', 'Cette opération du portefeuille doit être synchrone.');
          result = callback();
          if (result && typeof result.then === 'function') fail('WALLET_ASYNC_TRANSACTION', 'Cette opération du portefeuille doit être synchrone.');
        } catch (error) { operationError = error; transaction.abort(); }
      };
    });
  }
  function exclusive(callback, requireSharedLock = false) {
    if (typeof callback !== 'function') return Promise.reject(new TypeError('Une opération de portefeuille est requise.'));
    if (root.navigator?.locks?.request) return root.navigator.locks.request(lockName, callback);
    const unavailable = () => Promise.reject(problem('REWARD_LOCK_UNAVAILABLE', 'Ce navigateur ne permet pas de récupérer le cadeau en toute fiabilité. Ouvrez le casino dans un navigateur récent avec le stockage autorisé.'));
    if (root.indexedDB?.open) {
      return openLockDatabase().then(database => indexedTransaction(database, callback), () => {
        return requireSharedLock ? unavailable() : queueLocally(callback);
      });
    }
    // Existing offline gameplay can remain usable in memory. Rewards fail
    // closed without a real cross-tab lock, rather than promise false safety.
    return requireSharedLock ? unavailable() : queueLocally(callback);
  }
  function runExclusive(callback) { return exclusive(callback); }
  function rewardClock(now) {
    const value = now === undefined ? Date.now() : now;
    if (!valid(value) || !valid(value + hourlyInterval)) fail('INVALID_TIME', 'L’heure du cadeau est invalide.');
    return value;
  }
  function statusFor(record, now) {
    const nextAt = valid(record.hourlyRewardNextAt) ? record.hourlyRewardNextAt : 0;
    const remaining = Math.max(0, nextAt - now);
    return { amount: hourlyAmount, remaining, available: remaining === 0, nextAt };
  }
  function rewardStatus(now) {
    const currentTime = rewardClock(now);
    return statusFor(readRecord(), currentTime);
  }
  function claimHourlyReward(now) {
    return exclusive(() => {
      const currentTime = rewardClock(now);
      // Never award from an unreadable or unsaved in-memory snapshot: another
      // tab may already have collected the gift in the persistent record.
      try { localStorage.getItem(key); }
      catch (_) { fail('REWARD_STORAGE_UNAVAILABLE', 'Le cadeau nécessite le stockage local. Autorisez-le puis réessayez.'); }
      const record = readRecord();
      if (pendingWrite) fail('REWARD_STORAGE_UNAVAILABLE', 'La partie doit être enregistrée avant de récupérer le cadeau.');
      const status = statusFor(record, currentTime);
      if (!status.available) return { ...status, claimed: false, balance: record.balance };
      const next = writeRecord({ ...record,
        balance: adjustedBalance(record.balance, hourlyAmount),
        hourlyRewardNextAt: currentTime + hourlyInterval
      }, true);
      return { ...statusFor(next, currentTime), claimed: true, balance: next.balance };
    }, true);
  }
  function validateDelta(delta) {
    if (!Number.isSafeInteger(delta)) fail('INVALID_AMOUNT', 'Montant invalide.');
  }
  function adjustedBalance(balance, delta) {
    const next = balance + delta;
    if (next < 0) fail('INSUFFICIENT_BALANCE', 'Solde insuffisant.');
    if (!valid(next)) fail('BALANCE_OVERFLOW', 'Le solde dépasse la limite du jeu.');
    return next;
  }
  function adjust(delta) {
    validateDelta(delta);
    const record = readRecord();
    return writeRecord({ ...record, balance: adjustedBalance(record.balance, delta) }).balance;
  }
  function reset() { return writeRecord({ ...readRecord(), balance: 10000 }).balance; }
  function validateSessionKey(sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) fail('INVALID_SESSION', 'La clé de session est invalide.');
  }
  function copyPayload(payload) {
    if (!isObject(payload)) fail('INVALID_SESSION', 'La session doit être un objet enregistrable.');
    try {
      const result = JSON.parse(JSON.stringify(payload));
      if (!isObject(result)) fail('INVALID_SESSION', 'La session doit être un objet enregistrable.');
      return result;
    } catch (_) { fail('INVALID_SESSION', 'La session ne peut pas être enregistrée.'); }
  }
  function readSession(sessionKey) {
    validateSessionKey(sessionKey);
    const record = readRecord();
    return owns(record.sessions, sessionKey) ? copyPayload(record.sessions[sessionKey]) : null;
  }
  function commitSession(sessionKey, payload, delta, expectedRevision) {
    validateSessionKey(sessionKey);
    validateDelta(delta);
    if (expectedRevision !== undefined && !valid(expectedRevision)) fail('INVALID_REVISION', 'La révision attendue est invalide.');
    const record = readRecord();
    const existing = owns(record.sessions, sessionKey) ? record.sessions[sessionKey] : null;
    if (expectedRevision !== undefined && (existing?.revision || 0) !== expectedRevision) {
      fail('STALE_SESSION', 'Cette session a été mise à jour dans un autre onglet.');
    }
    const balance = adjustedBalance(record.balance, delta);
    const snapshot = copyPayload(payload);
    if (isObject(snapshot.state) && owns(snapshot.state, 'balance')) snapshot.state.balance = balance;
    const sessions = { ...record.sessions, [sessionKey]: snapshot };
    return writeRecord({ ...record, balance, sessions }).balance;
  }
  root.CasinoWallet = Object.freeze({ read, adjust, reset, readSession, commitSession,
    rewardStatus, claimHourlyReward, runExclusive, key, lockName });
})(globalThis);
