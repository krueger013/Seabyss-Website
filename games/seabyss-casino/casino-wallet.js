// Shared fictional balance. Session commits store the credit and its game state
// in one localStorage value; callers can additionally serialize tabs with Web Locks.
(function (root) {
  'use strict';
  const key = 'seabyss-casino-wallet-v1';
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const owns = (object, property) => Object.prototype.hasOwnProperty.call(object, property);
  let memory = null;
  let pendingWrite = false;
  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function writeRecord(record) {
    if (!valid(record.balance)) fail('INVALID_AMOUNT', 'Solde invalide.');
    const encoded = JSON.stringify(record);
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
  root.CasinoWallet = Object.freeze({ read, adjust, reset, readSession, commitSession, key });
})(globalThis);
