/* Loop consumer bridge. No subscription entitlement is stored in app preferences. */
(() => {
  'use strict';
  const STORAGE_KEY = 'little-steps-state-v1';
  const MAX_STATE_BYTES = 1024 * 1024;
  const STORAGE_TIMEOUT = 20000;
  const PURCHASE_TIMEOUT = 120000;
  const PROFILE_FIELDS = ['category', 'brand', 'brandSource', 'modelId', 'modelLabel', 'modelSource', 'deviceLabel', 'software', 'printingApp', 'sourcePlatform', 'sourceDevice', 'hostDevice', 'hostSoftware', 'app', 'nickname'];
  const FACT_FIELDS = [...PROFILE_FIELDS, 'basicGuideId', 'basicNext', 'basicStep', 'catalogModelId', 'catalogReturn', 'connectionKind', 'customKind', 'guideId', 'guideStep', 'issue'];
  const PROFILE_FLAGS = ['catalogComplete', 'planned'];
  const FACT_FLAGS = [...PROFILE_FLAGS, 'browsing'];
  const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  let volatileState = null;
  let mutationQueue = Promise.resolve();

  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));
  const config = () => isRecord(window.LITTLE_STEPS_CONFIG) ? window.LITTLE_STEPS_CONFIG : {};
  const productID = () => typeof config().productID === 'string' ? config().productID : '';
  const cleanText = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max) : null;
  const problem = (code, message) => ({ code, message });
  const failure = (code, message, extra = {}) => ({ ok: false, ...extra, error: problem(code, message) });

  function notifyStorage(operation, error, persistent = false) {
    try {
      window.dispatchEvent(new CustomEvent('littleStepsStorageError', {
        detail: { operation, code: error.code, message: error.message, persistent }
      }));
    } catch (_) { /* Storage failure must never crash the app's error display. */ }
  }

  function cleanProfile(value, facts = false) {
    if (!isRecord(value)) return null;
    const result = {};
    for (const key of facts ? FACT_FIELDS : PROFILE_FIELDS) {
      if (!own(value, key)) continue;
      if (facts && (key === 'guideStep' || key === 'basicStep') && Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 200) {
        result[key] = value[key];
        continue;
      }
      const text = cleanText(value[key], key === 'nickname' ? 80 : key.endsWith('Source') ? 2048 : 500);
      if (text !== null) result[key] = text;
    }
    for (const key of facts ? FACT_FLAGS : PROFILE_FLAGS) {
      if (own(value, key) && typeof value[key] === 'boolean') result[key] = value[key];
    }
    return Object.keys(result).length ? result : null;
  }

  function validateState(value) {
    if (!isRecord(value) || value.schemaVersion !== 1) throw problem('state_version', 'Saved information could not be read because its format is unsupported.');
    if (!Array.isArray(value.savedProfiles) || value.savedProfiles.length > 100) throw problem('state_profiles', 'You can save up to 100 devices on this device.');
    if (!isRecord(value.guideProgress) || Object.keys(value.guideProgress).length > 100) throw problem('state_progress', 'Saved guide progress could not be read.');
    const savedProfiles = value.savedProfiles.map(item => cleanProfile(item)).filter(Boolean);
    const guideProgress = {};
    for (const id of Object.keys(value.guideProgress)) {
      if (BLOCKED_KEYS.has(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id)) continue;
      const entry = value.guideProgress[id];
      if (!isRecord(entry) || !Number.isInteger(entry.step) || entry.step < 0 || entry.step > 200) continue;
      const facts = cleanProfile(entry.facts, true);
      if (!facts) continue;
      const events = Array.isArray(entry.events) ? entry.events.slice(0, 200).map(event => {
        if (!isRecord(event)) return null;
        const title = cleanText(event.title, 240), answer = cleanText(event.answer, 2000);
        return title !== null && answer !== null ? { title, answer } : null;
      }) : [];
      guideProgress[id] = { caseKey: cleanText(entry.caseKey, 2048) || '', facts, step: entry.step, done: entry.done === true, events };
    }
    const language = typeof value.language === 'string' && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(value.language) ? value.language : 'en';
    const lastAdvancedGuide = typeof value.lastAdvancedGuide === 'string' && own(guideProgress, value.lastAdvancedGuide) ? value.lastAdvancedGuide : null;
    const updatedAt = typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? new Date(value.updatedAt).toISOString() : new Date().toISOString();
    const result = { schemaVersion: 1, savedProfiles, guideProgress, lastAdvancedGuide, language, onboardingComplete: value.onboardingComplete === true, updatedAt };
    if (JSON.stringify(result).length > MAX_STATE_BYTES) throw problem('state_size', 'There is too much saved information. Remove an old device or guide and try again.');
    return result;
  }

  function nativeBridge() {
    const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.littleSteps;
    return handler && typeof handler.postMessage === 'function' ? handler : null;
  }

  async function nativeCall(action, payload = {}, timeout = STORAGE_TIMEOUT) {
    const handler = nativeBridge();
    if (!handler) return failure('native_unavailable', 'This feature is available in the Loop iOS app.');
    let timer;
    try {
      const reply = handler.postMessage({ action, payload });
      if (!reply || typeof reply.then !== 'function') return failure('native_bridge', 'The app connection is unavailable. Close and reopen Loop, then try again.');
      const result = await Promise.race([
        reply,
        new Promise((_, reject) => { timer = setTimeout(() => reject(problem('native_timeout', 'This is taking longer than expected. Please try again.')), timeout); })
      ]);
      if (!isRecord(result)) return failure('native_response', 'The app received an incomplete response. Please try again.');
      if (result.ok === false) return failure(cleanText(result.error?.code, 80) || 'native_error', cleanText(result.error?.message, 500) || cleanText(result.message, 500) || 'The request could not be completed.');
      return { ok: true, result };
    } catch (error) {
      return failure(cleanText(error?.code, 80) || 'native_error', cleanText(error?.message, 500) || cleanText(error, 500) || 'The request could not be completed. Please try again.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function storageFailure(operation, error, state = null) {
    notifyStorage(operation, error);
    return { ok: false, persistent: false, state: clone(state), error };
  }

  async function readState() {
    if (nativeBridge()) {
      const reply = await nativeCall('loadState');
      if (!reply.ok) return storageFailure('load', reply.error);
      if (!own(reply.result, 'state')) return storageFailure('load', problem('native_response', 'Your saved information could not be loaded.'));
      if (reply.result.state === null) return { ok: true, state: null, persistent: true };
      try {
        const state = validateState(reply.result.state);
        volatileState = state;
        return { ok: true, state: clone(state), persistent: true };
      } catch (error) {
        // Do not silently delete a newer native schema. The UI can start with clean state.
        return storageFailure('load', problem(error.code || 'state_invalid', error.message || 'Saved information could not be read. You can start again.'));
      }
    }
    let raw;
    try { raw = window.localStorage.getItem(STORAGE_KEY); }
    catch (_) { return storageFailure('load', problem('storage_unavailable', 'Changes cannot be saved on this device right now. They will only last while Loop stays open.'), volatileState); }
    if (raw === null) return { ok: true, state: null, persistent: true };
    try {
      if (raw.length > MAX_STATE_BYTES) throw problem('state_size', 'Saved information is too large to read.');
      const state = validateState(JSON.parse(raw));
      volatileState = state;
      return { ok: true, state: clone(state), persistent: true };
    } catch (error) {
      const message = error.code === 'state_version' ? error.message : 'Saved information could not be read. Loop has started with an empty saved list.';
      // Keep unsupported versions intact, so opening an older build does not destroy newer data.
      if (error.code === 'state_version') return storageFailure('load', problem('state_version', message));
      let persistent = true;
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (_) { persistent = false; }
      volatileState = null;
      const warning = problem('state_reset', message);
      notifyStorage('load', warning, persistent);
      return { ok: true, state: null, persistent, reset: true, warning };
    }
  }

  async function writeState(value) {
    let state;
    try { state = validateState(value); }
    catch (error) { return storageFailure('save', problem(error.code || 'state_invalid', error.message || 'Your changes could not be saved.')); }
    state.updatedAt = new Date().toISOString();
    volatileState = state;
    if (nativeBridge()) {
      const reply = await nativeCall('saveState', { state: clone(state) });
      if (!reply.ok) return storageFailure('save', reply.error, state);
      if (reply.result.ok !== true) return storageFailure('save', problem('native_response', 'Your changes could not be confirmed as saved.'), state);
      return { ok: true, state: clone(state), persistent: true };
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return { ok: true, state: clone(state), persistent: true };
    } catch (_) {
      return storageFailure('save', problem('storage_unavailable', 'Changes cannot be saved on this device right now. They will only last while Loop stays open.'), state);
    }
  }

  async function removeState() {
    if (nativeBridge()) {
      const reply = await nativeCall('clearState');
      if (!reply.ok) return storageFailure('clear', reply.error);
      if (reply.result.ok !== true) return storageFailure('clear', problem('native_response', 'Your saved information could not be confirmed as removed.'));
      volatileState = null;
      return { ok: true, persistent: true };
    }
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      volatileState = null;
      return { ok: true, persistent: true };
    } catch (_) { return storageFailure('clear', problem('storage_unavailable', 'Saved information could not be removed. Please try again.')); }
  }

  // Ordering writes and clears prevents a late save from recreating data after a clear.
  function queueMutation(operation) {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function unavailable(error, extra = {}) {
    return { ok: false, status: 'unavailable', price: null, period: 'year', productId: productID(), expirationDate: null, ...extra, error };
  }

  function subscriptionResult(raw) {
    const validStatus = ['active', 'inactive', 'unavailable'].includes(raw.status);
    const validProduct = typeof raw.productId === 'string' && productID() && raw.productId === productID();
    const validExpiration = raw.expirationDate === null || (typeof raw.expirationDate === 'string' && Number.isFinite(Date.parse(raw.expirationDate)));
    if (!validStatus || !validProduct || raw.period !== 'year' || !validExpiration || (raw.status === 'active' && (raw.expirationDate === null || Date.parse(raw.expirationDate) <= Date.now()))) {
      return unavailable(problem('subscription_response', 'Your Full Access status could not be verified. Please restore purchases or try again.'));
    }
    const result = { ok: true, status: raw.status, price: cleanText(raw.price, 80), period: 'year', productId: raw.productId, expirationDate: raw.expirationDate };
    const outcome = cleanText(raw.outcome, 80), message = cleanText(raw.message, 500);
    if (outcome !== null) result.outcome = outcome;
    if (message !== null) result.message = message;
    return result;
  }

  async function subscriptionAction(action) {
    if (!nativeBridge()) return unavailable(problem('native_unavailable', 'Purchases and purchase restoration are available in the Loop iOS app.'));
    if (action === 'purchase' && config().purchasesEnabled !== true) return unavailable(problem('purchases_unavailable', 'Full Access purchases are not available in this build.'));
    const reply = await nativeCall(action, {}, action === 'purchase' ? PURCHASE_TIMEOUT : STORAGE_TIMEOUT);
    return reply.ok ? subscriptionResult(reply.result) : unavailable(reply.error);
  }

  async function manageSubscription() {
    const reply = await nativeCall('manageSubscription');
    if (!reply.ok) return reply;
    return reply.result.ok === true ? { ok: true } : failure('native_response', 'Subscription settings could not be opened. Please try again.');
  }

  async function shareSummary(text, title = 'Loop troubleshooting summary') {
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) return failure('share_text', 'There is no troubleshooting summary ready to share.');
    const payload = { text, title: cleanText(title, 120) || 'Loop troubleshooting summary' };
    if (nativeBridge()) {
      const reply = await nativeCall('shareSummary', payload);
      if (!reply.ok) return reply;
      return reply.result.ok === true ? { ok: true, method: 'native' } : failure('share_unavailable', 'The share sheet could not be opened.');
    }
    try {
      if (navigator && typeof navigator.share === 'function') {
        await navigator.share(payload);
        return { ok: true, method: 'share' };
      }
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(payload.text);
        return { ok: true, method: 'clipboard', copied: true };
      }
      return failure('share_unavailable', 'Sharing is unavailable here. You can select and copy the summary instead.');
    } catch (error) {
      return error?.name === 'AbortError' ? { ok: false, outcome: 'cancelled', error: problem('share_cancelled', 'Sharing was cancelled.') } : failure('share_unavailable', 'The summary could not be shared. Please try again.');
    }
  }

  // Last-resort guard also covers unavailable browser properties and malformed callers.
  const safe = (method, onError) => async (...args) => {
    try { return await method(...args); }
    catch (_) { return onError ? onError() : failure('runtime_error', 'This action could not be completed. Please try again.'); }
  };
  window.LittleStepsRuntime = Object.freeze({
    loadState: safe(() => mutationQueue.then(readState), () => storageFailure('load', problem('storage_unavailable', 'Your saved information could not be loaded.'))),
    saveState: safe(state => queueMutation(() => writeState(state)), () => storageFailure('save', problem('storage_unavailable', 'Your changes could not be saved.'))),
    clearState: safe(() => queueMutation(removeState), () => storageFailure('clear', problem('storage_unavailable', 'Your saved information could not be removed.'))),
    getSubscription: safe(() => subscriptionAction('getSubscription'), () => unavailable(problem('subscription_unavailable', 'Your Full Access status could not be verified.'))),
    purchase: safe(() => subscriptionAction('purchase'), () => unavailable(problem('subscription_unavailable', 'Your purchase could not be completed.'))),
    restore: safe(() => subscriptionAction('restore'), () => unavailable(problem('subscription_unavailable', 'Purchases could not be restored.'))),
    manageSubscription: safe(manageSubscription),
    shareSummary: safe(shareSummary)
  });
})();
