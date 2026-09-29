/* Built from app/consumer-runtime.js and app/fragment.html. */
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

;

const TECH_CATALOG_META = {"reviewedAt":"2026-09-19","coverage":"Apple devices and software","softwareOptionsType":"User-reported setup; exact version still to confirm","updatePolicy":"Manually reviewed manufacturer sources; no automatic live catalogue feed."};
const TECH_CATALOG = {"tv":[{"brand":"Apple","sourceUrl":"https://support.apple.com/en-gb/101605","models":[{"id":"apple-tv-4k-3","label":"Apple TV 4K 3rd generation (2022)","software":["tvOS / Apple TV settings","A streaming app","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/101605","searchAliases":["Apple TV 4K 2022","Apple TV 4K 3rd gen"]},{"id":"apple-tv-4k-2","label":"Apple TV 4K 2nd generation (2021)","software":["tvOS / Apple TV settings","A streaming app","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/101605","searchAliases":["Apple TV 4K 2021","Apple TV 4K 2nd gen"]},{"id":"apple-tv-hd","label":"Apple TV HD","software":["tvOS / Apple TV settings","A streaming app","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/101605"}]}],"mobile":[{"brand":"Apple","sourceUrl":"https://support.apple.com/en-gb/108044","models":[{"id":"ipad-air-m4-11","label":"iPad Air 11-inch M4 (2026)","software":["iPadOS"],"sourceUrl":"https://www.apple.com/uk/newsroom/2026/03/apple-introduces-the-new-ipad-air-powered-by-m4/","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","releaseDate":"2026-03-11","searchAliases":["ipad air m4 11","ipad air 11 2026"],"catalogFeatured":true},{"id":"ipad-air-m4-13","label":"iPad Air 13-inch M4 (2026)","software":["iPadOS"],"sourceUrl":"https://www.apple.com/uk/newsroom/2026/03/apple-introduces-the-new-ipad-air-powered-by-m4/","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","releaseDate":"2026-03-11","searchAliases":["ipad air m4 13","ipad air 13 2026"],"catalogFeatured":true},{"id":"iphone-duo","label":"iPhone Duo","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-duo/","releaseYear":2026,"availability":"coming-soon","announcedDate":"2026-09-09","availabilityNote":"Pre-orders open 16 October; available 23 October 2026 in the UK, US and over 70 countries and regions. Ships with iOS 27.1.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/v/iphone-duo/b/images/overview/product-viewer/foldable__iybtpzlhgj6u_large.jpg","searchAliases":["iphone fold","apple foldable","iphone duo"],"releaseDate":"2026-10-23"},{"id":"iphone18pro","label":"iPhone 18 Pro","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2026/09/apple-debuts-iphone-18-pro-and-iphone-18-pro-max/","releaseYear":2026,"availability":"released","announcedDate":"2026-09-09","availabilityNote":"Available from 18 September 2026 in the UK, US and over 65 countries and regions; 25 September in additional markets.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/v/iphone/home/ck/images/overview/select/iphone_18_pro__dj48ysc0yagm_large.jpg","searchAliases":["iphone 18 pro"],"releaseDate":"2026-09-18","paidGuideIds":["iphone-wifi"]},{"id":"iphone18promax","label":"iPhone 18 Pro Max","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2026/09/apple-debuts-iphone-18-pro-and-iphone-18-pro-max/","releaseYear":2026,"availability":"released","announcedDate":"2026-09-09","availabilityNote":"Available from 18 September 2026 in the UK, US and over 65 countries and regions; 25 September in additional markets.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/v/iphone/home/ck/images/overview/select/iphone_18_pro__dj48ysc0yagm_large.jpg","searchAliases":["iphone 18 pro max"],"releaseDate":"2026-09-18","paidGuideIds":["iphone-wifi"]},{"id":"iphone17e","label":"iPhone 17e","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2026/03/apple-introduces-iphone-17e/","releaseYear":2026,"availability":"released","announcedDate":"2026-03-02","availabilityNote":"Available from 11 March 2026 in the UK, US and more than 70 countries and regions.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/v/iphone/home/ck/images/overview/select/iphone_17e__cq5ygzct314y_large.jpg","searchAliases":["iphone 17e","iphone17e"],"releaseDate":"2026-03-11","paidGuideIds":["iphone-wifi"]},{"id":"ipad-pro-m5-11","label":"iPad Pro 11-inch M5 (2025)","software":["iPadOS"],"sourceUrl":"https://support.apple.com/en-gb/108043","releaseYear":2025,"availability":"released","catalogReviewedAt":"2026-09-19","availabilityNote":"Available in Wi-Fi and Wi-Fi + Cellular versions; exact settings depend on your iPadOS version.","searchAliases":["ipad pro m5 11","ipad pro 11 2025"],"catalogFeatured":true},{"id":"ipad-pro-m5-13","label":"iPad Pro 13-inch M5 (2025)","software":["iPadOS"],"sourceUrl":"https://support.apple.com/en-gb/108043","releaseYear":2025,"availability":"released","catalogReviewedAt":"2026-09-19","availabilityNote":"Available in Wi-Fi and Wi-Fi + Cellular versions; exact settings depend on your iPadOS version.","searchAliases":["ipad pro m5 13","ipad pro 13 2025"],"catalogFeatured":true},{"id":"ipad-a16","label":"iPad 11-inch A16 (2025)","software":["iPadOS"],"sourceUrl":"https://support.apple.com/en-gb/108043","releaseYear":2025,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["ipad a16","ipad 11th generation"],"catalogFeatured":true},{"id":"iphone17","label":"iPhone 17","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2025/09/apple-debuts-iphone-17/","releaseYear":2025,"availability":"released","announcedDate":"2025-09-09","releaseDate":"2025-09-19","availabilityNote":"First released 19 September 2025. This is an existing model, not a 2026 launch.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/v/iphone/home/ck/images/overview/select/iphone_17__fb1277oq3eaa_large.jpg","searchAliases":["iphone 17"],"paidGuideIds":["iphone-wifi"]},{"id":"iphoneair","label":"iPhone Air","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2025/09/introducing-iphone-air-a-powerful-new-iphone-with-a-breakthrough-design/","releaseYear":2025,"availability":"released","announcedDate":"2025-09-09","releaseDate":"2025-09-19","availabilityNote":"First released 19 September 2025. This is an existing model, not a 2026 launch.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/v/iphone/home/ck/images/overview/select/iphone_air__b5qmgl05ojyq_large.jpg","searchAliases":["iphone air"],"paidGuideIds":["iphone-wifi"]},{"id":"iphone17pro","label":"iPhone 17 Pro","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2025/09/apple-unveils-iphone-17-pro-and-iphone-17-pro-max/","releaseYear":2025,"availability":"released","announcedDate":"2025-09-09","releaseDate":"2025-09-19","availabilityNote":"First released 19 September 2025. This is an existing model, not a 2026 launch.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/newsroom/images/2025/09/apple-unveils-iphone-17-pro-and-iphone-17-pro-max/article/Apple-iPhone-17-Pro-cosmic-orange-250909_inline.jpg.large.jpg","searchAliases":["iphone 17 pro"],"paidGuideIds":["iphone-wifi"]},{"id":"iphone17promax","label":"iPhone 17 Pro Max","software":["iOS"],"sourceUrl":"https://www.apple.com/newsroom/2025/09/apple-unveils-iphone-17-pro-and-iphone-17-pro-max/","releaseYear":2025,"availability":"released","announcedDate":"2025-09-09","releaseDate":"2025-09-19","availabilityNote":"First released 19 September 2025. This is an existing model, not a 2026 launch.","verifiedAt":"2026-09-19","imageUrl":"https://www.apple.com/newsroom/images/2025/09/apple-unveils-iphone-17-pro-and-iphone-17-pro-max/article/Apple-iPhone-17-Pro-cosmic-orange-250909_inline.jpg.large.jpg","searchAliases":["iphone 17 pro max"],"paidGuideIds":["iphone-wifi"]},{"id":"ipad-mini-a17pro","label":"iPad mini A17 Pro (2024)","software":["iPadOS"],"sourceUrl":"https://support.apple.com/en-gb/108043","releaseYear":2024,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["ipad mini 7","ipad mini a17 pro"],"catalogFeatured":true},{"id":"iphone-16","label":"iPhone 16","software":["iOS","An app on my phone","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108044","paidGuideIds":["iphone-wifi"]},{"id":"iphone-16-pro","label":"iPhone 16 Pro","software":["iOS","An app on my phone","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108044","paidGuideIds":["iphone-wifi"]},{"id":"iphone-15","label":"iPhone 15","software":["iOS","An app on my phone","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108044","paidGuideIds":["iphone-wifi"]},{"id":"iphone-14","label":"iPhone 14","software":["iOS","An app on my phone","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108044","paidGuideIds":["iphone-wifi"]},{"id":"iphone-13","label":"iPhone 13","software":["iOS","An app on my phone","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108044","paidGuideIds":["iphone-wifi"]},{"id":"iphone-se3","label":"iPhone SE 3rd generation (2022)","software":["iOS","An app on my phone","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108044","searchAliases":["iPhone SE 2022","iPhone SE 3"],"paidGuideIds":["iphone-wifi"]},{"id":"ipad-10","label":"iPad 10th generation (2022)","software":["iPadOS","An app on my tablet","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108043","searchAliases":["iPad 10","iPad 10th gen"]},{"id":"ipad-air-m2-11","label":"iPad Air 11-inch M2 (2024)","software":["iPadOS","An app on my tablet","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108043","searchAliases":["iPad Air 11 M2"]},{"id":"ipad-mini-6","label":"iPad mini 6th generation (2021)","software":["iPadOS","An app on my tablet","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108043","searchAliases":["iPad mini 6"]},{"id":"ipad-pro-m4-11","label":"iPad Pro 11-inch M4 (2024)","software":["iPadOS","An app on my tablet","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108043","searchAliases":["iPad Pro 11 M4"]}]}],"laptop":[{"brand":"Apple","sourceUrl":"https://support.apple.com/en-gb/102869","models":[{"id":"macbook-air-m5-13","label":"MacBook Air 13-inch M5 (2026)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-us/102869","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["macbook air m5 13","m5 air 13"],"catalogFeatured":true,"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-air-m5-15","label":"MacBook Air 15-inch M5 (2026)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-us/102869","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["macbook air m5 15","m5 air 15"],"catalogFeatured":true,"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-pro-14-m5-pro-max","label":"MacBook Pro 14-inch M5 Pro / Max (2026)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","releaseDate":"2026-03-11","searchAliases":["macbook pro 14 m5 pro","macbook pro 14 m5 max"],"catalogFeatured":true,"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-pro-16-m5-pro-max","label":"MacBook Pro 16-inch M5 Pro / Max (2026)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","releaseDate":"2026-03-11","searchAliases":["macbook pro 16 m5 pro","macbook pro 16 m5 max"],"catalogFeatured":true,"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-neo-2026","label":"MacBook Neo 13-inch (A18 Pro)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://www.apple.com/newsroom/2026/03/say-hello-to-macbook-neo/","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","releaseDate":"2026-03-11","searchAliases":["macbook neo","apple neo","a18 pro macbook"],"catalogFeatured":true,"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-air-m3-13","label":"MacBook Air 13-inch M3 (2024)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102869","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-air-m3-15","label":"MacBook Air 15-inch M3 (2024)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102869","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-air-m2","label":"MacBook Air M2 (2022)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102869","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-pro-14-m3","label":"MacBook Pro 14-inch M3 (November 2023)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108052","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-pro-16-2023","label":"MacBook Pro 16-inch M3 Pro / Max (November 2023)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108052","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"macbook-air-m1","label":"MacBook Air M1 (2020)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102869","searchAliases":["MacBook Air M1"],"paidGuideIds":["mac-wifi-diagnostics"]}]}],"desktop":[{"brand":"Apple","sourceUrl":"https://support.apple.com/en-gb/102852","models":[{"id":"mac-mini-m6-m5-pro-2026","label":"Mac mini M6 / M5 Pro (2026)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://www.apple.com/mac-mini/","releaseYear":2026,"availability":"coming-soon","catalogReviewedAt":"2026-09-19","availabilityNote":"Apple lists availability from 22 September 2026. Pre-orders are open; local delivery varies.","releaseDate":"2026-09-22","announcementUrl":"https://www.apple.com/mac-mini/","searchAliases":["mac mini m6","mac mini m5 pro","2026 mac mini"],"catalogFeatured":true},{"id":"mac-studio-m5-2026","label":"Mac Studio M5 Max / Ultra (2026)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://www.apple.com/mac-studio/","releaseYear":2026,"availability":"coming-soon","catalogReviewedAt":"2026-09-19","availabilityNote":"Apple lists availability from 22 September 2026. Pre-orders are open; local delivery varies.","releaseDate":"2026-09-22","announcementUrl":"https://www.apple.com/mac-studio/","searchAliases":["mac studio m5 max","mac studio m5 ultra","2026 mac studio"],"catalogFeatured":true},{"id":"imac-m4-2024-family","label":"iMac 24-inch M4 (2024 family)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-us/108054","releaseYear":2024,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["imac m4","imac 2024","mac16 2","mac16 3"],"catalogFeatured":true,"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"mac-mini-m2","label":"Mac mini M2 (2023)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102852","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"mac-mini-m1","label":"Mac mini M1 (2020)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102852","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"imac-24-2023-four-ports","label":"iMac 24-inch (2023, four ports)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108054","paidGuideIds":["mac-wifi-diagnostics"]},{"id":"imac-m1-2021-family","label":"iMac 24-inch M1 (2021 family)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108054","searchAliases":["iMac M1","iMac 2021"],"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"mac-mini-2024-family","label":"Mac mini (2024 family)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102852","searchAliases":["Mac mini 2024","Mac mini M4"],"paidGuideIds":["mac-wifi-diagnostics"]},{"id":"mac-studio-m2-max","label":"Mac Studio M2 Max (2023)","software":["macOS","An app on my Mac","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/102231","paidGuideIds":["mac-wifi-diagnostics"]}]}],"apps":[{"brand":"Apple","sourceUrl":"https://support.apple.com/en-gb/icloud","models":[{"id":"icloud","label":"iCloud","software":["iPhone / iPad","Mac","Web browser","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/icloud"}]}],"other":[{"brand":"Apple","sourceUrl":"https://support.apple.com/en-gb/109525","models":[{"id":"apple-watch-series12","label":"Apple Watch Series 12","software":["watchOS","Watch app on iPhone"],"sourceUrl":"https://www.apple.com/uk/newsroom/2026/09/introducing-apple-watch-series-12-with-the-all-new-health-sensing-system/","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","releaseDate":"2026-09-18","availabilityNote":"Some announced software features arrive later and depend on region and paired iPhone.","searchAliases":["watch series 12","apple watch 12"],"catalogFeatured":true},{"id":"apple-watch-ultra4","label":"Apple Watch Ultra 4","software":["watchOS","Watch app on iPhone"],"sourceUrl":"https://www.apple.com/apple-watch-ultra-4/","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","availabilityNote":"Hardware is available; some advertised software features are scheduled for later in 2026.","searchAliases":["watch ultra 4","ultra4"],"catalogFeatured":true},{"id":"airpods-5","label":"AirPods 5 (USB-C charging case)","software":["iPhone / iPad","Mac"],"sourceUrl":"https://support.apple.com/en-gb/109525","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["airpods 5","airpods5"],"catalogFeatured":true},{"id":"airpods-5-wireless","label":"AirPods 5 (wireless charging case)","software":["iPhone / iPad","Mac"],"sourceUrl":"https://support.apple.com/en-gb/109525","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["airpods 5 wireless","airpods5 wireless"],"catalogFeatured":true},{"id":"airpods-max2","label":"AirPods Max 2","software":["iPhone / iPad","Mac"],"sourceUrl":"https://support.apple.com/en-gb/109525","releaseYear":2026,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["airpods max 2","airpods max2"],"catalogFeatured":true},{"id":"apple-watch-se3","label":"Apple Watch SE 3","software":["watchOS","Watch app on iPhone"],"sourceUrl":"https://www.apple.com/newsroom/2025/09/apple-introduces-apple-watch-se-3/","releaseYear":2025,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["watch se3","apple watch se 3"],"catalogFeatured":true},{"id":"airpods-pro3","label":"AirPods Pro 3","software":["iPhone / iPad","Mac"],"sourceUrl":"https://support.apple.com/en-gb/109525","releaseYear":2025,"availability":"released","catalogReviewedAt":"2026-09-19","searchAliases":["airpods pro 3","airpods pro3"],"catalogFeatured":true},{"id":"airpods-pro2-usbc","label":"AirPods Pro 2 (USB-C case)","software":["Bluetooth settings","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/109525"},{"id":"airpods-pro2-lightning","label":"AirPods Pro 2 (Lightning case)","software":["Bluetooth settings","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/109525"},{"id":"airpods-3","label":"AirPods 3rd generation","software":["Bluetooth settings","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/109525","searchAliases":["AirPods 3"]},{"id":"airpods-4","label":"AirPods 4","software":["Bluetooth settings","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/109525"},{"id":"airpods-max","label":"AirPods Max (family)","software":["Bluetooth settings","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/109525"},{"id":"apple-watch-se2","label":"Apple Watch SE 2nd generation","software":["watchOS","Watch app on iPhone","Not sure"],"sourceUrl":"https://support.apple.com/en-gb/108056","searchAliases":["Apple Watch SE 2"]}]}]};
const FREE_GUIDES = [{"id":"free-iphone-charge","title":"My iPhone will not charge","categories":["mobile"],"issues":["power"],"brands":["Apple"],"modelIds":["iphone-16","iphone-16-pro","iphone-15","iphone-14","iphone-13","iphone-se3","iphone17","iphoneair","iphone17pro","iphone17promax","iphone17e","iphone18pro","iphone18promax"],"scope":"Basic wired-charging checks for the listed released iPhones. No force-restart button sequence or repair instructions.","sourceTitle":"Apple: If your iPhone will not charge","sourceUrl":"https://support.apple.com/en-gb/108805","reviewedAt":"2026-09-19","steps":[{"id":"first","title":"Check your charging accessories","body":"Look for damage to the cable and adapter. Stop using damaged accessories.","choices":[{"label":"They look undamaged","to":"socket"},{"label":"There is damage or a liquid alert","to":"@support"}]},{"id":"socket","title":"Use a wall socket","body":"Connect your iPhone directly to a compatible charger in a working wall socket. Check the plugs are secure.","choices":[{"label":"Connected","to":"wait"},{"label":"I cannot connect it safely","to":"@support"}]},{"id":"wait","title":"Give it 30 minutes","body":"Leave the iPhone connected for half an hour.","check":"Does it now turn on and show the battery charging?","choices":[{"label":"It turns on and charges","to":"@success"},{"label":"No, or only a battery symbol","to":"spare"}]},{"id":"spare","title":"Try another charging cable","body":"If available, try an undamaged compatible cable and allow another charging period.","choices":[{"label":"It turns on and charges","to":"@success"},{"label":"Still not charging","to":"@support"},{"label":"No spare cable","to":"@support"}]}],"support":"Apple can guide the correct restart for your iPhone or arrange a service. Mention any alert, charging symbol and accessories tested.","additionalSources":[{"title":"Apple: If your iPhone will not charge","url":"https://support.apple.com/en-gb/108805"}]},{"id":"free-ios-wifi","title":"My iPhone or iPad cannot use Wi-Fi","categories":["mobile"],"issues":["connection"],"brands":["Apple"],"modelIds":[],"scope":"General iPhone and iPad Wi-Fi checks. Network settings and saved passwords are kept.","sourceTitle":"Apple: Cannot connect to Wi-Fi","sourceUrl":"https://support.apple.com/en-gb/111786","reviewedAt":"2026-09-19","steps":[{"id":"first","title":"Open Wi-Fi settings","body":"Open Settings → Wi-Fi. Turn Wi-Fi on.","choices":[{"label":"My network is listed","to":"join"},{"label":"My network is missing","to":"range"},{"label":"Wi-Fi is greyed out","to":"@support"}]},{"id":"range","title":"Move nearer the router","body":"Move your device closer to the router and look at the network list again.","choices":[{"label":"My network appears","to":"join"},{"label":"It is still missing","to":"@support"}]},{"id":"join","title":"Join your network","body":"Tap your own network name. If asked, enter its Wi-Fi password on your device.","choices":[{"label":"There is a tick beside it","to":"test"},{"label":"Password rejected","to":"@support"},{"label":"It cannot join","to":"@support"}]},{"id":"test","title":"Check a webpage","body":"Open a website in Safari to check the internet connection.","choices":[{"label":"The page loads","to":"@success"},{"label":"It does not load","to":"compare"}]},{"id":"compare","title":"Try another device","body":"Can another device open a website on this same Wi-Fi?","choices":[{"label":"Yes","to":"@support"},{"label":"No","to":"@support"},{"label":"I cannot check","to":"@support"}]}],"support":"If several devices fail, contact the network owner or internet provider. If only your iPhone or iPad fails, tell Apple the network result or exact error."},{"id":"free-ios-app-crash","title":"An iPhone app keeps closing","categories":["mobile"],"issues":["slow","playback","install","app"],"brands":["Apple"],"modelIds":["iphone-16","iphone-16-pro","iphone-15","iphone-14","iphone-13","iphone17","iphoneair","iphone17pro","iphone17promax","iphone17e","iphone18pro","iphone18promax"],"scope":"For an unresponsive app on the listed released iPhones without a Home button. Closing an app may lose unsaved work.","sourceTitle":"Apple: An app stops responding","sourceUrl":"https://support.apple.com/en-gb/119876","reviewedAt":"2026-09-19","steps":[{"id":"first","title":"Open the app switcher","body":"Swipe up from the bottom edge and pause near the middle. Find the frozen app's preview.","choices":[{"label":"I can see its preview","to":"close"},{"label":"The whole phone is frozen","to":"@support"}]},{"id":"close","title":"Reopen the frozen app","body":"Swipe its preview upwards to close it. Open the app again from the Home Screen.","choices":[{"label":"It works now","to":"@success"},{"label":"It still closes or freezes","to":"update"}]},{"id":"update","title":"Check the app's update","body":"Open the App Store and your profile. Look for App Updates and update this app if offered.","check":"Try the app again after updating.","choices":[{"label":"It works now","to":"@success"},{"label":"Still failing or no update","to":"restart"}]},{"id":"restart","title":"Restart the iPhone","body":"Use your normal power-off controls, then turn the iPhone on again and try the app.","choices":[{"label":"It works now","to":"@success"},{"label":"It still fails","to":"@support"},{"label":"I need help restarting","to":"@support"}]}],"support":"Contact the app developer through its App Store page. Describe the failure and your iOS version. Avoid deleting the app before checking how its data is saved.","additionalSources":[{"title":"Apple: App stops responding","url":"https://support.apple.com/en-gb/119876"},{"title":"Apple: Close an app, iPhone X and later","url":"https://support.apple.com/en-gb/109359"}]},{"id":"free-airpods-connect","title":"My AirPods will not connect","categories":["other"],"issues":["connection","sound"],"brands":["Apple"],"modelIds":["airpods-pro2-usbc","airpods-pro2-lightning","airpods-3","airpods-4"],"scope":"AirPods earbuds connecting to iPhone or iPad. Use the official Apple guide for other supported Apple devices.","sourceTitle":"Apple: AirPods will not connect","sourceUrl":"https://support.apple.com/en-gb/118576","reviewedAt":"2026-09-19","steps":[{"id":"first","title":"Check the listening device","body":"Are you connecting these AirPods to an iPhone or iPad?","choices":[{"label":"Yes","to":"charge"},{"label":"No","to":"@support"}]},{"id":"charge","title":"Check both earbuds charge","body":"Place both AirPods in their case and confirm each is charging.","choices":[{"label":"Both are charging","to":"bluetooth"},{"label":"One or both will not charge","to":"@support"}]},{"id":"bluetooth","title":"Turn Bluetooth on","body":"On your iPhone or iPad, open Settings → Bluetooth. Switch it on.","choices":[{"label":"Bluetooth is on","to":"output"},{"label":"I cannot turn it on","to":"@support"}]},{"id":"output","title":"Choose your AirPods","body":"Open Control Centre's audio output list using the AirPlay button. Select your AirPods if listed and test some audio at a comfortable volume.","choices":[{"label":"I can hear the audio","to":"@success"},{"label":"They are missing or silent","to":"case"}]},{"id":"case","title":"Reopen the case","body":"With both earbuds inside, close the lid for 15 seconds, then reopen it next to your device. Try connecting again.","choices":[{"label":"Connected and audio works","to":"@success"},{"label":"Still not working","to":"@support"}]}],"support":"Follow Apple's pairing instructions for your exact AirPods generation; case controls differ. Tell support whether both earbuds charge and appear in Bluetooth."},{"id":"mac-power","title":"My Mac will not turn on","categories":["laptop","desktop"],"issues":["power"],"scope":"Mac or MacBook; external checks before requesting service.","sourceTitle":"Apple: Mac does not turn on","sourceUrl":"https://support.apple.com/en-us/102623","reviewedAt":"2026-09-19","steps":[{"id":"first","title":"Check the power connection.","body":"Check that the undamaged power cable is secure in the Mac and a working socket. Use a compatible Mac charger.","choices":[{"label":"Ready to try power","to":"start"},{"label":"Something is damaged","to":"@support"}]},{"id":"start","title":"Press the power button normally.","body":"On a MacBook with Touch ID, that is also the power button. If using a separate display, make sure it is powered on.","choices":[{"label":"The Mac starts normally","to":"@success"},{"label":"A symbol or message appears","to":"@support"},{"label":"It remains blank","to":"hold"}]},{"id":"hold","title":"Try a controlled power restart.","body":"This can lose unsaved work. If you are ready, hold the power button for about 10 seconds, release it, then press it normally once.","choices":[{"label":"It starts normally","to":"@success"},{"label":"Still blank","to":"@support"},{"label":"I want to stop here","to":"@support"}]}],"support":"Apple can check whether this is a power, display or startup fault. Describe any light, sound or screen symbol. Do not continue using damaged cables.","softwareMatch":["macOS"],"brands":["Apple"]},{"id":"free-ios-update","title":"My iPhone or iPad needs an update","categories":["mobile"],"brands":["Apple"],"modelIds":[],"issues":["install","slow","app"],"scope":"For released iPhones and iPads running iOS or iPadOS. Checks the update offered to your device; availability varies.","sourceTitle":"Apple: Update your iPhone or iPad","sourceUrl":"https://support.apple.com/en-gb/118575","reviewedAt":"2026-09-19","steps":[{"id":"first","title":"Prepare your device","body":"Check your iCloud or computer backup first. Then connect to power and Wi-Fi.","choices":[{"label":"Ready","to":"check"},{"label":"I need backup help","to":"@support"}]},{"id":"check","title":"Check the offered update","body":"Open Settings → General → Software Update.","choices":[{"label":"An update is available","to":"install"},{"label":"It says up to date","to":"current"},{"label":"There is an error","to":"error"}]},{"id":"install","title":"Install when you are ready","body":"Choose Download and Install, or the install option shown, and follow the device’s instructions. Keep it connected to power.","choices":[{"label":"The update completed","to":"@success"},{"label":"Not enough storage","to":"space"},{"label":"Cannot download or verify","to":"error"},{"label":"It is still installing","to":"wait"}]},{"id":"wait","title":"Let installation finish","body":"The progress bar can move slowly. Keep the device connected to power. Do not interrupt an installation just because it is taking longer than expected.","choices":[{"label":"It finished","to":"@success"},{"label":"I need help with a stalled update","to":"@support"}]},{"id":"space","title":"Check what is taking space","body":"Open Settings → General → iPhone Storage or iPad Storage. Review the recommendations. Keep important files backed up before removing anything.","choices":[{"label":"I have made enough space","to":"check"},{"label":"I need help choosing what to remove","to":"@support"}]},{"id":"error","title":"Check the connection","body":"Try again on Wi-Fi. If checking or downloading still fails, try another trusted Wi-Fi network you are allowed to use.","choices":[{"label":"The update is offered now","to":"install"},{"label":"The error continues","to":"@support"}]},{"id":"current","title":"No update is offered now","body":"Your device has no newer update available in this screen. Older models may not support every new software version.","choices":[{"label":"That answers my question","to":"@success"},{"label":"I expected a newer update","to":"@support"}]}],"support":"Tell Apple the exact model, installed version and error. They can check compatibility or guide a computer update while protecting your data.","softwareMatch":["iOS","iPadOS"],"additionalSources":[{"title":"Apple: If your iPhone or iPad will not update","url":"https://support.apple.com/en-gb/108905"}]},{"id":"free-ios-bluetooth","title":"An accessory will not connect to my iPhone or iPad","categories":["mobile"],"brands":["Apple"],"modelIds":[],"issues":["connection","sound"],"scope":"Basic Bluetooth checks for released iPhones and iPads. Uses each accessory’s own pairing instructions without deleting pairings.","sourceTitle":"Apple: Bluetooth accessory will not connect","sourceUrl":"https://support.apple.com/en-gb/111804","reviewedAt":"2026-09-19","steps":[{"id":"first","title":"Bring the accessory close","body":"Make sure the accessory is charged and on. Keep it close to your iPhone or iPad.","choices":[{"label":"Ready","to":"discover"},{"label":"It will not power on","to":"@support"}]},{"id":"discover","title":"Make it ready to pair","body":"If you have not paired it before, put the accessory in discovery or pairing mode using its instructions. If already paired, turn the accessory off and back on.","choices":[{"label":"It connects now","to":"@success"},{"label":"Still disconnected","to":"permission"},{"label":"I need the accessory instructions","to":"@support"}]},{"id":"permission","title":"Does it use a companion app?","body":"Some accessories connect through their own app.","choices":[{"label":"Yes","to":"allow"},{"label":"No","to":"@support"},{"label":"I am not sure","to":"@support"}]},{"id":"allow","title":"Check the app’s Bluetooth permission","body":"Open Settings → Privacy & Security → Bluetooth. Allow Bluetooth for the accessory’s app, then try connecting in that app.","choices":[{"label":"It works now","to":"@success"},{"label":"Still failing or app missing","to":"@support"}]}],"support":"If Bluetooth is greyed out or no accessories connect, contact Apple. For one failing accessory, ask its maker to confirm compatibility and the correct pairing steps.","softwareMatch":["iOS","iPadOS"]}];
const ADVANCED_GUIDES = [{"id":"iphone-wifi","title":"Find where your iPhone connection stops","categories":["mobile"],"brands":["Apple"],"softwareMatch":["iOS"],"symptoms":["wifi","connection","internet"],"scope":"General iPhone guidance for iOS. Menu appearance can vary; not an exact-model hardware diagnosis.","sourceTitle":"Apple: iPhone Wi-Fi troubleshooting","sourceUrl":"https://support.apple.com/en-us/111786","reviewedAt":"2026-09-19","steps":[{"title":"Read the connection message","body":"Open Settings → Wi-Fi. Look beside your home network without changing any settings.","check":"A blue tick means the phone joined Wi-Fi. A no-internet message means joining alone has not restored internet access.","successLabel":"I can see the status","failureLabel":"My screen is different"},{"title":"Compare another device","body":"Try opening a website on another device using the same home Wi-Fi.","check":"If it also fails, the home connection may be the cause. If it works, continue with the iPhone.","successLabel":"The other device works","failureLabel":"It fails / none available"},{"title":"Try another trusted Wi-Fi network","body":"If available, join a different network you are authorised to use in Settings → Wi-Fi.","check":"Success here points toward the original network. Failure on multiple networks needs further Apple support.","successLabel":"It connects here","failureLabel":"It fails / none available"}],"closing":"If only your home network fails, contact its provider. If no network works, use Apple support."},{"id":"mac-wifi-diagnostics","title":"Read the clues in your Mac’s Wi-Fi","categories":["laptop","desktop"],"brands":["Apple"],"softwareMatch":["macOS"],"symptoms":["wifi","connection","internet"],"scope":"Mac computers using macOS. General Wi-Fi diagnostics; menu names can vary by release.","sourceTitle":"Apple: Mac Wi-Fi troubleshooting","sourceUrl":"https://support.apple.com/en-us/101588","reviewedAt":"2026-09-19","steps":[{"title":"Check the Mac’s connection","body":"Open Wi-Fi in Control Center. Check that your usual network is selected.","check":"A joined network can still lack internet access.","successLabel":"It is connected","failureLabel":"Not connected / unsure"},{"title":"Look for a recommendation","body":"In the Wi-Fi menu, look for Wi-Fi Recommendations. If present, open it and read the suggestion.","check":"No recommendation is normal on some networks. Continue to the diagnostic tool.","successLabel":"Ready for diagnostics","failureLabel":"I need help with a suggestion"},{"title":"Open Wireless Diagnostics","body":"Hold Option while clicking Wi-Fi. Choose Open Wireless Diagnostics and follow the assistant.","check":"Read its findings before changing anything. Keep the result for support.","successLabel":"I have the result","failureLabel":"The tool will not open"},{"title":"Compare a trusted network","body":"If available, connect to a different Wi-Fi network you are allowed to use. Open a familiar website.","check":"If that works, ask the original network provider about the connection.","successLabel":"I tested another network","failureLabel":"No other network available"}],"closing":"Keep the diagnostic result. If multiple networks fail, contact Apple; if only one fails, contact that network’s provider."}];
const BRAND_VISUALS = {"Apple":{"slug":"apple","color":"#000000","sourceUrl":"https://github.com/simple-icons/simple-icons/blob/develop/icons/apple.svg","brandSource":"https://www.apple.com","collection":"Simple Icons (develop)","multicolor":false,"aspectRatio":0.815,"logo":"data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjMDAwMDAwIiByb2xlPSJpbWciIHZpZXdCb3g9IjEuODYgLTAuMzYgMjAuMjggMjQuNzIiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkFwcGxlPC90aXRsZT48cGF0aCBkPSJNMTIuMTUyIDYuODk2Yy0uOTQ4IDAtMi40MTUtMS4wNzgtMy45Ni0xLjA0LTIuMDQuMDI3LTMuOTEgMS4xODMtNC45NjEgMy4wMTQtMi4xMTcgMy42NzUtLjU0NiA5LjEwMyAxLjUxOSAxMi4wOSAxLjAxMyAxLjQ1NCAyLjIwOCAzLjA5IDMuNzkyIDMuMDM5IDEuNTItLjA2NSAyLjA5LS45ODcgMy45MzUtLjk4NyAxLjgzMSAwIDIuMzUuOTg3IDMuOTYuOTQ4IDEuNjM3LS4wMjYgMi42NzYtMS40OCAzLjY3Ni0yLjk0OCAxLjE1Ni0xLjY4OCAxLjYzNi0zLjMyNSAxLjY2Mi0zLjQxNS0uMDM5LS4wMTMtMy4xODItMS4yMjEtMy4yMi00Ljg1Ny0uMDI2LTMuMDQgMi40OC00LjQ5NCAyLjU5Ny00LjU1OS0xLjQyOS0yLjA5LTMuNjIzLTIuMzI0LTQuMzktMi4zNzYtMi0uMTU2LTMuNjc1IDEuMDktNC42MSAxLjA5ek0xNS41MyAzLjgzYy44NDMtMS4wMTIgMS40LTIuNDI3IDEuMjQ1LTMuODMtMS4yMDcuMDUyLTIuNjYyLjgwNS0zLjUzMiAxLjgxOC0uNzguODk2LTEuNDU0IDIuMzM4LTEuMjczIDMuNzE0IDEuMzM4LjEwNCAyLjcxNS0uNjg4IDMuNTU5LTEuNzAxIi8+PC9zdmc+Cg=="}};
const SOFTWARE_VISUALS = {};
const PAID_MODEL_GUIDES = {"iphone18pro":["iphone-wifi"],"iphone18promax":["iphone-wifi"],"iphone17e":["iphone-wifi"],"iphone17":["iphone-wifi"],"iphoneair":["iphone-wifi"],"iphone17pro":["iphone-wifi"],"iphone17promax":["iphone-wifi"],"iphone-16":["iphone-wifi"],"iphone-16-pro":["iphone-wifi"],"iphone-15":["iphone-wifi"],"iphone-14":["iphone-wifi"],"iphone-13":["iphone-wifi"],"iphone-se3":["iphone-wifi"],"macbook-air-m3-13":["mac-wifi-diagnostics"],"macbook-air-m3-15":["mac-wifi-diagnostics"],"macbook-air-m2":["mac-wifi-diagnostics"],"macbook-pro-14-m3":["mac-wifi-diagnostics"],"macbook-pro-16-2023":["mac-wifi-diagnostics"],"macbook-air-m1":["mac-wifi-diagnostics"],"macbook-air-m5-13":["mac-wifi-diagnostics"],"macbook-air-m5-15":["mac-wifi-diagnostics"],"macbook-pro-14-m5-pro-max":["mac-wifi-diagnostics"],"macbook-pro-16-m5-pro-max":["mac-wifi-diagnostics"],"macbook-neo-2026":["mac-wifi-diagnostics"],"mac-mini-m2":["mac-wifi-diagnostics"],"mac-mini-m1":["mac-wifi-diagnostics"],"imac-24-2023-four-ports":["mac-wifi-diagnostics"],"imac-m1-2021-family":["mac-wifi-diagnostics"],"mac-mini-2024-family":["mac-wifi-diagnostics"],"mac-studio-m2-max":["mac-wifi-diagnostics"],"imac-m4-2024-family":["mac-wifi-diagnostics"]};
function suggestTechHelp(input){
 if(typeof input!=='string')return [];
 const q=input.toLowerCase();
 const issue=/charg|power|battery/.test(q)?'power':/wi.?fi|connect|bluetooth|internet/.test(q)?'connection':/sound|audio/.test(q)?'sound':/sign|password|account/.test(q)?'signin':/slow|freez/.test(q)?'slow':null;
 const matches=[['mobile','iPhone or iPad',/iphone|ipad|phone|tablet/],['laptop','MacBook',/macbook|laptop/],['desktop','Mac',/imac|mac mini|mac studio|desktop|computer/],['tv','Apple TV',/apple tv/],['apps','iCloud',/icloud|apple account/],['other','Apple Watch or AirPods',/airpods|apple watch/]];
 return matches.filter(([, ,pattern])=>pattern.test(q)).map(([category,deviceLabel])=>({category,brand:'Apple',deviceLabel,issue,label:deviceLabel+(issue?' · '+issue:' · Get help')}));
}
(() => {
  const root = document.getElementById('little-steps-consumer');
  const nodes = {"start":{"q":"What needs a little help?","detail":"Choose your Apple device or describe the problem.","choices":[["Apple TV","tv_types",false,{"category":"tv","brand":"Apple","deviceLabel":"Apple TV"}],["iPhone & iPad","mobile_types",false,{"category":"mobile","brand":"Apple","deviceLabel":"iPhone & iPad"}],["MacBook","laptop_types",false,{"category":"laptop","brand":"Apple","deviceLabel":"MacBook"}],["Mac desktops","desktop_types",false,{"category":"desktop","brand":"Apple","deviceLabel":"Mac desktops"}],["iCloud","apps_types",false,{"category":"apps","brand":"Apple","deviceLabel":"iCloud"}],["Apple Watch & AirPods","other_types",false,{"category":"other","brand":"Apple","deviceLabel":"Apple Watch & AirPods"}]],"unsure":"choose"},"choose":{"q":"What are you trying to do?","detail":"Pick the Apple device or software you need help with.","choices":[["Apple TV","tv_types",false,{"category":"tv","brand":"Apple","deviceLabel":"Apple TV"}],["iPhone & iPad","mobile_types",false,{"category":"mobile","brand":"Apple","deviceLabel":"iPhone & iPad"}],["MacBook","laptop_types",false,{"category":"laptop","brand":"Apple","deviceLabel":"MacBook"}],["Mac desktops","desktop_types",false,{"category":"desktop","brand":"Apple","deviceLabel":"Mac desktops"}],["iCloud","apps_types",false,{"category":"apps","brand":"Apple","deviceLabel":"iCloud"}],["Apple Watch & AirPods","other_types",false,{"category":"other","brand":"Apple","deviceLabel":"Apple Watch & AirPods"}]]},"premium":{"section":"Full Access","q":"Go further, one step at a time.","detail":"US$49.99 per year for all published advanced guides. Your App Store confirms the local price before purchase.","choices":[["See Full Access","@plan"],["Keep using free help","@back"]]},"success":{"section":"You did it","q":"That’s one less tech problem.","detail":"In the full app, you could save the steps in case this happens again.","choices":[["Help with something else","start"]]},"other_types":{"q":"Choose your device.","choices":[["Apple Watch & AirPods","@route",false,{"category":"other","brand":"Apple"}]]},"hardware_issue":{"q":"What is going wrong?","choices":[["It won’t turn on","power_check"],["Picture or sound","picture_sound"],["It won’t connect","connection_target"],["An app is the problem","apps_types"]],"unsure":"device_details"},"computer_issue":{"q":"What is going wrong?","choices":[["It is slow","slow_scope"],["The screen is blank","screen_check"],["It won’t connect","connection_target"],["It won’t turn on","power_check"]],"unsure":"device_details"},"mobile_issue":{"q":"What is going wrong?","choices":[["Charging or power","power_check"],["It won’t connect","connection_target"],["An app or account","apps_types"],["Screen or sound","picture_sound"]],"unsure":"device_details"},"picture_sound":{"q":"Which part needs help?","choices":[["Sound","sound_where"],["Picture or screen","screen_check"]]},"sound_where":{"q":"Where should the sound come from?","choices":[["Built-in speakers","sound_level"],["Headphones or speaker","audio_issue"]],"unsure":"sound_level"},"sound_level":{"q":"Check the volume and mute.","detail":"Use the volume control for that device. Is it muted or turned all the way down?","choices":[["Yes, I changed it","sound_result"],["No, volume is up","sound_scope"]],"unsure":"device_details"},"sound_result":{"q":"Can you hear it now?","choices":[["Yes, sound is back","success"],["Still no sound","sound_scope"]]},"sound_scope":{"q":"Is sound missing everywhere?","detail":"If possible, try a different app or channel.","choices":[["Only in one app","apps_types"],["Everywhere","device_details"]],"unsure":"device_details"},"audio_issue":{"q":"What happens with the headphones or speaker?","choices":[["It won’t connect","connection_target"],["Connected, but no sound","sound_level"],["It won’t turn on","power_check"]],"unsure":"device_details"},"screen_check":{"q":"Can you see anything on the screen?","detail":"For example, a logo, menu or “no signal” message.","choices":[["A message or logo","screen_message"],["Completely blank","power_check"]],"unsure":"device_details"},"screen_message":{"q":"What is on the screen?","choices":[["“No signal”","signal_source"],["A logo that stays there","device_details"],["Something else","device_details"]]},"signal_source":{"q":"What should the screen be showing?","choices":[["A connected box or console","device_details"],["My computer","device_details"],["An app on the TV","apps_types"]],"unsure":"device_details"},"power_check":{"q":"Do any lights come on?","detail":"Look at the device when you use its normal power button.","choices":[["Yes, there is a light","power_lit"],["No lights at all","power_external"]],"unsure":"device_details"},"power_lit":{"q":"Does anything else happen?","detail":"For example, a sound, a fan or something appearing briefly on screen.","choices":[["Yes","device_details"],["No","device_details"]]},"power_external":{"q":"Is its power cable or charger connected?","detail":"Check only the normal external connection.","choices":[["It was loose; now connected","power_result"],["It is already connected","device_details"],["It uses batteries","device_details"]]},"power_result":{"q":"Does it turn on now?","choices":[["Yes, it works","success"],["Still no power","device_details"]]},"connection_target":{"q":"What are you trying to connect to?","choices":[["Wi-Fi or internet","wifi_scope"],["Bluetooth device","bluetooth_check"],["A screen or cable","device_details"]],"unsure":"device_details"},"bluetooth_check":{"q":"Can you see it in the device list?","detail":"Look at the Bluetooth device list on the phone or computer you are connecting from.","choices":[["Yes, it appears","device_details"],["No, it is missing","device_details"]],"unsure":"device_details"},"wifi_scope":{"q":"Is it one device or several?","detail":"Can another device use the same internet connection?","choices":[["Only one has a problem","wifi_one"],["Several are affected","wifi_all"]],"unsure":"wifi_compare"},"wifi_compare":{"q":"Try another device on the same Wi-Fi.","detail":"Can it open a web page?","choices":[["Yes, that works","wifi_one"],["No, it cannot","wifi_all"],["I cannot check","device_details"]]},"wifi_one":{"q":"What does the affected device show?","choices":[["My network is missing","device_details"],["It asks for a password","device_details"],["Connected, but no internet","device_details"]],"unsure":"device_details"},"wifi_all":{"q":"Are there lights on your router?","detail":"The router is usually the box that provides your home Wi-Fi.","choices":[["Yes","device_details"],["No","router_power"]],"unsure":"device_details"},"router_power":{"q":"Check the router’s power connection.","detail":"If its power cable is loose, connect it normally and allow it time to start.","choices":[["Internet is back","success"],["Still not working","device_details"]]},"slow_scope":{"q":"Is everything slow, or just one thing?","choices":[["One app","apps_types"],["Web pages","wifi_scope"],["Everything","device_details"]],"unsure":"device_details"},"app_issue":{"q":"Where are you stuck?","choices":[["Getting the app","app_install"],["Creating an account","app_setup"],["Signing in","account_screen"],["The app won’t open","app_open"]],"unsure":"app_open"},"app_install":{"q":"Where would you like to use the app?","choices":[["TV","device_details",false,{"deviceLabel":"TV"}],["Phone or tablet","device_details",false,{"deviceLabel":"Phone or tablet"}],["Computer","device_details",false,{"deviceLabel":"Computer"}]]},"app_setup":{"q":"Have you already created an account?","choices":[["Yes, I have an account","account_screen"],["No, this is my first time","device_details"]],"unsure":"device_details"},"account_screen":{"q":"Which screen is asking you to sign in?","choices":[["Inside an app or website","device_details"],["When unlocking my device","device_details"],["I’m not sure","device_details"]]},"app_open":{"q":"What happens when you open the app?","choices":[["It closes again","device_details"],["An error appears","device_details"],["It keeps loading","device_details"]],"unsure":"device_details"},"identify_other":{"q":"Let’s identify it first.","detail":"Go back and type the name printed on the device, or describe what you use it for.","choices":[["Describe it","start"],["Browse categories","start"]]},"device_details":{"q":"Next, match the exact device.","detail":"Choose your device model and software so the next checks match your setup.","choices":[["Review my starting point","@home"],["Try another problem","start"]]},"tv_types":{"q":"Choose your device.","choices":[["Apple TV","@route",false,{"category":"tv","brand":"Apple"}]]},"mobile_types":{"q":"Choose your device.","choices":[["iPhone & iPad","@route",false,{"category":"mobile","brand":"Apple"}]]},"laptop_types":{"q":"Choose your device.","choices":[["MacBook","@route",false,{"category":"laptop","brand":"Apple"}]]},"desktop_types":{"q":"Choose your device.","choices":[["Mac desktops","@route",false,{"category":"desktop","brand":"Apple"}]]},"apps_types":{"q":"Choose your device.","choices":[["iCloud","@route",false,{"category":"apps","brand":"Apple"}]]}};
  // Catalogues and guides are embedded above this controller.
  let current='start', facts={}, selectedCandidate=null, hasFullAccess=false;
  const history=[];
  const savedProfiles=[]; const retainedProfiles=[]; const retainedProgress={};
  let showingMyTech=false;
  const types={tv_types:'tv',mobile_types:'mobile',laptop_types:'laptop',desktop_types:'desktop',printer_types:'printer',apps_types:'apps',other_types:'other'};
  const categoryLabels={"tv":"Apple TV","mobile":"iPhone & iPad","laptop":"MacBook","desktop":"Mac desktops","apps":"iCloud","other":"Apple Watch & AirPods"};
  const generalSoftware={"tv":["tvOS","Not sure"],"mobile":["iOS","iPadOS","Not sure"],"laptop":["macOS","Not sure"],"desktop":["macOS","Not sure"],"apps":["iOS","iPadOS","macOS","Not sure"],"other":["Device settings","Not sure"]};
  const q=root.querySelector('h2'), context=root.querySelector('.th-context'), detail=root.querySelector('.th-detail'), options=root.querySelector('.th-options'), unknown=root.querySelector('.th-unknown'), back=root.querySelector('.th-back'), link=root.querySelector('.th-link'), step=root.querySelector('.th-step');
  const form=root.querySelector('.th-search'), input=root.querySelector('#little-steps-description'), suggestions=root.querySelector('.th-suggestions'), matchStatus=root.querySelector('.th-match-status'), caseLabel=root.querySelector('.th-case'), phoneSurface=root.querySelector('.th-phone');
  const planPanel=root.querySelector('.ls-plan-panel'), guideScope=root.querySelector('.ls-guide-scope'), guideCheck=root.querySelector('.ls-guide-check'), customForm=root.querySelector('.ls-custom-form'), customInput=root.querySelector('#ls-custom-value'), customFeedback=root.querySelector('.ls-custom-feedback'), planButton=root.querySelector('.ls-plan-button'), endPreview=root.querySelector('.ls-end-preview');
  const brandContext=root.querySelector('.ls-brand-context'),upcomingArt=root.querySelector('.ls-upcoming-art');
  const helpPanel=root.querySelector('main'), myTechPanel=root.querySelector('.ls-my-tech'), savedList=root.querySelector('.ls-saved-list'), myTechDescription=root.querySelector('.ls-my-tech-description'), saveDeviceButton=root.querySelector('.ls-save-device'), saveDeviceLabel=saveDeviceButton.querySelector('span'), addDeviceButton=root.querySelector('.ls-add-device');
  const navHelp=root.querySelector('.ls-nav-help'), navTech=root.querySelector('.ls-nav-tech'), restartButton=root.querySelector('.th-restart'), aboutButton=root.querySelector('.ls-about-button'), aboutPanel=root.querySelector('.ls-about-panel'), aboutClose=root.querySelector('.ls-about-close');
  const aboutHelp=root.querySelector('.ls-about-help'), restartConfirm=root.querySelector('.ls-restart-confirm'), restartKeep=root.querySelector('.ls-restart-keep'), restartProceed=root.querySelector('.ls-restart-proceed');
  const wizardPanel=root.querySelector('.ls-device-wizard'), wizardTitle=root.querySelector('.ls-wizard-title'), wizardDescription=root.querySelector('.ls-wizard-description'), wizardStepLabel=root.querySelector('.ls-wizard-step'), wizardOptions=root.querySelector('.ls-wizard-options');
  const wizardBack=root.querySelector('.ls-wizard-back'), wizardCancel=root.querySelector('.ls-wizard-cancel'), wizardCustom=root.querySelector('.ls-wizard-custom'), wizardName=root.querySelector('#ls-device-name'), wizardFeedback=root.querySelector('.ls-wizard-feedback'), wizardReview=root.querySelector('.ls-wizard-review'), wizardNickname=root.querySelector('#ls-device-nickname'), wizardSummary=root.querySelector('.ls-device-summary');
  let deviceDraft=null, deviceStep='category';
  const deviceHistory=[];
  const select=(label,to,patch)=>[label,to,false,patch];
  // Catalogue expansion has its own state; it never adds a troubleshooting step.
  const PRIMARY_BRANDS={"tv":["Apple"],"mobile":["Apple"],"laptop":["Apple"],"desktop":["Apple"],"apps":["Apple"],"other":["Apple"]};
  const catalogPages={help:{brand:{},model:{}},wizard:{brand:{},model:{}}};
  function resetModelPages(scope){catalogPages[scope].model={};}
  function selectionPage(scope,kind,category,brand){
    const groups=TECH_CATALOG[category]||[];
    const primary=PRIMARY_BRANDS[category]||[];
    const records=kind==='brand'
      ?[...primary.map(name=>groups.find(group=>group.brand===name)).filter(Boolean),...groups.filter(group=>!primary.includes(group.brand))]
      :(groups.find(group=>group.brand===brand)?.models||[]);
    const key=kind==='brand'?category:category+'|'+brand;
    const first=kind==='brand'?Math.min(6,records.filter(group=>primary.includes(group.brand)).length)||6:6;
    const shown=Math.min(records.length,catalogPages[scope][kind][key]||first);
    return {scope,kind,key,shown,total:records.length,more:shown<records.length,items:records.slice(0,shown)};
  }
  function appendLoadMore(page,container,refresh){
    if(!page?.more)return;
    const button=document.createElement('button');button.type='button';button.className='ls-load-more cursor-interaction';button.textContent='Load More';
    button.setAttribute('aria-label',page.kind==='brand'?'Load More brands':'Load More models and products');
    button.addEventListener('click',()=>{
      catalogPages[page.scope][page.kind][page.key]=page.shown+6;
      refresh();
      // Keep the viewport in place and keyboard focus on the first new choice.
      container.children[page.shown]?.focus({preventScroll:true});
    });
    container.appendChild(button);
  }
  const brandRecords=()=>TECH_CATALOG[facts.category]||[];
  const brandRecord=()=>brandRecords().find(b=>b.brand.toLowerCase()===(facts.brand||'').toLowerCase());
  const modelRecord=()=>brandRecord()?.models.find(m=>m.id===facts.modelId);
  const selectedGuide=()=>ADVANCED_GUIDES.find(g=>g.id===facts.guideId);
  const guideProgress={}; let lastAdvancedGuide=null;
  const memberPanel=root.querySelector('.ls-member-panel'), advancedProgress=root.querySelector('.ls-advanced-progress'), guideSummary=root.querySelector('.ls-guide-summary'), premiumMenu=root.querySelector('.ls-premium-menu');
  function advancedCaseKey(){return [facts.category,facts.modelId,facts.software,facts.browsing?'browse':'device'].join('|');}
  function currentAdvancedProgress(){const p=guideProgress[facts.guideId];return p&&p.caseKey===advancedCaseKey()?p:null;}
  function rememberAdvanced(answer){
    const g=selectedGuide();if(!hasFullAccess||!g)return;
    let p=currentAdvancedProgress();if(!p)p=guideProgress[g.id]={caseKey:advancedCaseKey(),facts:{...facts},step:0,done:false,events:[]};
    const i=facts.guideStep||0;
    if(answer&&g.steps[i]){p.events[i]={title:g.steps[i].title,answer};p.events.length=i+1;}
    p.step=i;p.facts={...facts};lastAdvancedGuide=g.id;
  }
  function renderPremiumPanels(){
    memberPanel.hidden=current!=='member_home'||!hasFullAccess;
    root.querySelector('.ls-member-count').textContent=String(ADVANCED_GUIDES.length);
    root.querySelector('.ls-member-completed').textContent=String(Object.values(guideProgress).filter(p=>p.done).length);
    premiumMenu.textContent=hasFullAccess?'Your Full Access':'Explore Full Access';
    phoneSurface.classList.toggle('ls-reading-screen',current==='guide_step');
    const g=selectedGuide(),inGuide=hasFullAccess&&g&&['guide_step','guide_result','guide_help','guide_summary'].includes(current);
    advancedProgress.hidden=!inGuide;
    if(inGuide){const finished=current==='guide_result'||currentAdvancedProgress()?.done;const n=finished?g.steps.length:Math.min((facts.guideStep||0)+1,g.steps.length),percent=Math.round((finished?g.steps.length:Math.max(0,facts.guideStep||0))/g.steps.length*100);root.querySelector('.ls-advanced-progress-label').textContent=finished?'All checks reviewed':`Step ${n} of ${g.steps.length}`;const track=root.querySelector('.ls-advanced-track');track.setAttribute('aria-valuenow',String(percent));track.querySelector('span').style.width=percent+'%';}
    guideSummary.replaceChildren();guideSummary.hidden=current!=='guide_summary'||!hasFullAccess;
    if(!guideSummary.hidden){const p=currentAdvancedProgress(),title=document.createElement('h3');title.textContent=g?.title||'Your support summary';guideSummary.appendChild(title);const device=document.createElement('p');device.textContent=facts.browsing?'General guide':describeCase();guideSummary.appendChild(device);const list=document.createElement('ol');for(const event of p?.events||[]){if(!event)continue;const item=document.createElement('li');item.textContent=event.title+' — '+event.answer;list.appendChild(item);}guideSummary.appendChild(list);const note=document.createElement('p');note.textContent=(p?.done?'You reported that the problem is resolved.':'A fix has not been confirmed.')+' Keep this summary to hand when contacting official support. It is saved with your guide progress on this device.';guideSummary.appendChild(note);}
  }

  const normal=s=>String(s||'').toLowerCase().replace(/\bone\s+plus\b/g,'oneplus').replace(/\bhuwaei\b/g,'huawei').replace(/\+/g,' plus ').replace(/[^a-z0-9]+/g,' ').trim();
  // Selection visuals are independent of routing and guide eligibility.
  const categoryArtCells={tv:0,mobile:1,laptop:2,desktop:3,printer:4,wifi:5,apps:6,other:7};
  function brandVisual(name){return BRAND_VISUALS[name]||null;}
  function selectionVisual(name,product){return SOFTWARE_VISUALS[product]||brandVisual(name);}
  function applyBrandTheme(element,name,product){
    const visual=selectionVisual(name,product);
    if(visual?.color)element.style.setProperty('--ls-brand-color',visual.color);
  }
  function createBrandLogo(name,product){
    const visual=selectionVisual(name,product);
    if(!visual?.logo)return null;
    const logo=document.createElement('img');logo.className='ls-brand-logo';logo.src=visual.logo;logo.alt='';logo.setAttribute('aria-hidden','true');logo.setAttribute('draggable','false');if(/^#(?:000000|000|191919)$/i.test(visual.color||''))logo.dataset.monochrome='true';
    if(visual.aspectRatio>2.4)logo.className+=' ls-wordmark-logo';
    return logo;
  }
  // Each viewport uses the measured bounds of one illustration, with no grid assumptions.
  const SPRITE_BOUNDS = {"main":{"width":1000,"height":800,"rects":[[22.825,47.772,170.471,156.15],[225.392,42.068,181.883,155.437],[450.785,39.929,136.947,164.706],[656.919,39.929,128.388,163.993],[852.354,39.216,122.682,165.419],[15.692,231.729,194.722,171.836],[219.686,230.303,199.001,173.262],[423.68,228.877,196.862,173.975],[631.241,217.469,175.464,189.661],[816.69,234.581,174.037,165.419],[19.971,425.668,183.31,160.428],[222.539,422.816,184.736,162.567],[427.247,436.364,173.324,141.889],[623.395,435.651,189.016,149.733],[847.361,441.355,127.675,134.046],[31.384,614.617,151.926,149.733],[215.407,587.522,186.876,183.244],[417.261,633.868,200.428,123.351],[646.22,622.46,149.073,138.324],[824.536,613.191,155.492,154.011]]},"category":{"width":900,"height":450,"rects":[[32.469,51.747,177.565,148.647],[267.362,33.484,156.257,170.97],[467.756,43.123,196.843,175.028],[690.474,44.645,176.043,165.896],[35.513,253.664,171.984,154.735],[257.723,262.289,160.316,140.53],[483.991,250.113,155.75,156.764],[691.995,246.561,187.204,169.448]]},"supplement":{"width":1402,"height":1122,"rects":[[37,53,243,272],[305,96,279,216],[607,87,216,238],[848,83,262,240],[1134,54,242,279],[38,329,243,262],[305,349,278,230],[586,340,228,242],[849,360,244,222],[1133,389,247,202],[49,591,255,254],[329,593,207,249],[540,642,352,181],[916,615,168,211],[1112,649,280,164],[35,884,265,186],[301,906,246,154],[554,837,300,246],[877,831,220,261],[1138,831,230,263]]},"refined":{"width":1536,"height":1024,"rects":[[15,153,536,348],[608,94,355,405],[1072,219,449,266],[19,552,534,395],[646,509,301,456],[1044,681,482,270]]},"latest":{"width":1254,"height":1254,"rects":[[135,80,456,549],[747,121,413,488],[54,742,664,369],[773,711,399,419]]}};
  const MODEL_ART = {"samsung-du8000-55":{"atlas":"main","index":0},"samsung-frame-family":{"atlas":"refined","index":3},"lg-c4-65":{"atlas":"main","index":1},"lg-c3-65":{"atlas":"main","index":1},"sony-bravia-7-family":{"atlas":"main","index":0},"sony-bravia-8-family":{"atlas":"main","index":0},"sony-x90l-family":{"atlas":"main","index":0},"apple-tv-4k-3":{"atlas":"supplement","index":6},"apple-tv-4k-2":{"atlas":"supplement","index":6},"apple-tv-hd":{"atlas":"supplement","index":6},"chromecast-google-tv-4k":{"atlas":"supplement","index":8},"google-tv-streamer-4k":{"atlas":"supplement","index":8},"fire-tv-stick-4k-2":{"atlas":"supplement","index":7},"fire-tv-stick-4k-max-2":{"atlas":"supplement","index":7},"tcl-x11l-2026":{"atlas":"main","index":0},"tcl-qm7l-2026":{"atlas":"main","index":0},"tcl-qm8l-2026":{"atlas":"main","index":0},"iphone-duo":{"atlas":"supplement","index":3},"iphone18pro":{"atlas":"main","index":2},"iphone18promax":{"atlas":"main","index":2},"iphone17e":{"atlas":"main","index":2},"iphone17":{"atlas":"main","index":2},"iphoneair":{"atlas":"main","index":2},"iphone17pro":{"atlas":"main","index":2},"iphone17promax":{"atlas":"main","index":2},"iphone-16":{"atlas":"main","index":2},"iphone-16-pro":{"atlas":"main","index":2},"iphone-15":{"atlas":"main","index":2},"iphone-14":{"atlas":"main","index":2},"iphone-13":{"atlas":"main","index":2},"iphone-se3":{"atlas":"main","index":2},"ipad-10":{"atlas":"supplement","index":0},"ipad-air-m2-11":{"atlas":"supplement","index":0},"ipad-mini-6":{"atlas":"supplement","index":0},"ipad-pro-m4-11":{"atlas":"supplement","index":0},"galaxys26":{"atlas":"main","index":3},"galaxys26plus":{"atlas":"main","index":3},"galaxys26ultra":{"atlas":"main","index":3},"galaxys26fe":{"atlas":"main","index":3},"galaxy-s24":{"atlas":"main","index":3},"galaxy-s24-plus":{"atlas":"main","index":3},"galaxy-tab-s9":{"atlas":"supplement","index":1},"galaxy-tab-s9-plus":{"atlas":"supplement","index":1},"galaxy-tab-s9-ultra":{"atlas":"supplement","index":1},"pixel11":{"atlas":"main","index":4},"pixel11pro":{"atlas":"main","index":4},"pixel11proxl":{"atlas":"main","index":4},"pixel-8":{"atlas":"main","index":4},"pixel-8-pro":{"atlas":"main","index":4},"pixel-7":{"atlas":"main","index":4},"pixel-7-pro":{"atlas":"main","index":4},"pixel-8a":{"atlas":"main","index":4},"pixel-9":{"atlas":"main","index":4},"huawei-pura90s-pro":{"atlas":"supplement","index":19},"huawei-pura90s-pro-max":{"atlas":"supplement","index":19},"huawei-matepad-air-2026":{"atlas":"supplement","index":1},"oneplus-nord6":{"atlas":"supplement","index":18},"oneplus15":{"atlas":"supplement","index":18},"macbook-air-m3-13":{"atlas":"main","index":5},"macbook-air-m3-15":{"atlas":"main","index":5},"macbook-air-m2":{"atlas":"main","index":5},"macbook-pro-14-m3":{"atlas":"main","index":5},"macbook-pro-16-2023":{"atlas":"main","index":5},"macbook-air-m1":{"atlas":"main","index":5},"dell-xps-13-9340":{"atlas":"main","index":6},"dell-inspiron-16-5630":{"atlas":"main","index":6},"thinkpad-t14-g4-intel":{"atlas":"main","index":7},"lenovo-ideapad-family":{"atlas":"main","index":7},"lenovo-yoga-family":{"atlas":"main","index":7},"lenovo-legion-family":{"atlas":"main","index":7},"hp-chromebook-family":{"atlas":"main","index":6},"hp-probook-family":{"atlas":"main","index":6},"samsung-book6-14-2026":{"atlas":"main","index":6},"acer-swift-blade14-2026":{"atlas":"main","index":6},"acer-swift-air16-2026":{"atlas":"main","index":6},"acer-aspire-g3d16-announced":{"atlas":"main","index":6},"asus-proart-p14-h7407":{"atlas":"main","index":7},"asus-proart-p16-h7607":{"atlas":"main","index":7},"mac-mini-m2":{"atlas":"refined","index":5},"mac-mini-m1":{"atlas":"refined","index":5},"imac-24-2023-four-ports":{"atlas":"main","index":8},"imac-m1-2021-family":{"atlas":"main","index":8},"mac-mini-2024-family":{"atlas":"supplement","index":16},"mac-studio-m2-max":{"atlas":"supplement","index":16},"dell-xps-8960":{"atlas":"main","index":9},"dell-optiplex-tower-7010":{"atlas":"main","index":9},"lenovo-ideacentre-family":{"atlas":"main","index":9},"lenovo-thinkcentre-family":{"atlas":"main","index":9},"acer-aspire-s27-2026":{"atlas":"main","index":8},"asus-proart-gr1x":{"atlas":"supplement","index":16},"hp-deskjet-2755e":{"atlas":"main","index":10},"hp-envy-6055e":{"atlas":"main","index":10},"hp-officejet-pro-family":{"atlas":"main","index":12},"hp-laserjet-pro-family":{"atlas":"main","index":12},"canon-pixma-ts3450":{"atlas":"main","index":11},"canon-pixma-ts5350":{"atlas":"main","index":11},"canon-pixma-mg3650":{"atlas":"main","index":11},"brother-hl-l2460dw":{"atlas":"main","index":12},"brother-mfc-j4335dw":{"atlas":"main","index":11},"epson-et-2850":{"atlas":"supplement","index":17},"epson-xp-4200":{"atlas":"main","index":11},"xerox-b230":{"atlas":"main","index":12},"tplink-deco-x50":{"atlas":"refined","index":1},"tplink-deco-m5":{"atlas":"refined","index":2},"tplink-archer-ax55":{"atlas":"main","index":13},"tplink-archer-ax73":{"atlas":"main","index":13},"tplink-re550":{"atlas":"refined","index":4},"tplink-deco-x20":{"atlas":"refined","index":1},"google-nest-wifi-pro":{"atlas":"main","index":14},"google-nest-wifi":{"atlas":"main","index":14},"google-wifi":{"atlas":"refined","index":2},"eero-6":{"atlas":"refined","index":2},"eero-pro-6":{"atlas":"refined","index":2},"netgear-m7-mh7150":{"atlas":"supplement","index":13},"airpods-pro2-usbc":{"atlas":"main","index":15},"airpods-pro2-lightning":{"atlas":"main","index":15},"airpods-3":{"atlas":"main","index":15},"airpods-4":{"atlas":"main","index":15},"airpods-max":{"atlas":"supplement","index":4},"apple-watch-se2":{"atlas":"supplement","index":2},"ps5-family":{"atlas":"main","index":16},"ps4-family":{"atlas":"refined","index":0},"sony-wh1000xm5":{"atlas":"supplement","index":5},"sony-wh1000xm4":{"atlas":"supplement","index":5},"nintendo-switch-family":{"atlas":"main","index":17},"mx-master-3s":{"atlas":"main","index":18},"logitech-mx-keys-s":{"atlas":"supplement","index":12},"google-nest-mini":{"atlas":"supplement","index":9},"xbox-series-x":{"atlas":"supplement","index":10},"xbox-series-s":{"atlas":"supplement","index":11},"jbl-xtreme5":{"atlas":"supplement","index":14},"jbl-go5":{"atlas":"supplement","index":15},"ipad-pro-m5-11":{"atlas":"supplement","index":0},"ipad-air-m4-11":{"atlas":"supplement","index":0},"ipad-pro-m5-13":{"atlas":"supplement","index":0},"ipad-air-m4-13":{"atlas":"supplement","index":0},"ipad-a16":{"atlas":"supplement","index":0},"ipad-mini-a17pro":{"atlas":"supplement","index":0},"apple-watch-series12":{"atlas":"supplement","index":2},"apple-watch-ultra4":{"atlas":"supplement","index":2},"apple-watch-se3":{"atlas":"supplement","index":2},"airpods-5":{"atlas":"main","index":15},"airpods-5-wireless":{"atlas":"main","index":15},"airpods-pro3":{"atlas":"main","index":15},"airpods-max2":{"atlas":"supplement","index":4},"galaxy-z-fold8":{"atlas":"supplement","index":3},"galaxy-z-flip8":{"atlas":"latest","index":0},"galaxy-tab-s11":{"atlas":"supplement","index":1},"galaxy-tab-s11-ultra":{"atlas":"supplement","index":1},"galaxy-watch9":{"atlas":"latest","index":1},"galaxy-watch-ultra2":{"atlas":"latest","index":1},"pixel11profold":{"atlas":"supplement","index":3},"pixel10a":{"atlas":"main","index":4},"pixel-watch5":{"atlas":"latest","index":1},"pixel-buds-pro2":{"atlas":"latest","index":3},"pixel-buds-2a":{"atlas":"latest","index":3},"huawei-nova16s-pro":{"atlas":"supplement","index":19},"huawei-watch6-pro":{"atlas":"latest","index":1},"huawei-matepad-pro12-2026":{"atlas":"supplement","index":1},"oneplus15r":{"atlas":"supplement","index":18},"oneplus-pad4":{"atlas":"supplement","index":1},"macbook-air-m5-13":{"atlas":"main","index":5},"macbook-air-m5-15":{"atlas":"main","index":5},"macbook-pro-14-m5-pro-max":{"atlas":"main","index":5},"macbook-pro-16-m5-pro-max":{"atlas":"main","index":5},"macbook-neo-2026":{"atlas":"main","index":5},"mac-mini-m6-m5-pro-2026":{"atlas":"supplement","index":16},"mac-studio-m5-2026":{"atlas":"supplement","index":16},"imac-m4-2024-family":{"atlas":"main","index":8},"dell-xps-13-dx13260":{"atlas":"main","index":6},"dell-xps-14-da14260":{"atlas":"main","index":6},"dell-xps-16-da16260":{"atlas":"main","index":6},"dell-24-aio-ec24260":{"atlas":"main","index":8},"lenovo-yoga-pro9n-15-g11":{"atlas":"main","index":7},"lenovo-yoga9n-16-g11":{"atlas":"main","index":7},"hp-omnibook-ultra16-spark":{"atlas":"main","index":6},"hp-omnibook-x14-spark":{"atlas":"main","index":6},"hp-omnidesk-spark-announced":{"atlas":"supplement","index":16},"samsung-book6-ultra-2026":{"atlas":"main","index":6},"acer-swift-air14-sfa14-i31":{"atlas":"main","index":6},"asus-zenbook-a16-ux3607":{"atlas":"main","index":6},"samsung-s95h-2026":{"atlas":"main","index":0},"lg-c6-2026":{"atlas":"main","index":1},"lg-g6-2026":{"atlas":"main","index":1},"sony-bravia9-ii-65-2026":{"atlas":"main","index":0},"sony-bravia9-ii-115-announced":{"atlas":"main","index":0},"hp-smart-tank-6000-family":{"atlas":"supplement","index":17},"canon-pixma-g3290":{"atlas":"supplement","index":17},"brother-mfc-t780dw":{"atlas":"main","index":11},"epson-et-4950":{"atlas":"supplement","index":17},"xerox-c325":{"atlas":"main","index":12},"tplink-deco-be95":{"atlas":"refined","index":1},"tplink-archer-be800":{"atlas":"main","index":13},"netgear-orbi-970":{"atlas":"refined","index":1},"netgear-rs700s":{"atlas":"main","index":13},"eero-pro-7":{"atlas":"main","index":14},"eero-7":{"atlas":"main","index":14},"ps5-pro":{"atlas":"main","index":16},"nintendo-switch-2":{"atlas":"latest","index":2},"sony-wh1000xm6":{"atlas":"supplement","index":5},"sony-wf1000xm6":{"atlas":"latest","index":3},"mx-master-4":{"atlas":"main","index":18}};
  const BRAND_ART = {"tv":{"Samsung":{"atlas":"main","index":0},"LG":{"atlas":"main","index":1},"Sony":{"atlas":"main","index":0},"Apple":{"atlas":"supplement","index":6},"Google":{"atlas":"supplement","index":8},"Amazon":{"atlas":"supplement","index":7},"TCL":{"atlas":"main","index":0}},"mobile":{"Apple":{"atlas":"main","index":2},"Samsung":{"atlas":"main","index":3},"Google":{"atlas":"main","index":4},"Huawei":{"atlas":"supplement","index":19},"OnePlus":{"atlas":"supplement","index":18}},"laptop":{"Apple":{"atlas":"main","index":5},"Dell":{"atlas":"main","index":6},"Lenovo":{"atlas":"main","index":7},"HP":{"atlas":"main","index":6},"Samsung":{"atlas":"main","index":6},"Acer":{"atlas":"main","index":6},"ASUS":{"atlas":"main","index":7}},"desktop":{"Apple":{"atlas":"main","index":8},"Dell":{"atlas":"main","index":9},"Lenovo":{"atlas":"main","index":9},"Acer":{"atlas":"main","index":8},"ASUS":{"atlas":"supplement","index":16},"HP":{"atlas":"supplement","index":16}},"printer":{"HP":{"atlas":"main","index":10},"Canon":{"atlas":"main","index":11},"Brother":{"atlas":"main","index":12},"Epson":{"atlas":"supplement","index":17},"Xerox":{"atlas":"main","index":12}},"wifi":{"TP-Link":{"atlas":"main","index":13},"Google":{"atlas":"main","index":14},"Amazon":{"atlas":"refined","index":2},"NETGEAR":{"atlas":"supplement","index":13}},"other":{"Apple":{"atlas":"main","index":15},"Sony":{"atlas":"main","index":16},"Nintendo":{"atlas":"main","index":17},"Logitech":{"atlas":"main","index":18},"Google":{"atlas":"supplement","index":9},"Microsoft":{"atlas":"supplement","index":10},"JBL":{"atlas":"supplement","index":14},"Samsung":{"atlas":"latest","index":1},"Huawei":{"atlas":"latest","index":1}}};
  function createSpriteArt(atlasName,index,maxWidth=96,maxHeight=90){
    const atlas=SPRITE_BOUNDS[atlasName],rect=atlas?.rects[index];
    if(!rect)return null;
    const [x,y,width,height]=rect,scale=Math.min(maxWidth/width,maxHeight/height);
    const art=document.createElement('span');art.className='ls-isolated-art';art.setAttribute('aria-hidden','true');
    const variable={main:'--ls-brand-device-atlas',supplement:'--ls-supplement-atlas',refined:'--ls-refined-atlas',category:'--ls-illustration-atlas',latest:'--ls-latest-atlas'}[atlasName];
    art.style.setProperty('width',`${width*scale}px`);art.style.setProperty('height',`${height*scale}px`);
    art.style.setProperty('background-image',`var(${variable})`);
    art.style.setProperty('background-size',`${atlas.width*scale}px ${atlas.height*scale}px`);
    art.style.setProperty('background-position',`${-x*scale}px ${-y*scale}px`);
    art.dataset.atlas=atlasName;art.dataset.sprite=String(index);
    return art;
  }
  function createCategoryArt(category){return createBrandSelectionArt(category,'Apple');}
  function createNeutralModelArt(icon){
    const symbol=document.createElement('span');symbol.className='ls-model-symbol';symbol.setAttribute('aria-hidden','true');
    const glyph=document.createElement('i');glyph.setAttribute('data-lucide',icon);symbol.appendChild(glyph);return symbol;
  }
  function renderNewIcons(){if(typeof lucide!=='undefined')lucide.createIcons({attrs:{width:16,height:16}});}
  function createBrandSelectionArt(category,name,modelId,product){
    if(category==='apps'){
      const tile=document.createElement('span');tile.className='ls-app-tile';tile.setAttribute('aria-hidden','true');
      const logo=createBrandLogo(name,product);tile.appendChild(logo||createNeutralModelArt('app-window'));
      return tile;
    }
    const scene=document.createElement('span');scene.className='ls-device-scene';scene.setAttribute('aria-hidden','true');
    const logo=createBrandLogo(name);
    if(logo){logo.className+=' ls-logo-backdrop';scene.appendChild(logo);}
    const visual=MODEL_ART[modelId]||BRAND_ART[category]?.[name];
    const art=visual?createSpriteArt(visual.atlas,visual.index):createSpriteArt('category',categoryArtCells[category]);
    const holder=document.createElement('span');holder.className='ls-device-holder';if(art)holder.appendChild(art);scene.appendChild(holder);
    return scene;
  }
  function softwareChoiceBrand(label){
    if(/not sure|another|don.t know/i.test(label))return null;
    // A combined Windows / Mac choice is deliberately not assigned one maker.
    const matches=[];
    if(/\b(?:iOS|iPadOS|macOS|iPhone|iPad|Mac)\b/i.test(label))matches.push('Apple');
    if(/\b(?:Windows|Microsoft)\b/i.test(label))matches.push('Microsoft');
    if(/\b(?:Android|ChromeOS|Google)\b/i.test(label))matches.push('Google');
    if(/\bHP\b/i.test(label))matches.push('HP');
    if(/\bDeco\b/i.test(label))matches.push('TP-Link');
    if(/\bLogi\b/i.test(label))matches.push('Logitech');
    return matches.length===1?matches[0]:null;
  }
  function platformVisualKey(label){
    if(/\bWindows\b/i.test(label))return SOFTWARE_VISUALS['Microsoft Windows']?'Microsoft Windows':'Windows';
    if(/\bAndroid\b/i.test(label))return SOFTWARE_VISUALS['Google Android']?'Google Android':'Android';
    return null;
  }
  function renderBrandContext(){
    brandContext.replaceChildren();
    const name=brandRecord()?.brand;
    brandContext.hidden=!name||current==='start'||current==='catalog_brands'||!!facts.browsing;
    if(brandContext.hidden)return;
    const product=facts.category==='apps'?modelRecord()?.label:null;
    const chip=document.createElement('span');chip.className='ls-brand-chip';applyBrandTheme(chip,name,product);
    const logo=createBrandLogo(name,product);
    if(logo){const badge=document.createElement('span');badge.className='ls-chip-logo';badge.appendChild(logo);chip.appendChild(badge);}
    const label=document.createElement('span');label.textContent=product||name;chip.appendChild(label);brandContext.appendChild(chip);
  }
  const fullAccessActionIcons={
    'Preview Full Access':'sparkles',
    'Your Full Access':'sparkles',
    'Full Access devices':'smartphone',
    'Browse guides':'book-open',
    'Continue with free help':'life-buoy',
    'Restore purchases':'rotate-ccw',
    'Manage subscription':'sliders-horizontal'
  };
  function appendActionIcon(button,label){
    const icon=fullAccessActionIcons[label]||({ '@purchase':'sparkles','@restore':'rotate-ccw','@manage_subscription':'sliders-horizontal' }[button.dataset.action]);if(!icon)return;
    button.classList.add('ls-action-choice');
    const mark=document.createElement('span');mark.className='ls-action-icon';mark.setAttribute('aria-hidden','true');
    const glyph=document.createElement('i');glyph.setAttribute('data-lucide',icon);glyph.setAttribute('aria-hidden','true');mark.appendChild(glyph);button.appendChild(mark);
  }
  function renderChoiceVisual(button,label,to,patch){
    if(current==='paid_catalog'){
      if(to==='@paid_device'&&patch?.modelId){button.className+=' ls-brand-card';applyBrandTheme(button,patch.brand,patch.category==='apps'?patch.modelLabel:null);button.appendChild(createBrandSelectionArt(patch.category,patch.brand,patch.modelId,patch.category==='apps'?patch.modelLabel:null));}
      else button.className+=' ls-neutral-choice ls-paid-browse-action';
      return;
    }
    if(current==='start'){
      if(patch?.category)button.dataset.category=patch.category;
      const art=createCategoryArt(patch?.category);if(art)button.appendChild(art);return;
    }
    const brandChoice=current==='catalog_brands'&&to==='@choose_brand';
    const modelChoice=current==='catalog_models'&&to==='@choose_model';
    if(brandChoice||modelChoice){
      const name=brandChoice?patch.brand:brandRecord()?.brand;
      const product=modelChoice&&facts.category==='apps'?label:null;
      if(name){button.className+=' ls-brand-card';applyBrandTheme(button,name,product);button.appendChild(createBrandSelectionArt(facts.category,name,patch?.modelId,product));}
      return;
    }
    if(current==='catalog_brands'||current==='catalog_models'){button.className+=' ls-neutral-choice';return;}
    const softwareScreen=['catalog_software','software_version','printer_platform','signup'].includes(current);
    const name=softwareScreen?softwareChoiceBrand(label):null;
    const product=softwareScreen?platformVisualKey(label):null;
    if(name&&selectionVisual(name,product)){
      button.className+=' ls-software-choice';applyBrandTheme(button,name,product);
      const logo=createBrandLogo(name,product);
      if(logo){const badge=document.createElement('span');badge.className='ls-platform-badge';badge.setAttribute('aria-hidden','true');badge.appendChild(logo);button.appendChild(badge);}
    }
  }

  function profileModel(profile){
    return (TECH_CATALOG[profile?.category]||[]).find(b=>normal(b.brand)===normal(profile?.brand))?.models.find(m=>m.id===profile?.modelId);
  }
  // Published coverage is explicit per model. The catalogue never grants access.
  let paidCatalogLimit=12;
  function publishedModelGuides(profile,matchSoftware=false){
    const model=profileModel(profile);
    if(!model||model.availability==='coming-soon'||!Array.isArray(model.paidGuideIds))return [];
    return ADVANCED_GUIDES.filter(g=>model.paidGuideIds.includes(g.id)
      &&/^https:\/\//.test(g.sourceUrl||'')&&g.reviewedAt&&g.steps?.length
      &&g.categories.includes(profile.category)
      &&(!g.brands?.length||g.brands.some(b=>normal(b)===normal(profile.brand)))
      &&(!g.modelIds?.length||g.modelIds.includes(profile.modelId))
      &&!g.excludeModelIds?.includes(profile.modelId)
      &&(!matchSoftware||((!g.softwareMatch?.length||g.softwareMatch.some(v=>normal(profile.software).includes(normal(v))))
        &&(!(g.requiresDesktop||g.id==='hp-wireless')||profile.sourcePlatform==='desktop'))));
  }
  function paidCatalogItems(){
    const items=[];
    for(const [category,brands] of Object.entries(TECH_CATALOG))for(const brand of brands)for(const model of brand.models){
      const profile={category,brand:brand.brand,brandSource:brand.sourceUrl,modelId:model.id,modelLabel:model.label,modelSource:model.sourceUrl||brand.sourceUrl};
      const guides=publishedModelGuides(profile);
      if(guides.length)items.push({...profile,paidGuideCount:guides.length});
    }
    return items;
  }
  function appendPaidBadge(button,profile){
    if(!publishedModelGuides(profile).length)return;
    const badge=document.createElement('span');badge.className='ls-paid-badge';badge.textContent='Full Access';badge.dataset.tooltip='Advanced guides available for supported software. Basic checks and saving this device are free.';button.appendChild(badge);
  }
  function isUpcoming(profile){
    const model=profileModel(profile);return model?model.availability==='coming-soon':profile?.planned===true;
  }
  function releaseBadge(model){
    if(model?.availability==='coming-soon')return model.statusLabel||'Coming soon';
    return model?.availability==='released'&&Number(model.releaseYear)===2026?'New · 2026':'';
  }
  function appendReleaseBadge(button,profile){
    appendPaidBadge(button,profile);
    const model=profileModel(profile),label=releaseBadge(model);if(!label)return;
    const badge=document.createElement('span');badge.className='ls-release-badge';badge.textContent=label;badge.dataset.availability=model.availability;button.appendChild(badge);
  }
  function launchDate(value){
    if(!value)return '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(value))return new Date(value+'T12:00:00Z').toLocaleDateString(localeState.code==='en'?'en-GB':localeState.code,{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
    return String(value);
  }
  function launchSummary(profile){
    const model=profileModel(profile);
    return model?.releaseDate?'Planned release: '+launchDate(model.releaseDate):'Release date to be confirmed';
  }
  function upcomingPreview(profile,withDetails=false){
    const model=profileModel(profile),preview=document.createElement('div');preview.className='ls-upcoming-preview';
    applyBrandTheme(preview,profile.brand,profile.category==='apps'?profile.modelLabel:null);
    preview.appendChild(createBrandSelectionArt(profile.category,profile.brand,profile.modelId,profile.category==='apps'?profile.modelLabel:null));
    if(withDetails){
      const copy=document.createElement('div');copy.className='ls-upcoming-copy';
      const date=document.createElement('p');date.className='ls-launch-date';date.textContent=launchSummary(profile);copy.appendChild(date);
      if(model?.availabilityNote){const note=document.createElement('p');note.textContent=model.availabilityNote;copy.appendChild(note);}
      const scope=document.createElement('p');scope.textContent='Launch details only. Troubleshooting is not available yet.';copy.appendChild(scope);
      const url=model?.announcementUrl||model?.sourceUrl;
      if(url&&/^https:\/\//.test(url)){const source=document.createElement('a');source.className='ls-launch-link cursor-interaction';source.href=url;source.target='_blank';source.rel='noopener noreferrer';source.textContent='Official announcement';copy.appendChild(source);}
      preview.appendChild(copy);
    }
    return preview;
  }
  function saveUpcoming(profile){
    storeProfile({...profile,planned:true,catalogComplete:false,software:'Coming soon'});
  }
  function saveDraftUpcoming(){
    if(!isUpcoming(deviceDraft))return;
    saveUpcoming(deviceDraft);deviceDraft=null;deviceHistory.length=0;renderSavedTech();renderSaveDevice();savedList.children[savedList.children.length-1]?.children[0]?.focus({preventScroll:true});revealActiveScreen();
  }

  function profileKey(profile){return [profile.category,normal(profile.brand),profile.modelId||normal(profile.modelLabel)].join('|');}
  function cleanProfile(profile){
    const fresh={};
    for(const key of ['category','brand','brandSource','modelId','modelLabel','modelSource','deviceLabel','software','printingApp','sourcePlatform','sourceDevice','hostDevice','hostSoftware','app','catalogComplete','nickname','planned'])if(profile[key]!==undefined)fresh[key]=profile[key];
    return fresh;
  }
  function storeProfile(profile){
    const fresh=cleanProfile(profile),index=savedProfiles.findIndex(item=>profileKey(item)===profileKey(fresh));
    if(index===-1)savedProfiles.push(fresh);
    else{if(fresh.nickname===undefined)fresh.nickname=savedProfiles[index].nickname;savedProfiles[index]=fresh;}
  }
  function savedProfileMatches(profile){
    const saved=savedProfiles.find(item=>profileKey(item)===profileKey(profile));
    return !!saved&&['software','sourcePlatform','sourceDevice','hostDevice','hostSoftware'].every(key=>saved[key]===profile[key]);
  }
  function renderSaveDevice(){
    saveDeviceButton.hidden=isUpcoming(facts)||!facts.catalogComplete||!facts.modelLabel||!facts.software||!!facts.browsing||current==='start';
    saveDeviceLabel.textContent=savedProfileMatches(facts)?'Saved to My Tech':'Save to My Tech';
  }
  function renderSavedTech(){
    savedList.replaceChildren();
    myTechDescription.textContent='Add your devices for a quicker route to help.';
    addDeviceButton.querySelector('span').textContent='Add device';
    savedProfiles.forEach(profile=>{
      const row=document.createElement('div');row.className='ls-saved-row';
      const button=document.createElement('button');button.type='button';button.className='ls-saved-card ls-saved-open cursor-interaction';applyBrandTheme(button,profile.brand,profile.category==='apps'?profile.modelLabel:null);
      button.appendChild(createBrandSelectionArt(profile.category,profile.brand,profile.modelId,profile.category==='apps'?profile.modelLabel:null));
      const copy=document.createElement('span');copy.className='ls-saved-copy';
      const title=document.createElement('span');title.className='ls-saved-title';title.textContent=profile.nickname||profile.modelLabel;
      const subtitle=document.createElement('span');subtitle.className='ls-saved-subtitle';subtitle.textContent=[profile.brand,profile.nickname?profile.modelLabel:null,isUpcoming(profile)?'Coming soon':profile.software].filter(Boolean).join(' · ');
      const action=document.createElement('span');action.className='ls-saved-action';action.textContent=isUpcoming(profile)?'View launch details':'Troubleshoot';
      copy.appendChild(title);copy.appendChild(subtitle);copy.appendChild(action);button.appendChild(copy);
      button.setAttribute('aria-label',(isUpcoming(profile)?'View launch details for ':'Troubleshoot ')+[profile.nickname,profile.brand,profile.modelLabel].filter(Boolean).join(' · '));
      button.addEventListener('click',()=>{facts=cleanProfile(profile);selectedCandidate=null;history.length=0;current=routeProblem();showMyTech(false);render(true);});
      const remove=document.createElement('button');remove.type='button';remove.className='ls-remove-device ls-saved-remove cursor-interaction';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+profile.modelLabel+' from My Tech');
      remove.addEventListener('click',()=>{const index=savedProfiles.findIndex(item=>profileKey(item)===profileKey(profile));if(index!==-1)savedProfiles.splice(index,1);renderSavedTech();renderSaveDevice();addDeviceButton.focus({preventScroll:true});});
      row.appendChild(button);row.appendChild(remove);savedList.appendChild(row);
    });
    renderDeviceWizard();renderNewIcons();
  }

  function draftBrand(){return (TECH_CATALOG[deviceDraft?.category]||[]).find(b=>b.brand===deviceDraft?.brand);}
  function draftModel(){return draftBrand()?.models.find(m=>m.id===deviceDraft?.modelId);}
  function draftAdvance(next,patch={}){
    if((patch.category&&patch.category!==deviceDraft?.category)||(patch.brand&&patch.brand!==deviceDraft?.brand))resetModelPages('wizard');
    deviceHistory.push({step:deviceStep,draft:{...deviceDraft}});
    deviceDraft={...deviceDraft,...patch};
    if(next==='software'){deviceDraft.planned=isUpcoming(deviceDraft);if(deviceDraft.planned){next='upcoming';deviceDraft.software='Coming soon';deviceDraft.catalogComplete=false;}}
    deviceStep=next;renderDeviceWizard(true);
  }
  function draftChooseSoftware(software){
    if(software==='Windows'){draftAdvance('windows',{software});return;}
    if(deviceDraft.category==='printer'){draftAdvance('printer',{printingApp:software,software:null});return;}
    draftAdvance('review',{software:software==='TV settings'&&deviceDraft.brand==='Samsung'?'Samsung Smart TV':software,catalogComplete:true});
  }
  function wizardChoice(label,action,visual={}){
    const button=document.createElement('button');button.type='button';button.className='th-choice cursor-interaction';
    if(visual.category){button.dataset.category=visual.category;const art=createCategoryArt(visual.category);if(art)button.appendChild(art);}
    else if(visual.brand){button.className+=' ls-brand-card';applyBrandTheme(button,visual.brand,visual.product);button.appendChild(createBrandSelectionArt(deviceDraft.category,visual.brand,visual.modelId,visual.product));}
    else if(visual.neutral)button.className+=' ls-neutral-choice';
    const text=document.createElement('span');text.className='ls-choice-label';text.textContent=label;button.appendChild(text);if(visual.modelId)appendReleaseBadge(button,{category:deviceDraft.category,brand:visual.brand,modelId:visual.modelId});button.addEventListener('click',action);wizardOptions.appendChild(button);
  }
  function renderDeviceWizard(focus=false){
    closeOptionsMenu();
    const active=!!deviceDraft;
    wizardPanel.hidden=!active;
    for(const element of [root.querySelector('.ls-my-tech-title'),myTechDescription,savedList,addDeviceButton,root.querySelector('.ls-save-note')])element.hidden=active;
    if(!active)return;
    wizardOptions.replaceChildren();wizardFeedback.textContent='';wizardCustom.hidden=!['custom_brand','custom_model'].includes(deviceStep);wizardReview.hidden=deviceStep!=='review';
    wizardBack.disabled=!deviceHistory.length;
    wizardOptions.classList.toggle('th-categories',deviceStep==='category');wizardOptions.classList.toggle('ls-brand-options',deviceStep==='brand');wizardOptions.classList.toggle('ls-model-options',deviceStep==='model');wizardOptions.classList.toggle('ls-list-options',['software','windows','printer'].includes(deviceStep));
    const stages={category:'Device type',brand:'Brand',custom_brand:'Brand',model:'Model',custom_model:'Model',software:'Software',windows:'Software',printer:'Printing setup',upcoming:draftModel()?.statusLabel||'Coming soon',review:'Ready to save'};
    wizardStepLabel.textContent='Add device · '+stages[deviceStep];
    const titles={category:'What would you like to add?',brand:'Which brand is it?',model:deviceDraft.category==='apps'?'Which app or service?':'Which model do you have?',software:deviceDraft.category==='printer'?'How do you use this printer?':deviceDraft.category==='apps'?'Where do you use it?':'Which software do you use?',windows:'Which Windows version?',printer:'Where do you print from?',custom_brand:'Enter the brand name.',custom_model:'Enter the model name.',upcoming:deviceDraft.modelLabel,review:'Make it yours.'};
    wizardTitle.textContent=titles[deviceStep];
    wizardDescription.textContent={category:'Choose a device or app to keep close by.',brand:'Pick the name on your device.',model:'Choose yours, or enter a model that is not listed.',software:'Pick the setup you use with this device.',windows:'Choose the version installed on your computer.',printer:'This helps us find the right connection checks.',custom_brand:'Use the name printed on your device or shown in the app.',custom_model:'Look on the label, box or About screen. No serial number needed.',upcoming:'Save this upcoming device for later.',review:'Check the details and give it a familiar name if you like.'}[deviceStep];
    if(deviceStep==='category')Object.entries(categoryLabels).forEach(([category,label])=>wizardChoice(label,()=>draftAdvance('brand',{category}),{category}));
    else if(deviceStep==='brand'){
      const page=selectionPage('wizard','brand',deviceDraft.category);
      page.items.forEach(brand=>wizardChoice(brand.brand,()=>draftAdvance('model',{brand:brand.brand,brandSource:brand.sourceUrl}),{brand:brand.brand}));
      appendLoadMore(page,wizardOptions,()=>renderDeviceWizard(false));
      
      
    }else if(deviceStep==='model'){
      const page=selectionPage('wizard','model',deviceDraft.category,deviceDraft.brand);
      page.items.forEach(model=>wizardChoice(model.label,()=>draftAdvance('software',{modelId:model.id,modelLabel:model.label,modelSource:model.sourceUrl||draftBrand()?.sourceUrl,app:deviceDraft.category==='apps'?model.label:undefined}),{brand:deviceDraft.brand,modelId:model.id,product:deviceDraft.category==='apps'?model.label:null}));
      appendLoadMore(page,wizardOptions,()=>renderDeviceWizard(false));
      wizardChoice('Another model or product',()=>draftAdvance('custom_model'),{neutral:true});
      wizardChoice('I don’t know',()=>draftAdvance('software',{modelId:null,modelLabel:'Model not known'}),{neutral:true});
    }else if(deviceStep==='upcoming'){
      wizardOptions.appendChild(upcomingPreview(deviceDraft,true));
      wizardChoice('Save for later',saveDraftUpcoming);
      wizardChoice('Back to models',()=>draftAdvance('model',{modelId:null,modelLabel:null,software:null,planned:false}));
    }else if(deviceStep==='software'){
      const choices=[...(draftModel()?.software||generalSoftware[deviceDraft.category]||[])];
      if(choices.includes('Windows 11')&&!choices.includes('Windows 10'))choices.splice(choices.indexOf('Windows 11')+1,0,'Windows 10');
      if(!choices.some(s=>/not sure/i.test(s)))choices.push('Not sure');
      choices.forEach(software=>wizardChoice(software,()=>draftChooseSoftware(software)));
    }else if(deviceStep==='windows'){
      ['Windows 11','Windows 10','Windows · version not known'].forEach(software=>wizardChoice(software,()=>draftAdvance('review',{software,catalogComplete:true})));
    }else if(deviceStep==='printer'){
      [['Windows 11','Windows 11','desktop'],['Windows 10','Windows 10','desktop'],['Mac','macOS','desktop'],['Phone or tablet','Mobile print app','mobile'],['Not sure','Not sure',null]].forEach(([label,software,sourcePlatform])=>wizardChoice(label,()=>draftAdvance('review',{software,sourcePlatform,catalogComplete:true})));
    }else if(deviceStep==='custom_brand'||deviceStep==='custom_model'){
      wizardName.value=deviceStep==='custom_brand'?(deviceDraft.brand||''):(deviceDraft.modelLabel||'');
      wizardName.placeholder=deviceStep==='custom_brand'?'e.g. HP':'e.g. ENVY 6055e';
      wizardCustom.querySelector('label').textContent=deviceStep==='custom_brand'?'Brand name':'Model or product name';
    }else if(deviceStep==='review'){
      wizardSummary.replaceChildren();applyBrandTheme(wizardSummary,deviceDraft.brand,deviceDraft.category==='apps'?deviceDraft.modelLabel:null);
      wizardSummary.appendChild(createBrandSelectionArt(deviceDraft.category,deviceDraft.brand,deviceDraft.modelId,deviceDraft.category==='apps'?deviceDraft.modelLabel:null));
      const copy=document.createElement('div');copy.className='ls-summary-copy';const name=document.createElement('strong');name.textContent=deviceDraft.modelLabel;const details=document.createElement('p');details.textContent=[deviceDraft.brand,deviceDraft.software,deviceDraft.printingApp].filter(Boolean).join(' · ');copy.appendChild(name);copy.appendChild(details);wizardSummary.appendChild(copy);
      wizardNickname.value=deviceDraft.nickname||'';
    }
    renderNewIcons();
    if(focus)revealElements(wizardOptions);
    if(focus){(deviceStep==='review'?wizardNickname:!wizardCustom.hidden?wizardName:wizardOptions.children[0]||wizardCancel).focus({preventScroll:true});revealActiveScreen();}
  }
  function revealActiveScreen(){
    phoneSurface.scrollIntoView?.({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  }
  function closeOptionsMenu(focus=false){
    aboutPanel.hidden=true;aboutButton.setAttribute('aria-expanded','false');
    restartConfirm.hidden=true;restartButton.setAttribute('aria-expanded','false');aboutHelp.hidden=false;
    restartButton.hidden=showingMyTech||current==='start';
    if(focus)aboutButton.focus({preventScroll:true});
  }
  function showMyTech(show){
    showingMyTech=show;helpPanel.hidden=show;myTechPanel.hidden=!show;back.hidden=show;step.hidden=show;restartButton.hidden=show||current==='start';
    phoneSurface.classList.toggle('ls-my-tech-screen',show);
    if(show){navTech.setAttribute('aria-current','page');navHelp.removeAttribute('aria-current');renderSavedTech();revealElements(savedList);}
    else{navHelp.setAttribute('aria-current','page');navTech.removeAttribute('aria-current');}
    closeOptionsMenu();
    root.querySelector('.ls-quick-tech').textContent=show?'Get help':'My Tech';
    revealActiveScreen();
  }

  function describeCase(){
    if(facts.browsing)return 'General guide · choose only steps that fit your device';
    let device=facts.modelLabel||facts.deviceLabel||'';
    if(facts.brand&&facts.brand!=='Not sure'&&!normal(device).includes(normal(facts.brand)))device=(facts.brand+' '+device).trim();
    const app=facts.app&&!normal(device).includes(normal(facts.app))?facts.app:'';
    const names=[device,facts.software,app,facts.hostDevice,facts.sourceDevice ? `Printing from ${facts.sourceDevice}` : ''].filter(Boolean);
    return [...new Set(names)].join(' · ');
  }
  function officialSource(){
    const model=modelRecord(),brand=brandRecord();
    const url=model?.sourceUrl||brand?.sourceUrl||facts.modelSource||facts.brandSource;
    return url?['Official product support',url]:null;
  }
  function matchingGuide(){
    return ADVANCED_GUIDES.find(g=>(!g.modelIds?.length||g.modelIds.includes(facts.modelId))&&!g.excludeModelIds?.includes(facts.modelId)&&(!(g.requiresDesktop||g.id==='hp-wireless')||facts.sourcePlatform==='desktop')&&(!facts.connectionKind||facts.connectionKind==='wifi'||g.connectionKinds?.includes(facts.connectionKind))&&g.categories.includes(facts.category)&&(!g.brands.length||g.brands.some(b=>normal(b)===normal(facts.brand)))&&(!g.softwareMatch.length||g.softwareMatch.some(s=>normal(facts.software).includes(normal(s))))&&g.symptoms.includes(facts.issue))||null;
  }
  function capture(){return {current,facts:{...facts}};}
  function catalogEntry(category){
    if(category!==facts.category)resetModelPages('help');
    if(category!==facts.category){
      const previous={...facts};facts={category,issue:previous.issue};
      if(category==='apps'){facts.hostDevice=previous.modelLabel||previous.deviceLabel;facts.hostSoftware=previous.software;}
      if(category==='printer'){facts.sourceDevice=previous.modelLabel||previous.deviceLabel;facts.issue='printing';}
    }
    facts.category=category;
    return 'catalog_brands';
  }
  // Free guide matching is explicit: a known OS/model is required by scoped guides.
  function basicGuideMatches(guide){
    return guide.categories.includes(facts.category)
      &&(!guide.brands?.length||guide.brands.some(b=>normal(b)===normal(facts.brand)))
      &&(!guide.modelIds?.length||guide.modelIds.includes(facts.modelId))
      &&(!guide.excludeModelIds?.includes(facts.modelId))
      &&(!guide.softwareMatch?.length||guide.softwareMatch.some(s=>normal(facts.software).includes(normal(s))));
  }
  function availableBasicGuides(){
    return FREE_GUIDES.filter(basicGuideMatches).sort((a,b)=>Number(b.issues.includes(facts.issue))-Number(a.issues.includes(facts.issue)));
  }
  function selectedBasicGuide(){return FREE_GUIDES.find(g=>g.id===facts.basicGuideId&&basicGuideMatches(g));}
  function routeProblem(){if(isUpcoming(facts))return 'upcoming_model';return facts.catalogComplete&&facts.category?'basic_issues':legacyRouteProblem();}
  function basicNode(){
    const guide=selectedBasicGuide();
    if(current==='basic_issues'){
      const guides=availableBasicGuides();
      return {section:categoryLabels[facts.category]||'Your technology',q:'What is going wrong?',detail:guides.length?'Choose a problem. We’ll work through a few small checks.':'We can start with general checks while we identify the details.',list:true,choices:[...guides.map(g=>select(g.title,'@basic_start',{basicGuideId:g.id})),['Something else','@basic_other'],...(publishedModelGuides(facts,true).length?[['View Full Access guides','@paid_details']]:[])]};
    }
    if(current==='basic_step'){
      const index=guide?.steps.findIndex(s=>s.id===facts.basicStep),s=guide?.steps[index];
      if(!s)return {q:'Let’s choose the right checks.',choices:[['Choose a problem','@basic_issues']]};
      return {section:'Free guided check',q:s.title,detail:s.body,scope:index===0?guide.scope:undefined,check:s.check,list:true,choices:s.choices.map(c=>select(c.label,'@basic_move',{basicNext:c.to})),links:[...(s.links||[]),...(s.id==='manual'&&officialSource()?[{label:'Open your selected product’s official page',url:officialSource()[1]}]:[])],link:[guide.sourceTitle,guide.sourceUrl]};
    }
    if(current==='basic_support'){
      const more=matchingGuide();
      return {section:'Your next step',q:'Let’s get the right help.',detail:guide?.support||'Use the official support for your device with the model name and what you saw.',scope:guide?.scope,list:true,choices:[...(guide?[select('Try these checks again','@basic_start',{basicGuideId:guide.id})]:[]),['Choose another problem','@basic_issues'],...(more?[['See a more detailed guide','@basic_advanced']]:[])].filter(Boolean),links:officialSource()&&officialSource()[1]!==guide?.sourceUrl?[{label:'Your device or app’s official page',url:officialSource()[1]}]:[],link:guide?[guide.sourceTitle,guide.sourceUrl]:officialSource()};
    }
    return null;
  }

  function legacyRouteProblem(){return 'device_details';}
  function advancedEntry(){
    if(!facts.catalogComplete){facts.catalogReturn='advanced';return facts.category?(brandRecord()?'catalog_models':'catalog_brands'):'guide_library';}
    const match=matchingGuide();
    if(match){facts.guideId=match.id;facts.guideStep=0;facts.browsing=false;return 'advanced_intro';}
    delete facts.guideId;delete facts.guideStep;
    return 'guide_gap';
  }
  function catalogMatchCandidates(query){
    query=localizedSearchQuery(query);
    const text=normal(query),base=suggestTechHelp(query),matches=[];
    for(const [category,brands] of Object.entries(TECH_CATALOG))for(const brand of brands)for(const model of brand.models){
      const term=normal(model.label.replace(/\([^)]*\)/g,'').replace(/\bfamily\b/gi,''));
      const shorter=normal(model.label.split('(')[0]);
      const codes=(model.label.match(/\b[A-Za-z]+[0-9][A-Za-z0-9+-]*/g)||[]).filter(c=>c.length>=3).map(normal);
      const codeMatch=codes.some(code=>(' '+text+' ').includes(' '+code+' '));
      const matchedAliases=(model.searchAliases||[]).map(normal).filter(alias=>(' '+text+' ').includes(' '+alias+' ')&&(!['drive','photos','meet'].includes(alias)||text===alias||text.includes('google '+alias)));
      const aliasMatch=matchedAliases.length>0;
      if((term.length<(category==='apps'?3:5)||(!text.includes(term)&&!text.includes(shorter)))&&!codeMatch&&!aliasMatch)continue;
      const original=base.find(c=>c.category===category)||base[0]||{};
      if(original.category==='printer'&&category!=='printer')continue;
      const explicitHardware=/\b(phone|iphone|ipad|tv|television|computer|laptop|desktop|tablet|printer|macbook|android)\b/.test(text);
      if(category==='apps'&&original.category&&original.category!=='apps'&&explicitHardware&&normal(original.app)!==normal(model.label))continue;
      matches.push({...original,category,brand:brand.brand,hostDevice:category==='apps'&&original.category&&original.category!=='apps'?categoryLabels[original.category]:original.hostDevice,deviceLabel:model.label,catalogModelId:model.id,app:category==='apps'?model.label:original.app,label:`${model.label}${original.issue?' · '+original.issue.replace(/-/g,' '):' · Get help'}`,matchLength:Math.max(term.length,...matchedAliases.map(a=>a.length))+(((' '+text+' ').includes(' '+normal(model.label)+' ')||aliasMatch)?1000:0)+((text===normal(model.label)||matchedAliases.includes(text))?10000:0)});
    }
    if(matches.length){const best=Math.max(...matches.map(m=>m.matchLength));return matches.filter(m=>m.matchLength===best).slice(0,3);}
    if(!matches.length){
      const brandMatches=[];
      for(const [category,brands] of Object.entries(TECH_CATALOG))for(const brand of brands){
        if(normal(brand.brand)!==text)continue;
        brandMatches.push({category,brand:brand.brand,deviceLabel:categoryLabels[category],label:brand.brand+' · '+categoryLabels[category]});
      }
      if(brandMatches.length)return brandMatches.slice(0,4);
    }
    return base;
  }
  function acceptSuggestion(){
    facts={...selectedCandidate};
    const brand=brandRecord();
    if(brand)facts.brandSource=brand.sourceUrl;
    if(facts.catalogModelId){
      const m=brand?.models.find(x=>x.id===facts.catalogModelId);
      if(m){facts.modelId=m.id;facts.modelLabel=m.label;facts.modelSource=m.sourceUrl;facts.planned=m.availability==='coming-soon';if(facts.planned){facts.software='Coming soon';facts.catalogComplete=false;}return facts.planned?'upcoming_model':'catalog_software';}
    }
    return brand?'catalog_models':'catalog_brands';
  }
  function dynamicNode(){
    const brand=brandRecord(),model=modelRecord(),guide=selectedGuide();
    if(current==='paid_catalog'){
      const items=paidCatalogItems();
      return {section:'Full Access devices',q:'Extra help for your tech.',detail:items.length+' devices and apps have published advanced guidance. Choose yours to check the supported software. Basic help and My Tech stay free.',list:true,choices:[...items.slice(0,paidCatalogLimit).map(p=>select(p.modelLabel,'@paid_device',p)),...(items.length>paidCatalogLimit?[['Load More','@paid_more']]:[]),['Browse all advanced guides','guide_library'],[hasFullAccess?'Your Full Access':'View Full Access',hasFullAccess?'@member_home':'@plan']]};
    }
    if(current==='paid_device'){
      const guides=publishedModelGuides(facts,true);
      if(isUpcoming(facts))return {section:'Coming soon',q:'Guides are not available yet.',detail:'Save this model for its launch details. Advanced access is not offered for unreleased devices.',choices:[['View launch details','upcoming_model'],['Full Access devices','paid_catalog']]};
      return {section:'Full Access · device coverage',q:facts.modelLabel||'Your device',detail:guides.length?'These published guides match your selected device and software. Read the coverage before opening the advanced steps.':'No published Full Access guide matches this software yet. You can keep using the free checks.',scope:facts.software||'Software not selected',list:true,choices:[...guides.map(g=>select(g.title,'@paid_guide',{guideId:g.id,guideStep:0,browsing:false})),['Continue with free help','@free_checks'],['Change software','@paid_software'],['Full Access devices','paid_catalog']],link:officialSource()};
    }
    if(current==='upcoming_model')return {section:model?.statusLabel||'Coming soon',q:model?.label||facts.modelLabel,detail:model?.availabilityNote||'This device has been officially announced. Save it to My Tech to find its launch details later.',scope:launchSummary(facts),check:'Launch details only. Troubleshooting is not available yet.',list:true,choices:[[savedProfiles.some(p=>profileKey(p)===profileKey(facts))?'Saved for later · view My Tech':'Save for later','@save_upcoming'],['Back to models','catalog_models']],link:(model?.announcementUrl||model?.sourceUrl)?['Official announcement',model.announcementUrl||model.sourceUrl]:null};
    const basic=basicNode();if(basic)return basic;
    if(current==='catalog_brands')return {section:categoryLabels[facts.category]||'Choose your technology',q:facts.category==='apps'?'Who makes the app?':'Which brand do you use?',detail:'Pick a name you recognise.',art:facts.category,catalogPage:selectionPage('help','brand',facts.category),choices:[...selectionPage('help','brand',facts.category).items.map(b=>select(b.brand,'@choose_brand',{brand:b.brand,brandSource:b.sourceUrl}))]};
    if(current==='catalog_models')return {section:facts.brand||'Your device',q:facts.category==='apps'?'Which software or service?':'Which model do you have?',detail:'Choose your model or product family, or enter another one.',list:true,catalogPage:selectionPage('help','model',facts.category,facts.brand),choices:[...selectionPage('help','model',facts.category,facts.brand).items.map(m=>select(m.label,'@choose_model',{modelId:m.id,modelLabel:m.label,modelSource:m.sourceUrl||brand.sourceUrl})),select('Another model or product','catalog_custom',{customKind:'model'}),['Help me find it','catalog_identify'],['I don’t know','@unknown_model']]};
    if(current==='catalog_software'){
      const reported=[...(model?.software||generalSoftware[facts.category]||[])];
      if(!reported.some(x=>/not sure|don't know|don’t know/i.test(x)))reported.push('Not sure');
      return {section:facts.modelLabel||facts.brand,q:facts.category==='printer'?'How do you use this printer?':facts.category==='apps'?'Where do you use it?':'Which software are you using?',detail:'Choose what is installed or what you use with this device.',list:true,choices:reported.map(s=>select(s,'@choose_software',{software:s}))};
    }
    if(current==='software_version')return {section:'Your software',q:'Which Windows version is installed?',detail:'Choose the version on this computer. We’ll only use instructions that match.',choices:[select('Windows 11','@finish_software',{software:'Windows 11'}),select('Windows 10','@finish_software',{software:'Windows 10'}),select('Another / not sure','@finish_software',{software:'Windows · version not known'})]};
    if(current==='printer_platform')return {section:'Printing setup',q:'Where are you sending the print job from?',detail:'This helps us choose the right app and connection checks.',choices:[select('Windows 11','@finish_software',{software:'Windows 11',sourcePlatform:'desktop'}),select('Windows 10','@finish_software',{software:'Windows 10',sourcePlatform:'desktop'}),select('Mac','@finish_software',{software:'macOS',sourcePlatform:'desktop'}),select('Phone or tablet','@finish_software',{software:'Mobile print app',sourcePlatform:'mobile'})]};
    if(current==='catalog_identify')return {section:'Find your model',q:'Look for the model name.',detail:'Check the outside label, the original box, or the device’s About screen. You only need the model name, not a serial number or password.',choices:[select('I found the name','catalog_custom',{customKind:'model'}),['Show listed models','catalog_models'],['Continue without it','@unknown_model']],link:officialSource()};
    if(current==='catalog_custom')return {section:'Your technology',q:facts.customKind==='brand'?'What name can you see?':'Enter the model or product.',detail:'We’ll keep your description. An unlisted name does not mean a detailed guide is available yet.',custom:true,choices:[['Continue without it',facts.customKind==='brand'?'@unknown_brand':'@unknown_model'],['Back to choices','@back']]};
    if(['guide_result','guide_help','guide_summary'].includes(current)&&!hasFullAccess)return {section:'Full Access',q:'Continue with Full Access.',detail:'Open Full Access to continue this advanced guide.',choices:[['See Full Access','@plan'],['Continue with free help','@free_checks']]};
    if(current==='guide_summary')return {section:'Your support summary',q:'Here’s what you’ve checked.',detail:'The answers you chose, ready to refer to if you need more help.',list:true,choices:[['Return to the guide','guide_step'],['Back to your guides','@member_home']],link:guide?[guide.sourceTitle,guide.sourceUrl]:null};
    if(current==='advanced_intro')return {section:'Advanced guide · Full Access',q:guide?.title||'Continue with deeper checks.',detail:'You’ve reached the more detailed steps. See what this guide covers before continuing.',scope:guide?.scope,check:guide?`${guide.steps.length} guided steps · Source reviewed ${guide.reviewedAt}`:'',list:true,choices:[[hasFullAccess?'Open advanced guide':'See Full Access · '+annualPrice(),hasFullAccess?'@guide_start':'@plan',true],['Keep using free help','free_help'],['Browse available guides','guide_library']],link:guide?[guide.sourceTitle,guide.sourceUrl]:officialSource()};
    if(current==='full_access')return {section:'Loop · Full Access',q:'A little more help. A lot more clarity.',detail:guide?`A closer look: ${guide.title}`:`${ADVANCED_GUIDES.length} advanced guides, with clear checks and official sources.`,plan:true,list:true,choices:[[hasFullAccess?'Your Full Access':'Preview Full Access', '@preview_access'],['Full Access devices','paid_catalog'],['Browse guides','guide_library'],['Continue with free help','@free_checks'],['Restore purchases','billing_info'],['Manage subscription','billing_info']]};
    if(current==='member_home')return hasFullAccess?{section:'Your Full Access',q:'Let’s make the next step easier.',detail:'Explore every available advanced guide. Your place is saved on this device.',list:true,choices:[...(lastAdvancedGuide?[['Continue your guide','@guide_resume']]:[]),['Full Access devices','paid_catalog'],['Browse guides','guide_library'],['Continue with free help','@free_checks']]}:{section:'Full Access',q:'Explore Full Access.',detail:'Choose a guide or explore what Full Access includes.',choices:[['See Full Access','@plan']]};
    if(current==='billing_info')return {section:'Full Access',q:'Your subscription is managed by Apple.',detail:'Apple manages purchases and subscriptions. Restore purchases with the Apple Account used to subscribe.',choices:[['Back to the offer','@back'],['Browse guides','guide_library']]};
    if(current==='guide_library')return {section:'Advanced guides',q:'A clearer path forward.',detail:'Choose a guide to see its device coverage and what you will check.',list:true,choices:[...ADVANCED_GUIDES.map(g=>select(g.title,'@browse_guide',{guideId:g.id,guideStep:0,browsing:true})),[hasFullAccess?'Your Full Access':'Explore Full Access',hasFullAccess?'@member_home':'@plan']]};
    if(current==='guide_step'){
      if(!hasFullAccess)return {section:'Full Access',q:'This is an advanced guide.',detail:'View the annual plan to continue.',choices:[['See Full Access','@plan'],['Free help','free_help']]};
      const i=facts.guideStep||0,s=guide?.steps[i];
      if(!s)return {q:'Choose a guide to continue.',choices:[['Browse guides','guide_library']]};
      return {section:`FULL ACCESS · ${i+1} OF ${guide.steps.length}`,q:s.title,detail:s.body,scope:guide.scope,check:s.check,list:true,choices:[[s.successLabel,'@guide_next'],[s.failureLabel,'guide_help'],['Your Full Access','@member_home']],link:[guide.sourceTitle,guide.sourceUrl]};
    }
    if(current==='guide_result')return {section:'Check the result',q:'Is the original problem resolved?',detail:guide?.closing||'Tell us what happened.',choices:[['Yes, it works now','success'],['Only partly / not yet','guide_help'],['View support summary','guide_summary']],link:guide?[guide.sourceTitle,guide.sourceUrl]:null};
    if(current==='guide_help')return {section:'Let’s choose the next step',q:'We haven’t confirmed a fix yet.',detail:guide?.closing||'Use the official support route for your device.',choices:[['Return to the guide','guide_step'],['View support summary','guide_summary'],['Review free checks','@free_checks']],link:guide?[guide.sourceTitle,guide.sourceUrl]:officialSource()};
    if(current==='guide_gap')return {section:'Guide coverage',q:'This detailed guide is still to come.',detail:'We do not yet have an advanced guide that matches this device, software and problem. You can continue with free help.',list:true,choices:[['Review basic checks','@free_checks'],['Browse available advanced guides','guide_library'],['Change model or software','@edit_profile']],link:officialSource()};
    if(current==='free_help')return {section:'Free help',q:'Keep going at your own pace.',detail:'Basic checks and official manufacturer support remain available.',choices:[['Review basic checks','@free_checks'],['Check model or software','@edit_profile'],['Try a different problem','start']],link:officialSource()||(guide?[guide.sourceTitle,guide.sourceUrl]:null)};
    return nodes[current];
  }
  const stepLinks=root.querySelector('.ls-step-links');
  let motionHasRendered=false, lastMotionKey='', lastMotionCount=0;
  const activeMotion=new WeakMap();
  function reducedMotion(){return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;}
  function moveElement(element,frames,settings){
    if(!element?.animate||reducedMotion())return;
    activeMotion.get(element)?.cancel?.();
    const animation=element.animate(frames,{duration:260,easing:'cubic-bezier(.2,.8,.2,1)',...settings});
    if(animation)activeMotion.set(element,animation);
  }
  function revealElements(container,start=0){
    if(!container||reducedMotion())return;
    [...container.children].slice(start).forEach((element,index)=>{
      moveElement(element,[{opacity:.45,transform:'translateY(12px) scale(.98)'},{opacity:1,transform:'translateY(0) scale(1)'}],{delay:Math.min(index,5)*32,duration:300});
    });
  }
  function animateNavigation(requested){
    const key=[current,facts.category,facts.brand,facts.modelId,facts.basicGuideId,facts.basicStep,facts.guideId,facts.guideStep].join('|');
    if(motionHasRendered){
      if(requested||key!==lastMotionKey){
        moveElement(q,[{opacity:.6,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}]);
        if(!detail.hidden)moveElement(detail,[{opacity:.5,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{delay:35});
        revealElements(options);
        if(!planPanel.hidden)moveElement(planPanel,[{opacity:.6,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:340});
        const member=root.querySelector('.ls-member-panel');
        if(member&&!member.hidden)moveElement(member,[{opacity:.6,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:340});
      }else if(options.children.length>lastMotionCount){revealElements(options,Math.max(0,lastMotionCount-1));}
    }
    motionHasRendered=true;lastMotionKey=key;lastMotionCount=options.children.length;
  }
  function prepareIllustrations(){
    if(typeof Image==='undefined'||typeof getComputedStyle==='undefined')return;
    const styles=getComputedStyle(root),names=['--ls-illustration-atlas','--ls-brand-device-atlas','--ls-supplement-atlas','--ls-refined-atlas','--ls-latest-atlas'];
    root.dataset.artLoading='true';
    const pending=names.map(name=>new Promise(resolve=>{
      const value=styles.getPropertyValue(name).trim(),match=value.match(/^url\(["']?(.*?)["']?\)$/);
      if(!match){resolve();return;}
      const image=new Image();image.onload=resolve;image.onerror=resolve;image.src=match[1];
      if(image.complete)resolve();
    }));
    Promise.all(pending).then(()=>{delete root.dataset.artLoading;root.dataset.artReady='true';});
  }

  function render(animate=false){
    closeOptionsMenu();
    const n=dynamicNode();
    if(!n)throw new Error('Unknown screen: '+current);
    q.textContent=current==='start'?'Let’s get your tech working.':n.q;context.textContent=current==='start'?'A little help. A lot simpler.':n.section||'One small step at a time';detail.textContent=current==='start'?'Choose your device. We’ll take it one step at a time.':n.detail||'Choose the answer that feels closest.';
    form.hidden=current!=='start';phoneSurface.classList.toggle('th-home',current==='start');phoneSurface.classList.toggle('ls-plan-screen',!!n.plan);
    const selectionScreen=['catalog_brands','catalog_models','catalog_software','software_version','printer_platform'].includes(current);
    const profileScreen=['catalog_custom','catalog_identify','confirm'].includes(current);
    const billingScreen=['paid_catalog','paid_device','full_access','member_home','billing_info','guide_library','advanced_intro','guide_gap','free_help'].includes(current);
    phoneSurface.style.setProperty('--ls-context-color',brandVisual(brandRecord()?.brand)?.color||'#a9bcfd');
    phoneSurface.classList.toggle('ls-selection-screen',selectionScreen);
    phoneSurface.classList.toggle('ls-troubleshoot-screen',current!=='start'&&!selectionScreen&&!profileScreen&&!billingScreen);
    const description=describeCase();caseLabel.hidden=current==='start'||!description;caseLabel.textContent=description;
    planPanel.hidden=!n.plan;guideScope.hidden=!n.scope;guideScope.textContent=n.scope||'';guideCheck.hidden=!n.check;guideCheck.textContent=n.check||'';
    customForm.hidden=!n.custom;customFeedback.textContent='';
    planButton.textContent=hasFullAccess?'Full Access · active':'Full Access · $49.99/year';endPreview.hidden=!hasFullAccess;
    renderPremiumPanels();
    renderBrandContext();
    upcomingArt.replaceChildren();upcomingArt.hidden=current!=='upcoming_model';if(!upcomingArt.hidden)upcomingArt.appendChild(upcomingPreview(facts));
    renderSaveDevice();
    const modelScreen=current==='catalog_models'||current==='paid_catalog';
    options.replaceChildren();options.classList.toggle('th-categories',current==='start');options.classList.toggle('th-device-options',false);options.classList.toggle('ls-list-options',!!n.list&&!modelScreen);options.classList.toggle('ls-brand-options',current==='catalog_brands');options.classList.toggle('ls-model-options',modelScreen);
    n.choices.forEach(([label,to,premium,patch],index)=>{
      if(n.catalogPage&&index===n.catalogPage.shown)appendLoadMore(n.catalogPage,options,()=>render(false));
      const b=document.createElement('button');b.type='button';b.className='th-choice cursor-interaction';b.dataset.premium=String(!!premium);b.dataset.action=to;
      renderChoiceVisual(b,label,to,patch);appendActionIcon(b,label);if(current==='guide_library'&&patch?.guideId)b.classList.add('ls-guide-library-card');
      const text=document.createElement('span');text.className='ls-choice-label';text.textContent=label;b.appendChild(text);if(current==='guide_library'&&patch?.guideId){const g=ADVANCED_GUIDES.find(x=>x.id===patch.guideId),meta=document.createElement('small');meta.className='ls-guide-meta';meta.textContent=g.steps.length+' steps · '+(g.brands.length?g.brands.join(' / '):g.softwareMatch.join(' / '));text.appendChild(meta);}if((current==='catalog_models'||current==='paid_catalog')&&patch?.modelId)appendReleaseBadge(b,{...facts,...patch});if(current==='paid_catalog'&&patch?.modelId){const meta=document.createElement('small');meta.className='ls-paid-count';meta.textContent=patch.paidGuideCount+' advanced '+(patch.paidGuideCount===1?'guide':'guides');b.appendChild(meta);}b.addEventListener('click',()=>go(to,patch));options.appendChild(b);
    });
    stepLinks.replaceChildren();stepLinks.hidden=!n.links?.length;
    for(const item of n.links||[]){
      if(!/^https:\/\//.test(item.url))continue;
      const action=document.createElement('a');action.className='ls-step-link cursor-interaction';action.textContent=item.label;action.href=item.url;action.target='_blank';action.rel='noopener noreferrer';stepLinks.appendChild(action);
    }
    renderNewIcons();
    unknown.hidden=!n.unsure;link.hidden=!n.link;
    if(n.link){link.textContent=n.link[0];link.href=n.link[1];}else link.removeAttribute('href');
    back.disabled=history.length===0;step.textContent=current==='start'?'One small step at a time':hasFullAccess?'Full Access':`Step ${history.length}`;
    animateNavigation(animate);
    if(animate&&options.children.length){options.children[0].focus({preventScroll:true});revealActiveScreen();}
  }
  function setSymptom(to){
    if(['sound_where','sound_level','sound_scope','audio_issue'].includes(to))facts.issue='sound';
    if(['screen_check','screen_message'].includes(to))facts.issue='screen';
    if(['power_check','power_lit','power_external'].includes(to))facts.issue='power';
    if(['connection_target','wifi_scope','wifi_one','wifi_all','wifi_compare','bluetooth_check'].includes(to))facts.issue='connection';
    if(to.startsWith('wifi_'))facts.connectionKind='wifi';
    if(to==='bluetooth_check')facts.connectionKind='bluetooth';
    if(['printer_from','printer_check','printer_select'].includes(to))facts.issue='printing';
    if(to==='slow_scope')facts.issue='slow';
    if(to==='account_screen'||to==='signin')facts.issue='signin';
    if(to==='app_open')facts.issue='playback';
  }
  function go(to,patch){
    if(current==='guide_step'&&to==='guide_help'&&hasFullAccess)rememberAdvanced(selectedGuide()?.steps[facts.guideStep||0]?.failureLabel);
    if(current==='guide_result'&&hasFullAccess&&['success','guide_help'].includes(to)){const p=currentAdvancedProgress();if(p)p.done=to==='success';}

    if(to==='@paid_more'){paidCatalogLimit+=12;render(false);return;}
    if(to==='@save_upcoming'){if(isUpcoming(facts)){saveUpcoming(facts);showMyTech(true);}return;}
    if(to==='@back'){undo();return;}
    if(to==='start'||to==='@home'){history.length=0;current='start';facts={};selectedCandidate=null;if(to==='start')input.value='';updateSuggestions();render(true);return;}
    history.push(capture());facts={...facts,...patch};
    if(['@choose_brand','@choose_model','@choose_software','@finish_software','@edit_profile'].includes(to)){delete facts.guideId;delete facts.guideStep;facts.browsing=false;}
    if(patch?.sourceDevice){if(/phone|tablet/i.test(patch.sourceDevice))facts.sourcePlatform='mobile';else if(/computer|laptop|mac|windows/i.test(patch.sourceDevice))facts.sourcePlatform='desktop';}
    if(to==='@paid_device'){
      facts={category:patch.category,brand:patch.brand,brandSource:patch.brandSource,modelId:patch.modelId,modelLabel:patch.modelLabel,modelSource:patch.modelSource,catalogReturn:'paid',catalogComplete:false,browsing:false};
      if(facts.category==='apps')facts.app=facts.modelLabel;
      to=isUpcoming(facts)?'upcoming_model':'catalog_software';
    }
    else if(to==='@paid_details')to='paid_device';
    else if(to==='@paid_software'){facts.catalogReturn='paid';facts.catalogComplete=false;delete facts.guideId;delete facts.guideStep;to='catalog_software';}
    else if(to==='@paid_guide'){
      const guide=publishedModelGuides(facts,true).find(g=>g.id===facts.guideId);
      if(guide){facts.issue=guide.symptoms?.[0];facts.browsing=false;to='advanced_intro';}
      else{delete facts.guideId;delete facts.guideStep;to='paid_device';}
    }
    else if(to==='@accept')to=acceptSuggestion();
    else if(types[to])to=catalogEntry(types[to]);
    else if(current==='start'&&to==='wifi_scope')to=catalogEntry('wifi');
    else if(to==='@choose_brand'){resetModelPages('help');facts.modelId=null;facts.modelLabel=null;facts.software=null;facts.planned=false;facts.catalogComplete=false;to='catalog_models';}
    else if(to==='@choose_model'){facts.software=null;facts.catalogComplete=false;facts.planned=isUpcoming(facts);if(facts.category==='apps')facts.app=facts.modelLabel;if(facts.planned)facts.software='Coming soon';to=facts.planned?'upcoming_model':'catalog_software';}
    else if(to==='@unknown_brand'){facts.brand='Not sure';facts.modelId=null;facts.modelLabel=null;to='catalog_models';}
    else if(to==='@unknown_model'){facts.planned=false;facts.modelId=null;facts.modelLabel=(facts.brand&&facts.brand!=='Not sure'?facts.brand+' · ':'')+'model not known';facts.modelSource=null;to='catalog_software';}
    else if(to==='@choose_software'||to==='@finish_software'){
      const s=facts.software||'';
      if(to==='@choose_software'&&s==='Windows')to='software_version';
      else if(to==='@choose_software'&&facts.category==='printer'&&!/not sure/i.test(s))to='printer_platform';
      else if(to==='@choose_software'&&facts.category!=='apps'&&/^(an app on|a streaming app|a game or app)/i.test(s))to=catalogEntry('apps');
      else{
        if(s==='TV settings'&&facts.brand==='Samsung')facts.software='Samsung Smart TV';
        facts.catalogComplete=true;const next=facts.catalogReturn;delete facts.catalogReturn;to=next==='paid'?'paid_device':next==='advanced'?advancedEntry():routeProblem();
      }
    }
    else if(to==='@edit_profile'){facts.catalogComplete=false;to=brandRecord()?'catalog_models':'catalog_brands';if(!facts.category)to='start';}
    else if(to==='@basic_start'){
      const guide=selectedBasicGuide();
      if(guide){facts.basicStep=guide.steps[0].id;facts.issue=guide.issues.includes(facts.issue)?facts.issue:guide.issues[0];delete facts.guideId;delete facts.guideStep;delete facts.basicNext;delete facts.connectionKind;if(guide.connectionKind)facts.connectionKind=guide.connectionKind;to='basic_step';}
      else to='basic_issues';
    }
    else if(to==='@basic_move'){
      const guide=selectedBasicGuide(),next=facts.basicNext;delete facts.basicNext;
      if(next==='@success')to='success';
      else if(next==='@support')to='basic_support';
      else if(next==='@advanced')to=advancedEntry();
      else if(guide?.steps.some(s=>s.id===next)){facts.basicStep=next;to='basic_step';}
      else to='basic_support';
    }
    else if(to==='@basic_issues'){delete facts.basicGuideId;delete facts.basicStep;delete facts.issue;delete facts.connectionKind;to='basic_issues';}
    else if(to==='@basic_other')to=legacyRouteProblem();
    else if(to==='@basic_advanced')to=advancedEntry();
    else if(to==='@route')to=routeProblem();
    else if(to==='@free_checks'){facts.browsing=false;to=facts.category?routeProblem():'start';}
    else if(to==='@plan')to='full_access';
    
    else if(to==='@member_home')to=hasFullAccess?'member_home':'full_access';
    else if(to==='@guide_resume'){const p=guideProgress[lastAdvancedGuide];if(hasFullAccess&&p){facts={...p.facts,guideId:lastAdvancedGuide,guideStep:p.step};to=p.done?'guide_result':'guide_step';}else to=hasFullAccess?'guide_library':'full_access';}
    else if(to==='@browse_guide')to='advanced_intro';
    else if(to==='@guide_start'){const p=currentAdvancedProgress();facts.guideStep=p&&!p.done?p.step:0;if(hasFullAccess){if(p?.done)delete guideProgress[facts.guideId];rememberAdvanced();}to=hasFullAccess?'guide_step':'full_access';}
    else if(to==='@guide_next'){if(!hasFullAccess){to='full_access';}else{rememberAdvanced(selectedGuide()?.steps[facts.guideStep||0]?.successLabel);facts.guideStep=(facts.guideStep||0)+1;to=facts.guideStep<(selectedGuide()?.steps.length||0)?'guide_step':'guide_result';const p=currentAdvancedProgress();if(p)p.step=Math.min(facts.guideStep,selectedGuide().steps.length-1);}}
    else if(to==='device_details')to=facts.catalogComplete?'basic_issues':facts.category?(brandRecord()?'catalog_models':'catalog_brands'):'start';
    else if(['model','premium'].includes(to))to=advancedEntry();
    if(to==='guide_step'&&selectedGuide())facts.guideStep=Math.max(0,Math.min(facts.guideStep||0,selectedGuide().steps.length-1));
    setSymptom(to);current=to;render(true);
  }
  function undo(){if(history.length){const previous=history.pop();current=previous.current;facts=previous.facts;render(true);}}
  function selectCandidate(candidate){selectedCandidate=candidate;nodes.confirm={q:'Is this what you mean?',detail:candidate.label,choices:[["That’s right",'@accept'],['Change it','@home']]};go('confirm');}
  function updateSuggestions(){
    const text=input.value.trim();suggestions.replaceChildren();
    if(text.length<2){matchStatus.textContent='Type a brand, model, app or what went wrong.';return;}
    const matches=catalogMatchCandidates(text);matchStatus.textContent=matches.length?'Suggested starting points — choose the closest.':'I couldn’t identify that yet. Try its name or choose a category above.';
    matches.forEach(candidate=>{const b=document.createElement('button');b.type='button';b.className='th-suggestion cursor-interaction';b.textContent=candidate.label;b.addEventListener('click',()=>selectCandidate(candidate));suggestions.appendChild(b);});
  }
  form.addEventListener('submit',event=>{event.preventDefault();updateSuggestions();});input.addEventListener('input',updateSuggestions);
  customForm.addEventListener('submit',event=>{
    event.preventDefault();const value=customInput.value.trim();
    if(!value){customFeedback.textContent='Enter a name, or choose “Continue without it”.';return;}
    if(facts.customKind==='brand'){
      const known=brandRecords().find(b=>normal(b.brand)===normal(value));
      go('@choose_brand',{brand:known?.brand||value,brandSource:known?.sourceUrl||null});
    }else{
      const known=brandRecord()?.models.find(m=>normal(m.label)===normal(value));
      go('@choose_model',{modelId:known?.id||null,modelLabel:known?.label||value,modelSource:known?.sourceUrl||brandRecord()?.sourceUrl||null});
    }
    customInput.value='';
  });
  unknown.addEventListener('click',()=>{const to=dynamicNode().unsure;if(to)go(to);});
  back.addEventListener('click',undo);
  restartButton.addEventListener('click',()=>{
    if(restartButton.hidden||aboutPanel.hidden)return;
    aboutHelp.hidden=true;restartButton.hidden=true;restartButton.setAttribute('aria-expanded','true');restartConfirm.hidden=false;
    restartKeep.focus({preventScroll:true});
  });
  restartKeep.addEventListener('click',()=>closeOptionsMenu(true));
  restartProceed.addEventListener('click',()=>{
    if(restartConfirm.hidden||aboutPanel.hidden)return;
    closeOptionsMenu();go('start');aboutButton.focus({preventScroll:true});
  });
  navHelp.addEventListener('click',()=>showMyTech(false));
  navTech.addEventListener('click',()=>showMyTech(true));
  root.querySelector('.ls-quick-tech').addEventListener('click',()=>showMyTech(!showingMyTech));
  addDeviceButton.addEventListener('click',()=>{catalogPages.wizard={brand:{},model:{}};deviceDraft={};deviceStep='category';deviceHistory.length=0;renderDeviceWizard(true);});
  wizardBack.addEventListener('click',()=>{
    if(!deviceHistory.length)return;
    const previous=deviceHistory.pop();deviceStep=previous.step;deviceDraft=previous.draft;renderDeviceWizard(true);
  });
  wizardCancel.addEventListener('click',()=>{deviceDraft=null;deviceHistory.length=0;renderSavedTech();addDeviceButton.focus({preventScroll:true});});
  wizardCustom.addEventListener('submit',event=>{
    event.preventDefault();const value=wizardName.value.trim().slice(0,90);
    if(!value){wizardFeedback.textContent='Enter a name to continue, or go back to the choices.';return;}
    if(deviceStep==='custom_brand'){
      const known=(TECH_CATALOG[deviceDraft.category]||[]).find(brand=>normal(brand.brand)===normal(value));
      draftAdvance('model',{brand:known?.brand||value,brandSource:known?.sourceUrl||null});
    }else{
      const known=draftBrand()?.models.find(model=>normal(model.label)===normal(value));
      draftAdvance('software',{modelId:known?.id||null,modelLabel:known?.label||value,modelSource:known?.sourceUrl||draftBrand()?.sourceUrl||null,app:deviceDraft.category==='apps'?(known?.label||value):undefined});
    }
  });
  wizardNickname.addEventListener('input',()=>{if(deviceDraft)deviceDraft.nickname=wizardNickname.value.trim().slice(0,50);});
  wizardReview.addEventListener('submit',event=>{
    event.preventDefault();if(!deviceDraft||deviceStep!=='review')return;
    deviceDraft.nickname=wizardNickname.value.trim().slice(0,50);storeProfile(deviceDraft);deviceDraft=null;deviceHistory.length=0;
    renderSavedTech();renderSaveDevice();savedList.children[savedList.children.length-1]?.children[0]?.focus({preventScroll:true});revealActiveScreen();
  });
  saveDeviceButton.addEventListener('click',()=>{
    if(!facts.catalogComplete||!facts.modelLabel||!facts.software||facts.browsing)return;
    storeProfile(facts);
    renderSaveDevice();
  });
  aboutButton.addEventListener('click',()=>{
    if(!aboutPanel.hidden){closeOptionsMenu(true);return;}
    closeOptionsMenu();aboutPanel.hidden=false;aboutButton.setAttribute('aria-expanded','true');aboutClose.focus({preventScroll:true});moveElement(aboutPanel,[{opacity:.5,transform:'translateY(-8px)'},{opacity:1,transform:'translateY(0)'}]);
  });
  aboutClose.addEventListener('click',()=>closeOptionsMenu(true));
  const closeOptionsOnEscape=event=>{if(event.key==='Escape'&&!aboutPanel.hidden){event.preventDefault?.();closeOptionsMenu(true);}};
  aboutPanel.addEventListener('keydown',closeOptionsOnEscape);
  aboutButton.addEventListener('keydown',closeOptionsOnEscape);
  premiumMenu.addEventListener('click',()=>{showMyTech(false);go(hasFullAccess?'@member_home':'@plan');});
  planButton.addEventListener('click',()=>go('@plan'));
  
  const LS_LANGUAGE_PACK = {"keys":["Language","Search languages","Close","Key controls are translated. Detailed guides are currently in English.","A little help. A lot simpler.","Let’s get your tech working.","Choose your device. We’ll take it one step at a time.","Or tell us in your own words","Type a device, app or what went wrong.","Start","I’m not sure","My Tech","Get help","More options","Back","Cancel","Continue","Load More","TVs & streaming","Phones & tablets","Laptops","Desktop computers","Printers & scanners","Wi-Fi & internet","Apps & accounts","Other technology","Which brand do you use?","Which model do you have?","Which software are you using?","Another / not sure","Another model or product","Help me find it","I don’t know","Your devices.","Add your devices for a quicker route to help.","Add device","Save device","Save to My Tech","Device nickname","(optional)","Saved on this device.","Troubleshoot","Remove","Coming soon","Save for later","View launch details","What is going wrong?","Something else","Full Access","Advanced guides","Browse guides","Restore purchases","Manage subscription","Continue with free help","Start again","Keep troubleshooting","Step","Name on your device","Use name","End demo access","Not sure","Preview Full Access","Your Full Access","Continue your guide","View support summary","Back to your guides","Explore Full Access","Review guide","Check the result","The App Store confirms your local price before purchase."],"languages":[{"code":"en","name":"English","nativeName":"English","dir":"ltr","values":["Language","Search languages","Close","Key controls are translated. Detailed guides are currently in English.","A little help. A lot simpler.","Let’s get your tech working.","Choose your device. We’ll take it one step at a time.","Or tell us in your own words","Type a device, app or what went wrong.","Start","I’m not sure","My Tech","Get help","More options","Back","Cancel","Continue","Load More","TVs & streaming","Phones & tablets","Laptops","Desktop computers","Printers & scanners","Wi-Fi & internet","Apps & accounts","Other technology","Which brand do you use?","Which model do you have?","Which software are you using?","Another / not sure","Another model or product","Help me find it","I don’t know","Your devices.","Add your devices for a quicker route to help.","Add device","Save device","Save to My Tech","Device nickname","(optional)","Saved on this device.","Troubleshoot","Remove","Coming soon","Save for later","View launch details","What is going wrong?","Something else","Full Access","Advanced guides","Browse guides","Restore purchases","Manage subscription","Continue with free help","Start again","Keep troubleshooting","Step","Name on your device","Use name","End demo access","Not sure","Preview Full Access","Your Full Access","Continue your guide","View support summary","Back to your guides","Explore Full Access","Review guide","Check the result","The App Store confirms your local price before purchase."]},{"code":"ar","name":"Arabic","nativeName":"العربية","dir":"rtl","values":["اللغة","البحث عن لغة","إغلاق","عناصر التحكم الأساسية مترجمة. الأدلة التفصيلية متاحة حاليًا باللغة الإنجليزية.","مساعدة بسيطة. استخدام أسهل بكثير.","لنُعِد تشغيل أجهزتك.","اختر جهازك. سنساعدك خطوة بخطوة.","أو أخبرنا بكلماتك","اكتب اسم جهاز أو تطبيق أو صف المشكلة.","ابدأ","لست متأكدًا","أجهزتي","الحصول على مساعدة","المزيد من الخيارات","رجوع","إلغاء","متابعة","تحميل المزيد","التلفزيون والبث","الهواتف والأجهزة اللوحية","أجهزة الكمبيوتر المحمولة","أجهزة الكمبيوتر المكتبية","الطابعات والماسحات الضوئية","Wi-Fi والإنترنت","التطبيقات والحسابات","أجهزة وتقنيات أخرى","ما العلامة التجارية التي تستخدمها؟","ما طراز جهازك؟","ما البرنامج الذي تستخدمه؟","غير ذلك / لست متأكدًا","طراز أو منتج آخر","ساعدني في العثور عليه","لا أعرف","أجهزتك.","أضف أجهزتك للوصول إلى المساعدة بسرعة أكبر.","إضافة جهاز","حفظ الجهاز","حفظ في أجهزتي","اسم مختصر للجهاز","(اختياري)","تم الحفظ لهذه الجلسة.","استكشاف الأخطاء وإصلاحها","إزالة","قريبًا","حفظ لوقت لاحق","عرض تفاصيل الإطلاق","ما المشكلة التي تواجهها؟","شيء آخر","الوصول الكامل","أدلة متقدمة","تصفح الأدلة","استعادة المشتريات","إدارة الاشتراك","المتابعة بالمساعدة المجانية","البدء من جديد","متابعة استكشاف الأخطاء وإصلاحها","خطوة","الاسم الظاهر على جهازك","استخدام الاسم","إنهاء الوصول التجريبي","غير متأكد","معاينة الوصول الكامل","وصولك الكامل","متابعة دليلك","عرض ملخص الدعم","العودة إلى أدلتك","استكشاف الوصول الكامل","مراجعة الدليل","التحقق من النتيجة","للمعاينة فقط. لن تُجرى أي دفعة ولن يُنشأ أي اشتراك."]},{"code":"bn","name":"Bengali","nativeName":"বাংলা","dir":"ltr","values":["ভাষা","ভাষা খুঁজুন","বন্ধ করুন","প্রধান নিয়ন্ত্রণগুলি অনুবাদ করা হয়েছে। বিস্তারিত নির্দেশিকাগুলি আপাতত ইংরেজিতে রয়েছে।","একটু সাহায্য। অনেক সহজ।","চলুন, আপনার ডিভাইসটি চালু করি।","আপনার ডিভাইস বেছে নিন। আমরা এক ধাপ করে এগোব।","অথবা নিজের ভাষায় আমাদের বলুন","ডিভাইস বা অ্যাপের নাম লিখুন, অথবা সমস্যাটি জানান।","শুরু করুন","আমি নিশ্চিত নই","আমার ডিভাইস","সাহায্য নিন","আরও বিকল্প","ফিরে যান","বাতিল করুন","চালিয়ে যান","আরও লোড করুন","টিভি ও স্ট্রিমিং","ফোন ও ট্যাবলেট","ল্যাপটপ","ডেস্কটপ কম্পিউটার","প্রিন্টার ও স্ক্যানার","ওয়াই-ফাই ও ইন্টারনেট","অ্যাপ ও অ্যাকাউন্ট","অন্যান্য প্রযুক্তি","আপনি কোন ব্র্যান্ড ব্যবহার করেন?","আপনার কোন মডেল আছে?","আপনি কোন সফটওয়্যার ব্যবহার করছেন?","অন্য / নিশ্চিত নই","অন্য মডেল বা পণ্য","এটি খুঁজে পেতে সাহায্য করুন","আমি জানি না","আপনার ডিভাইস।","দ্রুত সাহায্য পেতে আপনার ডিভাইস যোগ করুন।","ডিভাইস যোগ করুন","ডিভাইস সংরক্ষণ করুন","আমার ডিভাইসে সংরক্ষণ করুন","ডিভাইসের ডাকনাম","(ঐচ্ছিক)","এই সেশনের জন্য সংরক্ষিত হয়েছে।","সমস্যা সমাধান করুন","সরিয়ে দিন","শীঘ্রই আসছে","পরে দেখার জন্য রাখুন","প্রকাশের বিস্তারিত দেখুন","কী সমস্যা হচ্ছে?","অন্য কিছু","সম্পূর্ণ অ্যাক্সেস","উন্নত নির্দেশিকা","নির্দেশিকা দেখুন","কেনাকাটা পুনরুদ্ধার করুন","সাবস্ক্রিপশন পরিচালনা করুন","বিনামূল্যের সাহায্য নিয়ে এগিয়ে যান","আবার শুরু করুন","সমস্যা সমাধান চালিয়ে যান","ধাপ","আপনার ডিভাইসে লেখা নাম","নাম ব্যবহার করুন","ডেমো অ্যাক্সেস শেষ করুন","নিশ্চিত নই","সম্পূর্ণ অ্যাক্সেসের প্রিভিউ","আপনার সম্পূর্ণ অ্যাক্সেস","আপনার নির্দেশিকা চালিয়ে যান","সহায়তার সারাংশ দেখুন","আপনার নির্দেশিকায় ফিরে যান","সম্পূর্ণ অ্যাক্সেস সম্পর্কে জানুন","নির্দেশিকা পর্যালোচনা করুন","ফলাফল যাচাই করুন","শুধু প্রিভিউ। কোনো অর্থ নেওয়া হবে না বা সাবস্ক্রিপশন চালু হবে না।"]},{"code":"zh-Hans","name":"Chinese (Simplified)","nativeName":"简体中文","dir":"ltr","values":["语言","搜索语言","关闭","主要控件已翻译。详细指南目前仅提供英文版。","一点帮助，轻松许多。","让你的设备恢复正常。","选择你的设备。我们一步一步来。","或者用你自己的话告诉我们","输入设备、应用名称，或描述遇到的问题。","开始","我不确定","我的设备","获取帮助","更多选项","返回","取消","继续","加载更多","电视与流媒体","手机与平板电脑","笔记本电脑","台式电脑","打印机与扫描仪","Wi-Fi 与互联网","应用与账户","其他技术设备","你使用哪个品牌？","你的设备是什么型号？","你正在使用什么软件？","其他／不确定","其他型号或产品","帮我找到它","我不知道","你的设备。","添加设备，更快获得帮助。","添加设备","保存设备","保存到我的设备","设备昵称","（选填）","已保存，仅限本次会话。","排查问题","移除","即将推出","保存以便稍后查看","查看发布详情","遇到了什么问题？","其他问题","完整访问权限","进阶指南","浏览指南","恢复购买","管理订阅","继续获取免费帮助","重新开始","继续排查问题","步骤","设备上显示的名称","使用此名称","结束演示访问","不确定","预览完整访问权限","你的完整访问权限","继续阅读指南","查看支持摘要","返回你的指南","了解完整访问权限","回顾指南","检查结果","仅供预览。不会产生付款或开通订阅。"]},{"code":"zh-Hant","name":"Chinese (Traditional)","nativeName":"繁體中文","dir":"ltr","values":["語言","搜尋語言","關閉","主要控制項已翻譯。詳細指南目前僅提供英文版。","一點幫助，輕鬆許多。","讓你的裝置恢復正常。","選擇你的裝置。我們一步一步來。","或者用你自己的話告訴我們","輸入裝置、應用程式名稱，或描述遇到的問題。","開始","我不確定","我的裝置","取得協助","更多選項","返回","取消","繼續","載入更多","電視與串流","手機與平板電腦","筆記型電腦","桌上型電腦","印表機與掃描器","Wi-Fi 與網際網路","應用程式與帳號","其他科技裝置","你使用哪個品牌？","你的裝置是什麼型號？","你正在使用什麼軟體？","其他／不確定","其他型號或產品","幫我找到它","我不知道","你的裝置。","新增裝置，更快取得協助。","新增裝置","儲存裝置","儲存到我的裝置","裝置暱稱","（選填）","已儲存，僅限本次工作階段。","疑難排解","移除","即將推出","儲存以供稍後查看","查看推出詳情","遇到了什麼問題？","其他問題","完整存取權限","進階指南","瀏覽指南","回復購買項目","管理訂閱","繼續取得免費協助","重新開始","繼續疑難排解","步驟","裝置上顯示的名稱","使用此名稱","結束示範存取","不確定","預覽完整存取權限","你的完整存取權限","繼續閱讀指南","查看支援摘要","返回你的指南","瞭解完整存取權限","回顧指南","檢查結果","僅供預覽。不會產生付款或啟用訂閱。"]},{"code":"cs","name":"Czech","nativeName":"Čeština","dir":"ltr","values":["Jazyk","Hledat jazyky","Zavřít","Hlavní ovládací prvky jsou přeložené. Podrobné návody jsou zatím v angličtině.","Trocha pomoci. Mnohem jednodušší.","Zprovozněme vaše zařízení.","Vyberte zařízení. Projdeme to krok za krokem.","Nebo problém popište vlastními slovy","Zadejte zařízení, aplikaci nebo problém.","Začít","Nejsem si jistý","Moje technika","Získat pomoc","Další možnosti","Zpět","Zrušit","Pokračovat","Načíst další","TV a streamování","Telefony a tablety","Notebooky","Stolní počítače","Tiskárny a skenery","Wi-Fi a internet","Aplikace a účty","Další technika","Jakou značku používáte?","Jaký máte model?","Jaký software používáte?","Jiná / nevím","Jiný model nebo produkt","Pomozte mi ho najít","Nevím","Vaše zařízení.","Přidejte zařízení a získejte pomoc rychleji.","Přidat zařízení","Uložit zařízení","Uložit do Moje technika","Název zařízení","(nepovinné)","Uloženo pro tuto relaci.","Vyřešit problém","Odebrat","Již brzy","Uložit na později","Zobrazit podrobnosti uvedení","Co nefunguje?","Něco jiného","Plný přístup","Pokročilé návody","Procházet návody","Obnovit nákupy","Spravovat předplatné","Pokračovat s bezplatnou pomocí","Začít znovu","Pokračovat v řešení","Krok","Název na zařízení","Použít název","Ukončit ukázkový přístup","Nejsem si jistý","Vyzkoušet plný přístup","Váš plný přístup","Pokračovat v návodu","Zobrazit souhrn podpory","Zpět k návodům","Prozkoumat plný přístup","Prohlédnout návod","Zkontrolovat výsledek","Pouze náhled. Nedochází k platbě ani vytvoření předplatného."]},{"code":"da","name":"Danish","nativeName":"Dansk","dir":"ltr","values":["Sprog","Søg efter sprog","Luk","De vigtigste knapper er oversat. Detaljerede vejledninger er i øjeblikket på engelsk.","Lidt hjælp. Meget enklere.","Lad os få din teknologi til at virke.","Vælg din enhed. Vi tager det trin for trin.","Eller beskriv det med dine egne ord","Skriv en enhed, app eller hvad der gik galt.","Start","Jeg er ikke sikker","Min teknologi","Få hjælp","Flere muligheder","Tilbage","Annuller","Fortsæt","Indlæs flere","TV og streaming","Telefoner og tablets","Bærbare computere","Stationære computere","Printere og scannere","Wi-Fi og internet","Apps og konti","Anden teknologi","Hvilket mærke bruger du?","Hvilken model har du?","Hvilken software bruger du?","Andet / ikke sikker","Anden model eller produkt","Hjælp mig med at finde den","Det ved jeg ikke","Dine enheder.","Tilføj dine enheder for at få hurtigere hjælp.","Tilføj enhed","Gem enhed","Gem i Min teknologi","Enhedens kaldenavn","(valgfrit)","Gemt til denne session.","Fejlfinding","Fjern","Kommer snart","Gem til senere","Se lanceringsoplysninger","Hvad virker ikke?","Noget andet","Fuld adgang","Avancerede vejledninger","Se vejledninger","Gendan køb","Administrer abonnement","Fortsæt med gratis hjælp","Start forfra","Fortsæt fejlfinding","Trin","Navn på din enhed","Brug navn","Afslut demoadgang","Ikke sikker","Prøv Fuld adgang","Din fulde adgang","Fortsæt din vejledning","Se supportoversigt","Tilbage til dine vejledninger","Udforsk Fuld adgang","Gennemgå vejledning","Kontrollér resultatet","Kun forhåndsvisning. Der foretages ingen betaling, og intet abonnement oprettes."]},{"code":"nl","name":"Dutch","nativeName":"Nederlands","dir":"ltr","values":["Taal","Talen zoeken","Sluiten","De belangrijkste bedieningselementen zijn vertaald. Uitgebreide handleidingen zijn in het Engels.","Een beetje hulp. Een stuk eenvoudiger.","Laten we je apparaten weer laten werken.","Kies je apparaat. We doen het stap voor stap.","Of beschrijf het in je eigen woorden","Typ een apparaat, app of wat er misgaat.","Start","Ik weet het niet zeker","Mijn apparaten","Hulp krijgen","Meer opties","Terug","Annuleren","Doorgaan","Meer laden","TV en streaming","Telefoons en tablets","Laptops","Desktopcomputers","Printers en scanners","Wifi en internet","Apps en accounts","Andere apparaten","Welk merk gebruik je?","Welk model heb je?","Welke software gebruik je?","Ander / niet zeker","Ander model of product","Help me zoeken","Ik weet het niet","Jouw apparaten.","Voeg je apparaten toe om sneller hulp te krijgen.","Apparaat toevoegen","Apparaat opslaan","Opslaan in Mijn apparaten","Naam van apparaat","(optioneel)","Opgeslagen voor deze sessie.","Problemen oplossen","Verwijderen","Binnenkort","Bewaren voor later","Lanceringsdetails bekijken","Wat gaat er mis?","Iets anders","Volledige toegang","Uitgebreide handleidingen","Handleidingen bekijken","Aankopen herstellen","Abonnement beheren","Doorgaan met gratis hulp","Opnieuw beginnen","Probleemoplossing voortzetten","Stap","Naam op je apparaat","Naam gebruiken","Demotoegang beëindigen","Niet zeker","Volledige toegang proberen","Jouw volledige toegang","Verder met je handleiding","Hulpoverzicht bekijken","Terug naar je handleidingen","Volledige toegang ontdekken","Handleiding bekijken","Resultaat controleren","Alleen een voorbeeld. Er wordt niets betaald en geen abonnement aangemaakt."]},{"code":"fil","name":"Filipino","nativeName":"Filipino","dir":"ltr","values":["Wika","Maghanap ng wika","Isara","Nakasalin ang mga pangunahing kontrol. Nasa Ingles pa ang mga detalyadong gabay.","Kaunting tulong. Mas madali na.","Paandarin natin ang iyong mga device.","Piliin ang iyong device. Gagawin natin ito nang paisa-isang hakbang.","O ilarawan sa sarili mong mga salita","Maglagay ng device, app o naging problema.","Magsimula","Hindi ako sigurado","Mga device ko","Humingi ng tulong","Iba pang opsyon","Bumalik","Kanselahin","Magpatuloy","Mag-load pa","TV at streaming","Mga telepono at tablet","Mga laptop","Mga desktop computer","Mga printer at scanner","Wi-Fi at internet","Mga app at account","Iba pang teknolohiya","Anong brand ang gamit mo?","Anong modelo ang mayroon ka?","Anong software ang ginagamit mo?","Iba / hindi sigurado","Ibang modelo o produkto","Tulungan akong hanapin","Hindi ko alam","Mga device mo.","Idagdag ang iyong mga device para mas mabilis na makakuha ng tulong.","Magdagdag ng device","I-save ang device","I-save sa Mga device ko","Palayaw ng device","(opsyonal)","Naka-save para sa session na ito.","Ayusin ang problema","Alisin","Malapit na","I-save para sa susunod","Tingnan ang detalye ng paglulunsad","Ano ang problema?","Iba pa","Buong access","Mga advanced na gabay","Tingnan ang mga gabay","Ibalik ang mga binili","Pamahalaan ang subscription","Magpatuloy sa libreng tulong","Magsimula ulit","Ipagpatuloy ang pag-aayos","Hakbang","Pangalan sa iyong device","Gamitin ang pangalan","Tapusin ang demo access","Hindi sigurado","Subukan ang Buong access","Iyong buong access","Ipagpatuloy ang gabay","Tingnan ang buod ng tulong","Bumalik sa mga gabay","Tuklasin ang Buong access","Suriin ang gabay","Tingnan ang resulta","Preview lamang. Walang sisingiling bayad o gagawing subscription."]},{"code":"fi","name":"Finnish","nativeName":"Suomi","dir":"ltr","values":["Kieli","Hae kieliä","Sulje","Tärkeimmät painikkeet on käännetty. Yksityiskohtaiset oppaat ovat toistaiseksi englanniksi.","Hieman apua. Paljon helpompaa.","Laitetaan laitteesi toimimaan.","Valitse laitteesi. Etenemme askel kerrallaan.","Tai kuvaile omin sanoin","Kirjoita laite, sovellus tai ongelma.","Aloita","En ole varma","Omat laitteet","Pyydä apua","Lisää vaihtoehtoja","Takaisin","Peruuta","Jatka","Lataa lisää","TV ja suoratoisto","Puhelimet ja tabletit","Kannettavat tietokoneet","Pöytätietokoneet","Tulostimet ja skannerit","Wi-Fi ja internet","Sovellukset ja tilit","Muut laitteet","Mitä merkkiä käytät?","Mikä malli sinulla on?","Mitä ohjelmistoa käytät?","Muu / en ole varma","Muu malli tai tuote","Auta minua löytämään se","En tiedä","Laitteesi.","Lisää laitteesi, niin saat apua nopeammin.","Lisää laite","Tallenna laite","Tallenna Omiin laitteisiin","Laitteen lempinimi","(valinnainen)","Tallennettu tämän istunnon ajaksi.","Vianmääritys","Poista","Tulossa pian","Tallenna myöhemmäksi","Näytä julkaisutiedot","Mikä ei toimi?","Jokin muu","Täysi käyttöoikeus","Edistyneet oppaat","Selaa oppaita","Palauta ostokset","Hallitse tilausta","Jatka ilmaisella avulla","Aloita alusta","Jatka vianmääritystä","Vaihe","Laitteessa näkyvä nimi","Käytä nimeä","Lopeta demokäyttö","En ole varma","Kokeile täyttä käyttöoikeutta","Täysi käyttöoikeutesi","Jatka opasta","Näytä tuen yhteenveto","Takaisin oppaisiisi","Tutustu täyteen käyttöoikeuteen","Tarkista opas","Tarkista tulos","Vain esikatselu. Maksua ei veloiteta eikä tilausta luoda."]},{"code":"fr","name":"French","nativeName":"Français","dir":"ltr","values":["Langue","Rechercher une langue","Fermer","Les commandes principales sont traduites. Les guides détaillés sont en anglais.","Un peu d’aide. Tout devient plus simple.","Faisons fonctionner vos appareils.","Choisissez votre appareil. Avançons pas à pas.","Ou décrivez le problème avec vos mots","Saisissez un appareil, une appli ou le problème.","Commencer","Je ne sais pas","Mes appareils","Obtenir de l’aide","Plus d’options","Retour","Annuler","Continuer","Afficher plus","TV et streaming","Téléphones et tablettes","Ordinateurs portables","Ordinateurs de bureau","Imprimantes et scanners","Wi-Fi et internet","Applis et comptes","Autres appareils","Quelle marque utilisez-vous ?","Quel modèle avez-vous ?","Quel logiciel utilisez-vous ?","Autre / je ne sais pas","Autre modèle ou produit","Aidez-moi à le trouver","Je ne sais pas","Vos appareils.","Ajoutez vos appareils pour obtenir de l’aide plus vite.","Ajouter un appareil","Enregistrer l’appareil","Ajouter à Mes appareils","Surnom de l’appareil","(facultatif)","Enregistré pour cette session.","Dépanner","Supprimer","Bientôt disponible","Enregistrer pour plus tard","Voir les détails du lancement","Quel est le problème ?","Autre chose","Accès complet","Guides avancés","Parcourir les guides","Restaurer les achats","Gérer l’abonnement","Continuer avec l’aide gratuite","Recommencer","Poursuivre le dépannage","Étape","Nom sur votre appareil","Utiliser ce nom","Terminer l’accès démo","Je ne sais pas","Essayer l’Accès complet","Votre Accès complet","Continuer votre guide","Voir le résumé d’assistance","Revenir à vos guides","Découvrir l’Accès complet","Revoir le guide","Vérifier le résultat","Aperçu uniquement. Aucun paiement ni abonnement n’est créé."]},{"code":"de","name":"German","nativeName":"Deutsch","dir":"ltr","values":["Sprache","Sprachen suchen","Schließen","Die wichtigsten Bedienelemente sind übersetzt. Ausführliche Anleitungen sind derzeit auf Englisch.","Ein wenig Hilfe. Viel einfacher.","Bringen wir deine Technik zum Laufen.","Wähle dein Gerät. Wir gehen Schritt für Schritt vor.","Oder beschreibe es mit eigenen Worten","Gib ein Gerät, eine App oder das Problem ein.","Starten","Ich bin mir nicht sicher","Meine Technik","Hilfe erhalten","Weitere Optionen","Zurück","Abbrechen","Weiter","Mehr laden","TV und Streaming","Handys und Tablets","Laptops","Desktopcomputer","Drucker und Scanner","WLAN und Internet","Apps und Konten","Andere Technik","Welche Marke nutzt du?","Welches Modell hast du?","Welche Software nutzt du?","Andere / nicht sicher","Anderes Modell oder Produkt","Hilf mir bei der Suche","Ich weiß es nicht","Deine Geräte.","Füge deine Geräte hinzu, um schneller Hilfe zu finden.","Gerät hinzufügen","Gerät speichern","In Meine Technik speichern","Gerätename","(optional)","Für diese Sitzung gespeichert.","Probleme beheben","Entfernen","Demnächst","Für später speichern","Details zur Veröffentlichung","Was funktioniert nicht?","Etwas anderes","Vollzugriff","Erweiterte Anleitungen","Anleitungen ansehen","Käufe wiederherstellen","Abo verwalten","Mit kostenloser Hilfe fortfahren","Neu beginnen","Fehlersuche fortsetzen","Schritt","Name auf deinem Gerät","Namen verwenden","Demozugriff beenden","Nicht sicher","Vollzugriff ausprobieren","Dein Vollzugriff","Anleitung fortsetzen","Hilfeübersicht anzeigen","Zurück zu deinen Anleitungen","Vollzugriff entdecken","Anleitung durchsehen","Ergebnis prüfen","Nur Vorschau. Es erfolgt keine Zahlung und kein Aboabschluss."]},{"code":"el","name":"Greek","nativeName":"Ελληνικά","dir":"ltr","values":["Γλώσσα","Αναζήτηση γλωσσών","Κλείσιμο","Τα βασικά στοιχεία ελέγχου έχουν μεταφραστεί. Οι αναλυτικοί οδηγοί είναι προς το παρόν στα αγγλικά.","Λίγη βοήθεια. Πολύ πιο απλά.","Ας κάνουμε τις συσκευές σας να λειτουργούν.","Επιλέξτε συσκευή. Θα προχωρήσουμε βήμα βήμα.","Ή περιγράψτε το με δικά σας λόγια","Γράψτε μια συσκευή, εφαρμογή ή το πρόβλημα.","Έναρξη","Δεν είμαι σίγουρος","Οι συσκευές μου","Λήψη βοήθειας","Περισσότερες επιλογές","Πίσω","Ακύρωση","Συνέχεια","Φόρτωση περισσότερων","TV και streaming","Τηλέφωνα και tablet","Φορητοί υπολογιστές","Επιτραπέζιοι υπολογιστές","Εκτυπωτές και σαρωτές","Wi-Fi και διαδίκτυο","Εφαρμογές και λογαριασμοί","Άλλες συσκευές","Ποια μάρκα χρησιμοποιείτε;","Ποιο μοντέλο έχετε;","Ποιο λογισμικό χρησιμοποιείτε;","Άλλη / δεν είμαι σίγουρος","Άλλο μοντέλο ή προϊόν","Βοηθήστε με να το βρω","Δεν γνωρίζω","Οι συσκευές σας.","Προσθέστε τις συσκευές σας για γρηγορότερη βοήθεια.","Προσθήκη συσκευής","Αποθήκευση συσκευής","Αποθήκευση στις συσκευές μου","Όνομα συσκευής","(προαιρετικό)","Αποθηκεύτηκε για αυτή τη συνεδρία.","Αντιμετώπιση προβλημάτων","Αφαίρεση","Σύντομα διαθέσιμο","Αποθήκευση για αργότερα","Λεπτομέρειες κυκλοφορίας","Ποιο είναι το πρόβλημα;","Κάτι άλλο","Πλήρης πρόσβαση","Προχωρημένοι οδηγοί","Περιήγηση στους οδηγούς","Επαναφορά αγορών","Διαχείριση συνδρομής","Συνέχεια με δωρεάν βοήθεια","Νέα αρχή","Συνέχεια αντιμετώπισης","Βήμα","Όνομα στη συσκευή σας","Χρήση ονόματος","Τέλος δοκιμαστικής πρόσβασης","Δεν είμαι σίγουρος","Δοκιμή πλήρους πρόσβασης","Η πλήρης πρόσβασή σας","Συνέχεια του οδηγού σας","Προβολή σύνοψης υποστήριξης","Πίσω στους οδηγούς σας","Εξερεύνηση πλήρους πρόσβασης","Επισκόπηση οδηγού","Έλεγχος αποτελέσματος","Μόνο προεπισκόπηση. Δεν γίνεται πληρωμή ούτε δημιουργείται συνδρομή."]},{"code":"gu","name":"Gujarati","nativeName":"ગુજરાતી","dir":"ltr","values":["ભાષા","ભાષાઓ શોધો","બંધ કરો","મુખ્ય નિયંત્રણોનો અનુવાદ કરવામાં આવ્યો છે. વિગતવાર માર્ગદર્શિકાઓ હાલમાં અંગ્રેજીમાં છે.","થોડી મદદ. ઘણું સરળ.","ચાલો, તમારું ઉપકરણ ચાલુ કરીએ.","તમારું ઉપકરણ પસંદ કરો. આપણે એક-એક પગલું આગળ વધીશું.","અથવા તમારા શબ્દોમાં જણાવો","ઉપકરણ અથવા ઍપનું નામ લખો અથવા સમસ્યા જણાવો.","શરૂ કરો","મને ખાતરી નથી","મારાં ઉપકરણો","મદદ મેળવો","વધુ વિકલ્પો","પાછળ","રદ કરો","ચાલુ રાખો","વધુ લોડ કરો","ટીવી અને સ્ટ્રીમિંગ","ફોન અને ટૅબ્લેટ","લૅપટૉપ","ડેસ્કટૉપ કમ્પ્યુટર","પ્રિન્ટર અને સ્કૅનર","વાઇ-ફાઇ અને ઇન્ટરનેટ","ઍપ અને ખાતાં","અન્ય ટેક્નોલોજી","તમે કઈ બ્રાન્ડ વાપરો છો?","તમારી પાસે કયું મૉડલ છે?","તમે કયું સૉફ્ટવેર વાપરો છો?","અન્ય / ખાતરી નથી","બીજું મૉડલ અથવા ઉત્પાદન","તે શોધવામાં મારી મદદ કરો","મને ખબર નથી","તમારાં ઉપકરણો.","ઝડપથી મદદ મેળવવા તમારાં ઉપકરણો ઉમેરો.","ઉપકરણ ઉમેરો","ઉપકરણ સાચવો","મારાં ઉપકરણોમાં સાચવો","ઉપકરણનું ટૂંકું નામ","(વૈકલ્પિક)","આ સત્ર માટે સાચવ્યું.","સમસ્યા ઉકેલો","દૂર કરો","ટૂંક સમયમાં આવી રહ્યું છે","પછી માટે સાચવો","લૉન્ચની વિગતો જુઓ","શું સમસ્યા થઈ રહી છે?","બીજું કંઈક","સંપૂર્ણ ઍક્સેસ","અદ્યતન માર્ગદર્શિકાઓ","માર્ગદર્શિકાઓ જુઓ","ખરીદીઓ પુનઃસ્થાપિત કરો","સબ્સ્ક્રિપ્શન સંચાલિત કરો","મફત મદદ સાથે ચાલુ રાખો","ફરીથી શરૂ કરો","સમસ્યા ઉકેલવાનું ચાલુ રાખો","પગલું","તમારા ઉપકરણ પરનું નામ","નામ વાપરો","ડેમો ઍક્સેસ સમાપ્ત કરો","ખાતરી નથી","સંપૂર્ણ ઍક્સેસનું પૂર્વાવલોકન","તમારું સંપૂર્ણ ઍક્સેસ","તમારી માર્ગદર્શિકા ચાલુ રાખો","સહાયનો સારાંશ જુઓ","તમારી માર્ગદર્શિકાઓ પર પાછા જાઓ","સંપૂર્ણ ઍક્સેસ વિશે જાણો","માર્ગદર્શિકાની સમીક્ષા કરો","પરિણામ તપાસો","માત્ર પૂર્વાવલોકન. કોઈ ચુકવણી થશે નહીં અને કોઈ સબ્સ્ક્રિપ્શન શરૂ થશે નહીં."]},{"code":"he","name":"Hebrew","nativeName":"עברית","dir":"rtl","values":["שפה","חיפוש שפות","סגירה","פקדי השימוש העיקריים מתורגמים. המדריכים המפורטים זמינים כרגע באנגלית.","קצת עזרה. הרבה יותר פשוט.","בואו נחזיר את המכשירים שלכם לפעולה.","בחרו את המכשיר. נתקדם צעד אחר צעד.","או ספרו לנו במילים שלכם","הקלידו שם של מכשיר, יישום או תיאור של הבעיה.","התחלה","אני לא בטוח/ה","המכשירים שלי","קבלת עזרה","אפשרויות נוספות","חזרה","ביטול","המשך","טעינת פריטים נוספים","טלוויזיה וסטרימינג","טלפונים וטאבלטים","מחשבים ניידים","מחשבים נייחים","מדפסות וסורקים","Wi-Fi ואינטרנט","יישומים וחשבונות","טכנולוגיה אחרת","באיזה מותג אתם משתמשים?","איזה דגם יש לכם?","באיזו תוכנה אתם משתמשים?","אחר / לא בטוח/ה","דגם או מוצר אחר","עזרו לי למצוא","אני לא יודע/ת","המכשירים שלכם.","הוסיפו את המכשירים שלכם כדי לקבל עזרה מהר יותר.","הוספת מכשיר","שמירת המכשיר","שמירה במכשירים שלי","כינוי למכשיר","(לא חובה)","נשמר למשך השימוש הנוכחי.","פתרון בעיות","הסרה","בקרוב","שמירה להמשך","הצגת פרטי ההשקה","מה לא עובד?","משהו אחר","גישה מלאה","מדריכים מתקדמים","עיון במדריכים","שחזור רכישות","ניהול המינוי","המשך עם עזרה בחינם","התחלה מחדש","המשך פתרון הבעיות","שלב","השם שמופיע במכשיר","שימוש בשם","סיום גישת ההדגמה","לא בטוח/ה","תצוגה מקדימה של גישה מלאה","הגישה המלאה שלכם","המשך המדריך שלכם","הצגת סיכום התמיכה","חזרה למדריכים שלכם","מידע על גישה מלאה","עיון במדריך","בדיקת התוצאה","תצוגה מקדימה בלבד. לא יבוצע חיוב ולא ייווצר מינוי."]},{"code":"hi","name":"Hindi","nativeName":"हिन्दी","dir":"ltr","values":["भाषा","भाषाएँ खोजें","बंद करें","मुख्य नियंत्रणों का अनुवाद किया गया है। विस्तृत गाइड अभी अंग्रेज़ी में हैं।","थोड़ी मदद। बहुत आसान।","आइए, आपके डिवाइस को ठीक करें।","अपना डिवाइस चुनें। हम एक-एक कदम आगे बढ़ेंगे।","या अपने शब्दों में बताएं","डिवाइस या ऐप का नाम लिखें या समस्या बताएं।","शुरू करें","मुझे पक्का नहीं पता","मेरे डिवाइस","मदद पाएं","और विकल्प","वापस","रद्द करें","जारी रखें","और लोड करें","टीवी और स्ट्रीमिंग","फ़ोन और टैबलेट","लैपटॉप","डेस्कटॉप कंप्यूटर","प्रिंटर और स्कैनर","वाई-फ़ाई और इंटरनेट","ऐप और खाते","अन्य तकनीक","आप किस ब्रांड का इस्तेमाल करते हैं?","आपके पास कौन सा मॉडल है?","आप कौन सा सॉफ़्टवेयर इस्तेमाल कर रहे हैं?","अन्य / पक्का नहीं पता","दूसरा मॉडल या उत्पाद","इसे ढूँढने में मेरी मदद करें","मुझे नहीं पता","आपके डिवाइस।","जल्दी मदद पाने के लिए अपने डिवाइस जोड़ें।","डिवाइस जोड़ें","डिवाइस सहेजें","मेरे डिवाइस में सहेजें","डिवाइस का छोटा नाम","(वैकल्पिक)","इस सत्र के लिए सहेजा गया।","समस्या हल करें","हटाएं","जल्द आ रहा है","बाद के लिए सहेजें","लॉन्च की जानकारी देखें","क्या समस्या हो रही है?","कुछ और","पूर्ण ऐक्सेस","उन्नत गाइड","गाइड देखें","खरीदारी बहाल करें","सदस्यता प्रबंधित करें","मुफ़्त मदद के साथ जारी रखें","फिर से शुरू करें","समस्या हल करना जारी रखें","चरण","आपके डिवाइस पर लिखा नाम","नाम इस्तेमाल करें","डेमो ऐक्सेस समाप्त करें","पक्का नहीं पता","पूर्ण ऐक्सेस का पूर्वावलोकन","आपका पूर्ण ऐक्सेस","अपनी गाइड जारी रखें","सहायता का सारांश देखें","अपनी गाइड पर वापस जाएं","पूर्ण ऐक्सेस के बारे में जानें","गाइड की समीक्षा करें","नतीजा जाँचें","सिर्फ़ पूर्वावलोकन। कोई भुगतान नहीं होगा और कोई सदस्यता शुरू नहीं होगी।"]},{"code":"hu","name":"Hungarian","nativeName":"Magyar","dir":"ltr","values":["Nyelv","Nyelvek keresése","Bezárás","A fő kezelőelemek le vannak fordítva. A részletes útmutatók jelenleg angolul érhetők el.","Egy kis segítség. Sokkal egyszerűbben.","Hozzuk működésbe az eszközeidet.","Válaszd ki az eszközödet. Lépésről lépésre haladunk.","Vagy írd le saját szavaiddal","Írj be egy eszközt, alkalmazást vagy problémát.","Indítás","Nem vagyok biztos benne","Saját eszközök","Segítség kérése","További lehetőségek","Vissza","Mégse","Folytatás","Továbbiak betöltése","TV és streamelés","Telefonok és táblagépek","Laptopok","Asztali számítógépek","Nyomtatók és szkennerek","Wi-Fi és internet","Alkalmazások és fiókok","Egyéb eszközök","Milyen márkát használsz?","Milyen modelled van?","Milyen szoftvert használsz?","Más / nem tudom","Másik modell vagy termék","Segíts megtalálni","Nem tudom","Az eszközeid.","Add hozzá az eszközeidet a gyorsabb segítséghez.","Eszköz hozzáadása","Eszköz mentése","Mentés a Saját eszközök közé","Eszköz beceneve","(nem kötelező)","Erre a munkamenetre mentve.","Hibaelhárítás","Eltávolítás","Hamarosan","Mentés későbbre","Megjelenés részletei","Mi nem működik?","Valami más","Teljes hozzáférés","Haladó útmutatók","Útmutatók böngészése","Vásárlások visszaállítása","Előfizetés kezelése","Folytatás ingyenes segítséggel","Újrakezdés","Hibaelhárítás folytatása","Lépés","Az eszközön szereplő név","Név használata","Demóhozzáférés befejezése","Nem tudom","Teljes hozzáférés kipróbálása","A teljes hozzáférésed","Útmutató folytatása","Támogatási összefoglaló","Vissza az útmutatókhoz","Teljes hozzáférés felfedezése","Útmutató áttekintése","Eredmény ellenőrzése","Csak előnézet. Nem történik fizetés, és nem jön létre előfizetés."]},{"code":"id","name":"Indonesian","nativeName":"Bahasa Indonesia","dir":"ltr","values":["Bahasa","Cari bahasa","Tutup","Kontrol utama sudah diterjemahkan. Panduan terperinci saat ini tersedia dalam bahasa Inggris.","Sedikit bantuan. Jauh lebih mudah.","Mari buat perangkat Anda berfungsi kembali.","Pilih perangkat Anda. Kita akan melakukannya selangkah demi selangkah.","Atau ceritakan dengan kata-kata Anda sendiri","Ketik nama perangkat, aplikasi, atau masalah yang terjadi.","Mulai","Saya tidak yakin","Perangkat Saya","Dapatkan bantuan","Opsi lainnya","Kembali","Batal","Lanjutkan","Muat lebih banyak","TV & streaming","Ponsel & tablet","Laptop","Komputer desktop","Printer & pemindai","Wi-Fi & internet","Aplikasi & akun","Teknologi lainnya","Merek apa yang Anda gunakan?","Model apa yang Anda miliki?","Perangkat lunak apa yang Anda gunakan?","Lainnya / tidak yakin","Model atau produk lain","Bantu saya menemukannya","Saya tidak tahu","Perangkat Anda.","Tambahkan perangkat Anda untuk mendapatkan bantuan lebih cepat.","Tambah perangkat","Simpan perangkat","Simpan ke Perangkat Saya","Nama panggilan perangkat","(opsional)","Disimpan untuk sesi ini.","Atasi masalah","Hapus","Segera hadir","Simpan untuk nanti","Lihat detail peluncuran","Apa masalahnya?","Hal lainnya","Akses Penuh","Panduan lanjutan","Jelajahi panduan","Pulihkan pembelian","Kelola langganan","Lanjutkan dengan bantuan gratis","Mulai lagi","Lanjutkan pemecahan masalah","Langkah","Nama yang tertera pada perangkat","Gunakan nama","Akhiri akses demo","Tidak yakin","Pratinjau Akses Penuh","Akses Penuh Anda","Lanjutkan panduan Anda","Lihat ringkasan dukungan","Kembali ke panduan Anda","Jelajahi Akses Penuh","Tinjau panduan","Periksa hasilnya","Hanya pratinjau. Tidak ada pembayaran atau langganan yang dibuat."]},{"code":"it","name":"Italian","nativeName":"Italiano","dir":"ltr","values":["Lingua","Cerca lingue","Chiudi","I comandi principali sono tradotti. Le guide dettagliate sono in inglese.","Un piccolo aiuto. Tutto più semplice.","Facciamo funzionare i tuoi dispositivi.","Scegli il tuo dispositivo. Procederemo passo dopo passo.","Oppure descrivilo con parole tue","Scrivi un dispositivo, un’app o il problema.","Inizia","Non sono sicuro","I miei dispositivi","Ricevi aiuto","Altre opzioni","Indietro","Annulla","Continua","Carica altro","TV e streaming","Telefoni e tablet","Portatili","Computer desktop","Stampanti e scanner","Wi-Fi e internet","App e account","Altri dispositivi","Quale marca usi?","Quale modello hai?","Quale software usi?","Altro / non so","Altro modello o prodotto","Aiutami a trovarlo","Non lo so","I tuoi dispositivi.","Aggiungi i tuoi dispositivi per ricevere aiuto più rapidamente.","Aggiungi dispositivo","Salva dispositivo","Salva in I miei dispositivi","Nome del dispositivo","(facoltativo)","Salvato per questa sessione.","Risolvi problemi","Rimuovi","In arrivo","Salva per dopo","Vedi i dettagli del lancio","Qual è il problema?","Qualcos’altro","Accesso completo","Guide avanzate","Sfoglia le guide","Ripristina acquisti","Gestisci abbonamento","Continua con l’aiuto gratuito","Ricomincia","Continua la risoluzione","Passaggio","Nome sul dispositivo","Usa nome","Termina accesso demo","Non so","Prova Accesso completo","Il tuo Accesso completo","Continua la guida","Vedi riepilogo assistenza","Torna alle tue guide","Scopri Accesso completo","Rivedi la guida","Verifica il risultato","Solo anteprima. Non viene effettuato alcun pagamento né creato un abbonamento."]},{"code":"ja","name":"Japanese","nativeName":"日本語","dir":"ltr","values":["言語","言語を検索","閉じる","主な操作項目は翻訳されています。詳しいガイドは現在、英語で提供しています。","少しのサポートで、ぐっと簡単に。","機器を使えるようにしましょう。","お使いの機器を選んでください。一つずつ進めていきましょう。","または、ご自身の言葉で教えてください","機器やアプリの名前、または問題の内容を入力してください。","開始","よくわかりません","マイデバイス","サポートを受ける","その他のオプション","戻る","キャンセル","続ける","さらに読み込む","テレビ・ストリーミング","スマートフォン・タブレット","ノートパソコン","デスクトップパソコン","プリンター・スキャナー","Wi-Fi・インターネット","アプリ・アカウント","その他の機器・サービス","どのメーカーをお使いですか？","どのモデルをお使いですか？","どのソフトウェアをお使いですか？","その他・わからない","別のモデルや製品","探すのを手伝ってほしい","わかりません","お使いの機器。","機器を追加すると、より早くサポートを受けられます。","機器を追加","機器を保存","マイデバイスに保存","機器のニックネーム","（任意）","このセッション用に保存しました。","問題を解決する","削除","近日公開","あとで見るために保存","提供開始の詳細を見る","どのような問題がありますか？","その他の問題","フルアクセス","上級ガイド","ガイドを探す","購入を復元","サブスクリプションを管理","無料サポートを続ける","最初からやり直す","問題の解決を続ける","ステップ","機器に表示されている名前","この名前を使う","デモアクセスを終了","わからない","フルアクセスをプレビュー","あなたのフルアクセス","ガイドの続きを見る","サポートの概要を見る","自分のガイドに戻る","フルアクセスについて見る","ガイドを見直す","結果を確認","プレビューのみです。支払いやサブスクリプションの登録は発生しません。"]},{"code":"ko","name":"Korean","nativeName":"한국어","dir":"ltr","values":["언어","언어 검색","닫기","주요 조작 항목이 번역되어 있습니다. 자세한 가이드는 현재 영어로 제공됩니다.","작은 도움으로 훨씬 간편하게.","기기를 다시 사용할 수 있도록 도와드릴게요.","기기를 선택하세요. 한 단계씩 함께 진행해요.","또는 편하게 설명해 주세요","기기나 앱 이름, 또는 발생한 문제를 입력하세요.","시작","잘 모르겠어요","내 기기","도움 받기","추가 옵션","뒤로","취소","계속","더 불러오기","TV 및 스트리밍","휴대폰 및 태블릿","노트북","데스크톱 컴퓨터","프린터 및 스캐너","Wi-Fi 및 인터넷","앱 및 계정","기타 기술 기기","어떤 브랜드를 사용하시나요?","어떤 모델을 가지고 계신가요?","어떤 소프트웨어를 사용하시나요?","기타 / 잘 모르겠어요","다른 모델 또는 제품","찾는 데 도움을 주세요","모르겠어요","내 기기.","기기를 추가하면 더 빠르게 도움을 받을 수 있어요.","기기 추가","기기 저장","내 기기에 저장","기기 별명","(선택 사항)","이번 세션에 저장되었습니다.","문제 해결","삭제","출시 예정","나중을 위해 저장","출시 정보 보기","어떤 문제가 있나요?","다른 문제","전체 이용","고급 가이드","가이드 둘러보기","구매 복원","구독 관리","무료 도움 계속 받기","다시 시작","문제 해결 계속하기","단계","기기에 표시된 이름","이 이름 사용","데모 이용 종료","잘 모르겠어요","전체 이용 미리보기","내 전체 이용 권한","가이드 계속 보기","지원 요약 보기","내 가이드로 돌아가기","전체 이용 알아보기","가이드 검토","결과 확인","미리보기만 제공됩니다. 결제되거나 구독이 시작되지 않습니다."]},{"code":"ms","name":"Malay","nativeName":"Bahasa Melayu","dir":"ltr","values":["Bahasa","Cari bahasa","Tutup","Kawalan utama telah diterjemahkan. Panduan terperinci kini tersedia dalam bahasa Inggeris.","Sedikit bantuan. Jauh lebih mudah.","Mari pastikan peranti anda berfungsi.","Pilih peranti anda. Kita akan lakukannya langkah demi langkah.","Atau ceritakan dengan kata-kata anda sendiri","Taip nama peranti, aplikasi atau masalah yang berlaku.","Mula","Saya tidak pasti","Peranti Saya","Dapatkan bantuan","Pilihan lain","Kembali","Batal","Teruskan","Muatkan lagi","TV & penstriman","Telefon & tablet","Komputer riba","Komputer meja","Pencetak & pengimbas","Wi-Fi & internet","Aplikasi & akaun","Teknologi lain","Apakah jenama yang anda gunakan?","Apakah model yang anda miliki?","Apakah perisian yang anda gunakan?","Lain / tidak pasti","Model atau produk lain","Bantu saya mencarinya","Saya tidak tahu","Peranti anda.","Tambah peranti anda untuk mendapatkan bantuan dengan lebih cepat.","Tambah peranti","Simpan peranti","Simpan ke Peranti Saya","Nama panggilan peranti","(pilihan)","Disimpan untuk sesi ini.","Selesaikan masalah","Alih keluar","Akan datang","Simpan untuk kemudian","Lihat butiran pelancaran","Apakah masalah yang berlaku?","Perkara lain","Akses Penuh","Panduan lanjutan","Layari panduan","Pulihkan pembelian","Urus langganan","Teruskan dengan bantuan percuma","Mula semula","Teruskan penyelesaian masalah","Langkah","Nama pada peranti anda","Gunakan nama","Tamatkan akses demo","Tidak pasti","Pratonton Akses Penuh","Akses Penuh anda","Teruskan panduan anda","Lihat ringkasan sokongan","Kembali ke panduan anda","Terokai Akses Penuh","Semak panduan","Semak hasilnya","Pratonton sahaja. Tiada bayaran dikenakan atau langganan dibuat."]},{"code":"mr","name":"Marathi","nativeName":"मराठी","dir":"ltr","values":["भाषा","भाषा शोधा","बंद करा","मुख्य नियंत्रणे भाषांतरित केली आहेत. तपशीलवार मार्गदर्शिका सध्या इंग्रजीत आहेत.","थोडी मदत. खूप सोपे.","चला, तुमचे उपकरण सुरू करूया.","तुमचे उपकरण निवडा. आपण एकेक पाऊल पुढे जाऊ.","किंवा तुमच्या शब्दांत सांगा","उपकरणाचे किंवा ॲपचे नाव लिहा किंवा समस्या सांगा.","सुरू करा","मला नक्की माहीत नाही","माझी उपकरणे","मदत मिळवा","आणखी पर्याय","मागे","रद्द करा","पुढे चला","आणखी लोड करा","टीव्ही आणि स्ट्रीमिंग","फोन आणि टॅबलेट","लॅपटॉप","डेस्कटॉप संगणक","प्रिंटर आणि स्कॅनर","वाय-फाय आणि इंटरनेट","ॲप्स आणि खाती","इतर तंत्रज्ञान","तुम्ही कोणता ब्रँड वापरता?","तुमच्याकडे कोणते मॉडेल आहे?","तुम्ही कोणते सॉफ्टवेअर वापरत आहात?","इतर / नक्की माहीत नाही","दुसरे मॉडेल किंवा उत्पादन","ते शोधण्यात मला मदत करा","मला माहीत नाही","तुमची उपकरणे.","लवकर मदत मिळवण्यासाठी तुमची उपकरणे जोडा.","उपकरण जोडा","उपकरण जतन करा","माझ्या उपकरणांमध्ये जतन करा","उपकरणाचे टोपणनाव","(ऐच्छिक)","या सत्रासाठी जतन केले.","समस्या सोडवा","काढून टाका","लवकरच येत आहे","नंतरसाठी जतन करा","लाँचचे तपशील पाहा","काय समस्या येत आहे?","दुसरे काहीतरी","संपूर्ण प्रवेश","प्रगत मार्गदर्शिका","मार्गदर्शिका पाहा","खरेदी पुनर्संचयित करा","सदस्यत्व व्यवस्थापित करा","मोफत मदतीसह पुढे चला","पुन्हा सुरू करा","समस्या सोडवणे सुरू ठेवा","पायरी","तुमच्या उपकरणावरील नाव","नाव वापरा","डेमो प्रवेश समाप्त करा","नक्की माहीत नाही","संपूर्ण प्रवेशाचे पूर्वावलोकन","तुमचा संपूर्ण प्रवेश","तुमची मार्गदर्शिका पुढे सुरू ठेवा","मदतीचा सारांश पाहा","तुमच्या मार्गदर्शिकांकडे परत जा","संपूर्ण प्रवेशाबद्दल जाणून घ्या","मार्गदर्शिकेचा आढावा घ्या","परिणाम तपासा","केवळ पूर्वावलोकन. कोणतेही शुल्क आकारले जाणार नाही आणि सदस्यत्व सुरू होणार नाही."]},{"code":"no","name":"Norwegian","nativeName":"Norsk","dir":"ltr","values":["Språk","Søk etter språk","Lukk","De viktigste kontrollene er oversatt. Detaljerte veiledninger er foreløpig på engelsk.","Litt hjelp. Mye enklere.","La oss få teknologien din til å virke.","Velg enheten din. Vi tar det steg for steg.","Eller beskriv det med egne ord","Skriv en enhet, app eller hva som gikk galt.","Start","Jeg er usikker","Min teknologi","Få hjelp","Flere alternativer","Tilbake","Avbryt","Fortsett","Last inn flere","TV og strømming","Telefoner og nettbrett","Bærbare datamaskiner","Stasjonære datamaskiner","Skrivere og skannere","Wi-Fi og internett","Apper og kontoer","Annen teknologi","Hvilket merke bruker du?","Hvilken modell har du?","Hvilken programvare bruker du?","Annet / usikker","Annen modell eller produkt","Hjelp meg å finne den","Jeg vet ikke","Enhetene dine.","Legg til enhetene dine for å få raskere hjelp.","Legg til enhet","Lagre enhet","Lagre i Min teknologi","Enhetens kallenavn","(valgfritt)","Lagret for denne økten.","Feilsøk","Fjern","Kommer snart","Lagre til senere","Se lanseringsdetaljer","Hva fungerer ikke?","Noe annet","Full tilgang","Avanserte veiledninger","Bla gjennom veiledninger","Gjenopprett kjøp","Administrer abonnement","Fortsett med gratis hjelp","Start på nytt","Fortsett feilsøkingen","Steg","Navnet på enheten din","Bruk navn","Avslutt demotilgang","Usikker","Prøv Full tilgang","Din fulle tilgang","Fortsett veiledningen","Se støtteoversikt","Tilbake til veiledningene","Utforsk Full tilgang","Se gjennom veiledningen","Sjekk resultatet","Kun forhåndsvisning. Ingen betaling gjennomføres, og intet abonnement opprettes."]},{"code":"fa","name":"Persian","nativeName":"فارسی","dir":"rtl","values":["زبان","جستجوی زبان‌ها","بستن","کنترل‌های اصلی ترجمه شده‌اند. راهنماهای مفصل فعلاً به زبان انگلیسی هستند.","کمی کمک. خیلی ساده‌تر.","بیایید دستگاهتان را راه بیندازیم.","دستگاهتان را انتخاب کنید. قدم‌به‌قدم پیش می‌رویم.","یا با زبان خودتان توضیح دهید","نام دستگاه یا برنامه را بنویسید، یا مشکل را شرح دهید.","شروع","مطمئن نیستم","دستگاه‌های من","دریافت راهنمایی","گزینه‌های بیشتر","بازگشت","لغو","ادامه","بارگذاری بیشتر","تلویزیون و پخش آنلاین","گوشی و تبلت","لپ‌تاپ","رایانه‌های رومیزی","چاپگر و اسکنر","وای‌فای و اینترنت","برنامه‌ها و حساب‌ها","سایر فناوری‌ها","از چه برندی استفاده می‌کنید؟","مدل دستگاهتان چیست؟","از چه نرم‌افزاری استفاده می‌کنید؟","سایر / مطمئن نیستم","مدل یا محصول دیگر","کمک کنید پیدایش کنم","نمی‌دانم","دستگاه‌های شما.","دستگاه‌هایتان را اضافه کنید تا زودتر راهنمایی بگیرید.","افزودن دستگاه","ذخیره دستگاه","ذخیره در دستگاه‌های من","نام دلخواه دستگاه","(اختیاری)","برای این نشست ذخیره شد.","عیب‌یابی","حذف","به‌زودی","ذخیره برای بعد","مشاهده جزئیات عرضه","چه مشکلی پیش آمده؟","چیز دیگر","دسترسی کامل","راهنماهای پیشرفته","مرور راهنماها","بازیابی خریدها","مدیریت اشتراک","ادامه با راهنمایی رایگان","شروع دوباره","ادامه عیب‌یابی","مرحله","نام روی دستگاهتان","استفاده از نام","پایان دسترسی نمایشی","نامشخص","پیش‌نمایش دسترسی کامل","دسترسی کامل شما","ادامه راهنمای شما","مشاهده خلاصه پشتیبانی","بازگشت به راهنماهای شما","آشنایی با دسترسی کامل","مرور راهنما","بررسی نتیجه","فقط پیش‌نمایش است. هیچ پرداخت یا اشتراکی ایجاد نمی‌شود."]},{"code":"pl","name":"Polish","nativeName":"Polski","dir":"ltr","values":["Język","Szukaj języków","Zamknij","Główne elementy interfejsu są przetłumaczone. Szczegółowe poradniki są obecnie po angielsku.","Trochę pomocy. O wiele prościej.","Uruchommy Twoją technologię.","Wybierz urządzenie. Przejdziemy przez wszystko krok po kroku.","Lub opisz problem własnymi słowami","Wpisz urządzenie, aplikację lub problem.","Start","Nie mam pewności","Mój sprzęt","Uzyskaj pomoc","Więcej opcji","Wstecz","Anuluj","Dalej","Wczytaj więcej","Telewizory i streaming","Telefony i tablety","Laptopy","Komputery stacjonarne","Drukarki i skanery","Wi-Fi i internet","Aplikacje i konta","Inny sprzęt","Jakiej marki używasz?","Jaki masz model?","Jakiego oprogramowania używasz?","Inna / nie wiem","Inny model lub produkt","Pomóż mi znaleźć","Nie wiem","Twoje urządzenia.","Dodaj urządzenia, aby szybciej uzyskać pomoc.","Dodaj urządzenie","Zapisz urządzenie","Zapisz w Mój sprzęt","Nazwa urządzenia","(opcjonalnie)","Zapisano na tę sesję.","Rozwiąż problem","Usuń","Wkrótce","Zapisz na później","Zobacz szczegóły premiery","Co nie działa?","Coś innego","Pełny dostęp","Poradniki zaawansowane","Przeglądaj poradniki","Przywróć zakupy","Zarządzaj subskrypcją","Kontynuuj bezpłatną pomoc","Zacznij od nowa","Kontynuuj rozwiązywanie","Krok","Nazwa na urządzeniu","Użyj nazwy","Zakończ dostęp demonstracyjny","Nie wiem","Wypróbuj Pełny dostęp","Twój Pełny dostęp","Kontynuuj poradnik","Zobacz podsumowanie pomocy","Wróć do poradników","Poznaj Pełny dostęp","Przejrzyj poradnik","Sprawdź wynik","Tylko podgląd. Nie dokonujesz płatności ani nie rozpoczynasz subskrypcji."]},{"code":"pt","name":"Portuguese","nativeName":"Português","dir":"ltr","values":["Idioma","Pesquisar idiomas","Fechar","Os controlos principais estão traduzidos. Os guias detalhados estão em inglês.","Uma pequena ajuda. Tudo mais simples.","Vamos pôr os seus dispositivos a funcionar.","Escolha o seu dispositivo. Vamos passo a passo.","Ou descreva o problema pelas suas palavras","Escreva um dispositivo, uma app ou o problema.","Começar","Não tenho a certeza","A minha tecnologia","Obter ajuda","Mais opções","Voltar","Cancelar","Continuar","Carregar mais","TV e streaming","Telemóveis e tablets","Portáteis","Computadores de secretária","Impressoras e scanners","Wi-Fi e internet","Apps e contas","Outra tecnologia","Que marca utiliza?","Que modelo tem?","Que software utiliza?","Outra / não sei","Outro modelo ou produto","Ajude-me a encontrá-lo","Não sei","Os seus dispositivos.","Adicione os seus dispositivos para obter ajuda mais depressa.","Adicionar dispositivo","Guardar dispositivo","Guardar em A minha tecnologia","Nome do dispositivo","(opcional)","Guardado para esta sessão.","Resolver problemas","Remover","Brevemente","Guardar para mais tarde","Ver detalhes do lançamento","O que está a falhar?","Outra coisa","Acesso completo","Guias avançados","Explorar guias","Restaurar compras","Gerir subscrição","Continuar com ajuda gratuita","Recomeçar","Continuar a resolução","Passo","Nome no seu dispositivo","Usar nome","Terminar acesso de demonstração","Não sei","Experimentar Acesso completo","O seu Acesso completo","Continuar o seu guia","Ver resumo de suporte","Voltar aos seus guias","Explorar Acesso completo","Rever guia","Verificar o resultado","Apenas uma pré-visualização. Não é efetuado qualquer pagamento nem criada uma subscrição."]},{"code":"pa","name":"Punjabi","nativeName":"ਪੰਜਾਬੀ","dir":"ltr","values":["ਭਾਸ਼ਾ","ਭਾਸ਼ਾਵਾਂ ਖੋਜੋ","ਬੰਦ ਕਰੋ","ਮੁੱਖ ਕੰਟਰੋਲਾਂ ਦਾ ਅਨੁਵਾਦ ਕੀਤਾ ਗਿਆ ਹੈ। ਵਿਸਤ੍ਰਿਤ ਗਾਈਡਾਂ ਫ਼ਿਲਹਾਲ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ ਹਨ।","ਥੋੜ੍ਹੀ ਮਦਦ। ਬਹੁਤ ਆਸਾਨ।","ਆਓ ਤੁਹਾਡੀ ਡਿਵਾਈਸ ਚਾਲੂ ਕਰੀਏ।","ਆਪਣੀ ਡਿਵਾਈਸ ਚੁਣੋ। ਅਸੀਂ ਇੱਕ-ਇੱਕ ਕਦਮ ਅੱਗੇ ਵਧਾਂਗੇ।","ਜਾਂ ਆਪਣੇ ਸ਼ਬਦਾਂ ਵਿੱਚ ਦੱਸੋ","ਡਿਵਾਈਸ ਜਾਂ ਐਪ ਦਾ ਨਾਮ ਲਿਖੋ ਜਾਂ ਸਮੱਸਿਆ ਦੱਸੋ।","ਸ਼ੁਰੂ ਕਰੋ","ਮੈਨੂੰ ਪੱਕਾ ਨਹੀਂ ਪਤਾ","ਮੇਰੀਆਂ ਡਿਵਾਈਸਾਂ","ਮਦਦ ਲਵੋ","ਹੋਰ ਵਿਕਲਪ","ਪਿੱਛੇ","ਰੱਦ ਕਰੋ","ਜਾਰੀ ਰੱਖੋ","ਹੋਰ ਲੋਡ ਕਰੋ","ਟੀਵੀ ਅਤੇ ਸਟ੍ਰੀਮਿੰਗ","ਫ਼ੋਨ ਅਤੇ ਟੈਬਲੇਟ","ਲੈਪਟਾਪ","ਡੈਸਕਟਾਪ ਕੰਪਿਊਟਰ","ਪ੍ਰਿੰਟਰ ਅਤੇ ਸਕੈਨਰ","ਵਾਈ-ਫਾਈ ਅਤੇ ਇੰਟਰਨੈੱਟ","ਐਪਾਂ ਅਤੇ ਖਾਤੇ","ਹੋਰ ਤਕਨਾਲੋਜੀ","ਤੁਸੀਂ ਕਿਹੜਾ ਬ੍ਰਾਂਡ ਵਰਤਦੇ ਹੋ?","ਤੁਹਾਡੇ ਕੋਲ ਕਿਹੜਾ ਮਾਡਲ ਹੈ?","ਤੁਸੀਂ ਕਿਹੜਾ ਸਾਫ਼ਟਵੇਅਰ ਵਰਤ ਰਹੇ ਹੋ?","ਹੋਰ / ਪੱਕਾ ਨਹੀਂ ਪਤਾ","ਕੋਈ ਹੋਰ ਮਾਡਲ ਜਾਂ ਉਤਪਾਦ","ਇਸ ਨੂੰ ਲੱਭਣ ਵਿੱਚ ਮੇਰੀ ਮਦਦ ਕਰੋ","ਮੈਨੂੰ ਨਹੀਂ ਪਤਾ","ਤੁਹਾਡੀਆਂ ਡਿਵਾਈਸਾਂ।","ਜਲਦੀ ਮਦਦ ਲੈਣ ਲਈ ਆਪਣੀਆਂ ਡਿਵਾਈਸਾਂ ਜੋੜੋ।","ਡਿਵਾਈਸ ਜੋੜੋ","ਡਿਵਾਈਸ ਸੁਰੱਖਿਅਤ ਕਰੋ","ਮੇਰੀਆਂ ਡਿਵਾਈਸਾਂ ਵਿੱਚ ਸੁਰੱਖਿਅਤ ਕਰੋ","ਡਿਵਾਈਸ ਦਾ ਛੋਟਾ ਨਾਮ","(ਵਿਕਲਪਿਕ)","ਇਸ ਸੈਸ਼ਨ ਲਈ ਸੁਰੱਖਿਅਤ ਕੀਤਾ ਗਿਆ।","ਸਮੱਸਿਆ ਹੱਲ ਕਰੋ","ਹਟਾਓ","ਜਲਦ ਆ ਰਿਹਾ ਹੈ","ਬਾਅਦ ਲਈ ਸੁਰੱਖਿਅਤ ਕਰੋ","ਲਾਂਚ ਦੀ ਜਾਣਕਾਰੀ ਵੇਖੋ","ਕੀ ਸਮੱਸਿਆ ਆ ਰਹੀ ਹੈ?","ਕੁਝ ਹੋਰ","ਪੂਰੀ ਪਹੁੰਚ","ਉੱਨਤ ਗਾਈਡਾਂ","ਗਾਈਡਾਂ ਵੇਖੋ","ਖਰੀਦਾਂ ਬਹਾਲ ਕਰੋ","ਗਾਹਕੀ ਦਾ ਪ੍ਰਬੰਧ ਕਰੋ","ਮੁਫ਼ਤ ਮਦਦ ਨਾਲ ਜਾਰੀ ਰੱਖੋ","ਮੁੜ ਸ਼ੁਰੂ ਕਰੋ","ਸਮੱਸਿਆ ਹੱਲ ਕਰਨਾ ਜਾਰੀ ਰੱਖੋ","ਕਦਮ","ਤੁਹਾਡੀ ਡਿਵਾਈਸ ਉੱਤੇ ਲਿਖਿਆ ਨਾਮ","ਨਾਮ ਵਰਤੋ","ਡੈਮੋ ਪਹੁੰਚ ਖ਼ਤਮ ਕਰੋ","ਪੱਕਾ ਨਹੀਂ ਪਤਾ","ਪੂਰੀ ਪਹੁੰਚ ਦੀ ਝਲਕ","ਤੁਹਾਡੀ ਪੂਰੀ ਪਹੁੰਚ","ਆਪਣੀ ਗਾਈਡ ਜਾਰੀ ਰੱਖੋ","ਮਦਦ ਦਾ ਸਾਰ ਵੇਖੋ","ਆਪਣੀਆਂ ਗਾਈਡਾਂ ਵੱਲ ਵਾਪਸ ਜਾਓ","ਪੂਰੀ ਪਹੁੰਚ ਬਾਰੇ ਜਾਣੋ","ਗਾਈਡ ਦੀ ਸਮੀਖਿਆ ਕਰੋ","ਨਤੀਜਾ ਜਾਂਚੋ","ਸਿਰਫ਼ ਝਲਕ। ਕੋਈ ਭੁਗਤਾਨ ਨਹੀਂ ਹੋਵੇਗਾ ਅਤੇ ਕੋਈ ਗਾਹਕੀ ਸ਼ੁਰੂ ਨਹੀਂ ਹੋਵੇਗੀ।"]},{"code":"ro","name":"Romanian","nativeName":"Română","dir":"ltr","values":["Limbă","Caută limbi","Închide","Comenzile principale sunt traduse. Ghidurile detaliate sunt momentan în engleză.","Puțin ajutor. Mult mai simplu.","Hai să-ți facem dispozitivele să funcționeze.","Alege dispozitivul. Vom continua pas cu pas.","Sau descrie problema cu propriile cuvinte","Scrie un dispozitiv, o aplicație sau problema.","Începe","Nu sunt sigur","Dispozitivele mele","Obține ajutor","Mai multe opțiuni","Înapoi","Anulează","Continuă","Încarcă mai multe","TV și streaming","Telefoane și tablete","Laptopuri","Calculatoare desktop","Imprimante și scanere","Wi-Fi și internet","Aplicații și conturi","Alte dispozitive","Ce marcă folosești?","Ce model ai?","Ce software folosești?","Altă marcă / nu știu","Alt model sau produs","Ajută-mă să-l găsesc","Nu știu","Dispozitivele tale.","Adaugă dispozitivele pentru a primi ajutor mai rapid.","Adaugă dispozitiv","Salvează dispozitivul","Salvează în Dispozitivele mele","Numele dispozitivului","(opțional)","Salvat pentru această sesiune.","Depanează","Elimină","În curând","Salvează pentru mai târziu","Vezi detaliile lansării","Ce nu funcționează?","Altceva","Acces complet","Ghiduri avansate","Explorează ghidurile","Restabilește achizițiile","Gestionează abonamentul","Continuă cu ajutor gratuit","Ia-o de la capăt","Continuă depanarea","Pas","Numele de pe dispozitiv","Folosește numele","Încheie accesul demonstrativ","Nu sunt sigur","Încearcă Acces complet","Accesul tău complet","Continuă ghidul","Vezi rezumatul asistenței","Înapoi la ghidurile tale","Descoperă Acces complet","Revizuiește ghidul","Verifică rezultatul","Doar previzualizare. Nu se face nicio plată și nu se creează un abonament."]},{"code":"ru","name":"Russian","nativeName":"Русский","dir":"ltr","values":["Язык","Поиск языков","Закрыть","Основные элементы управления переведены. Подробные инструкции пока доступны на английском.","Немного помощи. Гораздо проще.","Давайте наладим вашу технику.","Выберите устройство. Будем двигаться шаг за шагом.","Или опишите своими словами","Введите устройство, приложение или проблему.","Начать","Я не уверен","Моя техника","Получить помощь","Другие параметры","Назад","Отмена","Продолжить","Загрузить ещё","Телевизоры и стриминг","Телефоны и планшеты","Ноутбуки","Настольные компьютеры","Принтеры и сканеры","Wi-Fi и интернет","Приложения и аккаунты","Другая техника","Какой бренд вы используете?","Какая у вас модель?","Какое ПО вы используете?","Другое / не уверен","Другая модель или продукт","Помогите найти","Я не знаю","Ваши устройства.","Добавьте устройства, чтобы быстрее получать помощь.","Добавить устройство","Сохранить устройство","Сохранить в «Моя техника»","Название устройства","(необязательно)","Сохранено на время сеанса.","Устранить проблему","Удалить","Скоро","Сохранить на потом","Подробности выпуска","Что не работает?","Что-то другое","Полный доступ","Расширенные инструкции","Просмотреть инструкции","Восстановить покупки","Управление подпиской","Продолжить бесплатную помощь","Начать заново","Продолжить диагностику","Шаг","Название на устройстве","Использовать название","Завершить демодоступ","Не уверен","Попробовать полный доступ","Ваш полный доступ","Продолжить инструкцию","Посмотреть сводку помощи","Вернуться к инструкциям","Узнать о полном доступе","Просмотреть инструкцию","Проверить результат","Только предварительный просмотр. Оплата не взимается, подписка не создаётся."]},{"code":"es","name":"Spanish","nativeName":"Español","dir":"ltr","values":["Idioma","Buscar idiomas","Cerrar","Los controles principales están traducidos. Las guías detalladas están en inglés.","Un poco de ayuda. Todo más sencillo.","Hagamos que tu tecnología funcione.","Elige tu dispositivo. Iremos paso a paso.","O cuéntanoslo con tus palabras","Escribe un dispositivo, una app o el problema.","Empezar","No estoy seguro","Mi tecnología","Obtener ayuda","Más opciones","Atrás","Cancelar","Continuar","Cargar más","TV y streaming","Teléfonos y tabletas","Portátiles","Ordenadores de sobremesa","Impresoras y escáneres","Wi-Fi e internet","Apps y cuentas","Otra tecnología","¿Qué marca usas?","¿Qué modelo tienes?","¿Qué software utilizas?","Otra / no estoy seguro","Otro modelo o producto","Ayúdame a encontrarlo","No lo sé","Tus dispositivos.","Añade tus dispositivos para recibir ayuda más rápido.","Añadir dispositivo","Guardar dispositivo","Guardar en Mi tecnología","Nombre del dispositivo","(opcional)","Guardado para esta sesión.","Solucionar problemas","Eliminar","Próximamente","Guardar para más tarde","Ver detalles del lanzamiento","¿Qué está fallando?","Otra cosa","Acceso completo","Guías avanzadas","Explorar guías","Restaurar compras","Gestionar suscripción","Continuar con ayuda gratuita","Empezar de nuevo","Seguir resolviendo","Paso","Nombre en tu dispositivo","Usar nombre","Finalizar acceso de prueba","No estoy seguro","Probar Acceso completo","Tu Acceso completo","Continuar tu guía","Ver resumen de asistencia","Volver a tus guías","Explorar Acceso completo","Revisar guía","Comprobar el resultado","Solo vista previa. No se realiza ningún pago ni se crea una suscripción."]},{"code":"sw","name":"Swahili","nativeName":"Kiswahili","dir":"ltr","values":["Lugha","Tafuta lugha","Funga","Vidhibiti vikuu vimetafsiriwa. Miongozo ya kina kwa sasa iko kwa Kiingereza.","Msaada kidogo. Urahisi mkubwa.","Hebu tufanye kifaa chako kifanye kazi.","Chagua kifaa chako. Tutakwenda hatua kwa hatua.","Au tueleze kwa maneno yako mwenyewe","Andika jina la kifaa, programu, au tatizo lililotokea.","Anza","Sina uhakika","Vifaa Vyangu","Pata msaada","Chaguo zaidi","Rudi","Ghairi","Endelea","Pakia zaidi","Televisheni na utiririshaji","Simu na tableti","Kompyuta mpakato","Kompyuta za mezani","Printa na skana","Wi-Fi na intaneti","Programu na akaunti","Teknolojia nyingine","Unatumia chapa gani?","Una modeli gani?","Unatumia programu gani?","Nyingine / sina uhakika","Modeli au bidhaa nyingine","Nisaidie kuipata","Sijui","Vifaa vyako.","Ongeza vifaa vyako ili kupata msaada haraka zaidi.","Ongeza kifaa","Hifadhi kifaa","Hifadhi kwenye Vifaa Vyangu","Jina la utani la kifaa","(si lazima)","Kimehifadhiwa kwa kipindi hiki.","Tatua tatizo","Ondoa","Inakuja hivi karibuni","Hifadhi kwa baadaye","Tazama maelezo ya uzinduzi","Kuna tatizo gani?","Jambo lingine","Ufikiaji Kamili","Miongozo ya kiwango cha juu","Vinjari miongozo","Rejesha manunuzi","Dhibiti usajili","Endelea na msaada wa bure","Anza tena","Endelea kutatua tatizo","Hatua","Jina lililo kwenye kifaa chako","Tumia jina","Maliza ufikiaji wa onyesho","Sina uhakika","Hakiki Ufikiaji Kamili","Ufikiaji wako Kamili","Endelea na mwongozo wako","Tazama muhtasari wa usaidizi","Rudi kwenye miongozo yako","Gundua Ufikiaji Kamili","Pitia mwongozo","Kagua matokeo","Huu ni mwonekano wa awali tu. Hakuna malipo yatakayofanyika wala usajili utakaoanzishwa."]},{"code":"sv","name":"Swedish","nativeName":"Svenska","dir":"ltr","values":["Språk","Sök språk","Stäng","De viktigaste kontrollerna är översatta. Detaljerade guider finns för närvarande på engelska.","Lite hjälp. Mycket enklare.","Låt oss få din teknik att fungera.","Välj din enhet. Vi tar det steg för steg.","Eller beskriv det med egna ord","Skriv en enhet, app eller vad som gick fel.","Starta","Jag är osäker","Min teknik","Få hjälp","Fler alternativ","Tillbaka","Avbryt","Fortsätt","Visa fler","TV och streaming","Telefoner och surfplattor","Bärbara datorer","Stationära datorer","Skrivare och skannrar","Wi-Fi och internet","Appar och konton","Annan teknik","Vilket märke använder du?","Vilken modell har du?","Vilken programvara använder du?","Annat / osäker","Annan modell eller produkt","Hjälp mig hitta den","Jag vet inte","Dina enheter.","Lägg till dina enheter för att få hjälp snabbare.","Lägg till enhet","Spara enhet","Spara i Min teknik","Enhetens smeknamn","(valfritt)","Sparat för den här sessionen.","Felsök","Ta bort","Kommer snart","Spara till senare","Visa lanseringsdetaljer","Vad fungerar inte?","Något annat","Full tillgång","Avancerade guider","Bläddra bland guider","Återställ köp","Hantera prenumeration","Fortsätt med gratis hjälp","Börja om","Fortsätt felsöka","Steg","Namnet på din enhet","Använd namn","Avsluta demoåtkomst","Osäker","Prova Full tillgång","Din fulla tillgång","Fortsätt din guide","Visa hjälpsammanfattning","Tillbaka till dina guider","Upptäck Full tillgång","Granska guide","Kontrollera resultatet","Endast förhandsvisning. Ingen betalning görs och ingen prenumeration skapas."]},{"code":"ta","name":"Tamil","nativeName":"தமிழ்","dir":"ltr","values":["மொழி","மொழிகளைத் தேடுங்கள்","மூடு","முக்கிய கட்டுப்பாடுகள் மொழிபெயர்க்கப்பட்டுள்ளன. விரிவான வழிகாட்டிகள் தற்போது ஆங்கிலத்தில் உள்ளன.","சிறிய உதவி. மிக எளிதாகும்.","உங்கள் சாதனத்தைச் செயல்பட வைப்போம்.","உங்கள் சாதனத்தைத் தேர்ந்தெடுங்கள். படிப்படியாகச் செல்வோம்.","அல்லது உங்கள் சொந்த வார்த்தைகளில் சொல்லுங்கள்","சாதனம் அல்லது செயலியின் பெயரை எழுதுங்கள், அல்லது சிக்கலை விவரியுங்கள்.","தொடங்கு","எனக்கு உறுதியாகத் தெரியவில்லை","என் சாதனங்கள்","உதவி பெறுங்கள்","மேலும் விருப்பங்கள்","பின்","ரத்து செய்","தொடரவும்","மேலும் ஏற்று","தொலைக்காட்சிகள் மற்றும் ஸ்ட்ரீமிங்","தொலைபேசிகள் மற்றும் டேப்லெட்டுகள்","மடிக்கணினிகள்","மேசைக் கணினிகள்","அச்சுப்பொறிகள் மற்றும் ஸ்கேனர்கள்","வைஃபை மற்றும் இணையம்","செயலிகள் மற்றும் கணக்குகள்","பிற தொழில்நுட்பம்","எந்த பிராண்டைப் பயன்படுத்துகிறீர்கள்?","உங்களிடம் எந்த மாடல் உள்ளது?","எந்த மென்பொருளைப் பயன்படுத்துகிறீர்கள்?","வேறு / உறுதியாகத் தெரியவில்லை","வேறு மாடல் அல்லது தயாரிப்பு","இதைக் கண்டுபிடிக்க உதவுங்கள்","எனக்குத் தெரியாது","உங்கள் சாதனங்கள்.","விரைவாக உதவி பெற உங்கள் சாதனங்களைச் சேருங்கள்.","சாதனத்தைச் சேர்","சாதனத்தைச் சேமி","என் சாதனங்களில் சேமி","சாதனத்தின் செல்லப்பெயர்","(விருப்பத்திற்குரியது)","இந்த அமர்வுக்காகச் சேமிக்கப்பட்டது.","சிக்கலைத் தீர்க்கவும்","அகற்று","விரைவில் வருகிறது","பின்னர் பார்க்கச் சேமி","வெளியீட்டு விவரங்களைப் பார்","என்ன சிக்கல் ஏற்படுகிறது?","வேறு ஏதாவது","முழு அணுகல்","மேம்பட்ட வழிகாட்டிகள்","வழிகாட்டிகளைப் பார்","வாங்கியவற்றை மீட்டெடு","சந்தாவை நிர்வகி","இலவச உதவியுடன் தொடரவும்","மீண்டும் தொடங்கு","சிக்கலைத் தீர்ப்பதைத் தொடரவும்","படி","உங்கள் சாதனத்தில் உள்ள பெயர்","பெயரைப் பயன்படுத்து","டெமோ அணுகலை முடி","உறுதியாகத் தெரியவில்லை","முழு அணுகல் முன்னோட்டம்","உங்கள் முழு அணுகல்","உங்கள் வழிகாட்டியைத் தொடரவும்","ஆதரவுச் சுருக்கத்தைப் பார்","உங்கள் வழிகாட்டிகளுக்குத் திரும்பு","முழு அணுகலைப் பற்றி அறிக","வழிகாட்டியை மதிப்பாய்வு செய்","முடிவைச் சரிபார்","முன்னோட்டம் மட்டுமே. கட்டணம் வசூலிக்கப்படாது; சந்தாவும் தொடங்கப்படாது."]},{"code":"te","name":"Telugu","nativeName":"తెలుగు","dir":"ltr","values":["భాష","భాషలను వెతకండి","మూసివేయి","ప్రధాన నియంత్రణలు అనువదించబడ్డాయి. వివరణాత్మక గైడ్‌లు ప్రస్తుతం ఆంగ్లంలో ఉన్నాయి.","కొంచెం సహాయం. ఎంతో సులభం.","మీ పరికరాన్ని పని చేసేలా చేద్దాం.","మీ పరికరాన్ని ఎంచుకోండి. ఒక్కో దశగా ముందుకు వెళ్దాం.","లేదా మీ మాటల్లో చెప్పండి","పరికరం లేదా యాప్ పేరు రాయండి, లేదా సమస్యను వివరించండి.","ప్రారంభించండి","నాకు ఖచ్చితంగా తెలియదు","నా పరికరాలు","సహాయం పొందండి","మరిన్ని ఎంపికలు","వెనుకకు","రద్దు చేయి","కొనసాగించండి","మరిన్ని లోడ్ చేయి","టీవీలు మరియు స్ట్రీమింగ్","ఫోన్‌లు మరియు టాబ్లెట్‌లు","ల్యాప్‌టాప్‌లు","డెస్క్‌టాప్ కంప్యూటర్లు","ప్రింటర్లు మరియు స్కానర్లు","వై-ఫై మరియు ఇంటర్నెట్","యాప్‌లు మరియు ఖాతాలు","ఇతర సాంకేతికత","మీరు ఏ బ్రాండ్ ఉపయోగిస్తున్నారు?","మీ దగ్గర ఏ మోడల్ ఉంది?","మీరు ఏ సాఫ్ట్‌వేర్ ఉపయోగిస్తున్నారు?","వేరేది / ఖచ్చితంగా తెలియదు","వేరే మోడల్ లేదా ఉత్పత్తి","దాన్ని కనుగొనడంలో నాకు సహాయం చేయండి","నాకు తెలియదు","మీ పరికరాలు.","త్వరగా సహాయం పొందడానికి మీ పరికరాలను జోడించండి.","పరికరాన్ని జోడించు","పరికరాన్ని సేవ్ చేయి","నా పరికరాలలో సేవ్ చేయి","పరికరం ముద్దుపేరు","(ఐచ్ఛికం)","ఈ సెషన్ కోసం సేవ్ చేయబడింది.","సమస్యను పరిష్కరించండి","తీసివేయి","త్వరలో వస్తోంది","తర్వాత కోసం సేవ్ చేయి","విడుదల వివరాలు చూడండి","ఏ సమస్య వస్తోంది?","ఇంకేదైనా","పూర్తి యాక్సెస్","అధునాతన గైడ్‌లు","గైడ్‌లను చూడండి","కొనుగోళ్లను పునరుద్ధరించు","సబ్‌స్క్రిప్షన్‌ను నిర్వహించు","ఉచిత సహాయంతో కొనసాగించండి","మళ్లీ ప్రారంభించండి","సమస్య పరిష్కారాన్ని కొనసాగించండి","దశ","మీ పరికరంపై ఉన్న పేరు","పేరును ఉపయోగించు","డెమో యాక్సెస్‌ను ముగించు","ఖచ్చితంగా తెలియదు","పూర్తి యాక్సెస్ ప్రివ్యూ","మీ పూర్తి యాక్సెస్","మీ గైడ్‌ను కొనసాగించండి","సహాయ సారాంశాన్ని చూడండి","మీ గైడ్‌లకు తిరిగి వెళ్లండి","పూర్తి యాక్సెస్ గురించి తెలుసుకోండి","గైడ్‌ను సమీక్షించండి","ఫలితాన్ని తనిఖీ చేయండి","ప్రివ్యూ మాత్రమే. చెల్లింపు జరగదు; సబ్‌స్క్రిప్షన్ ప్రారంభం కాదు."]},{"code":"th","name":"Thai","nativeName":"ไทย","dir":"ltr","values":["ภาษา","ค้นหาภาษา","ปิด","ปุ่มควบคุมหลักได้รับการแปลแล้ว คู่มือแบบละเอียดในขณะนี้ยังเป็นภาษาอังกฤษ","ช่วยอีกนิด ง่ายขึ้นอีกเยอะ","มาทำให้อุปกรณ์ของคุณใช้งานได้กัน","เลือกอุปกรณ์ของคุณ แล้วเราจะทำไปทีละขั้นตอน","หรือเล่าให้เราฟังด้วยคำพูดของคุณเอง","พิมพ์ชื่ออุปกรณ์ แอป หรือปัญหาที่เกิดขึ้น","เริ่ม","ฉันไม่แน่ใจ","อุปกรณ์ของฉัน","รับความช่วยเหลือ","ตัวเลือกเพิ่มเติม","ย้อนกลับ","ยกเลิก","ดำเนินการต่อ","โหลดเพิ่มเติม","ทีวีและสตรีมมิง","โทรศัพท์และแท็บเล็ต","แล็ปท็อป","คอมพิวเตอร์ตั้งโต๊ะ","เครื่องพิมพ์และสแกนเนอร์","Wi-Fi และอินเทอร์เน็ต","แอปและบัญชี","เทคโนโลยีอื่น ๆ","คุณใช้ยี่ห้ออะไร","คุณมีรุ่นอะไร","คุณใช้ซอฟต์แวร์อะไร","อื่น ๆ / ไม่แน่ใจ","รุ่นหรือผลิตภัณฑ์อื่น","ช่วยฉันค้นหา","ฉันไม่รู้","อุปกรณ์ของคุณ","เพิ่มอุปกรณ์ของคุณเพื่อรับความช่วยเหลือได้เร็วขึ้น","เพิ่มอุปกรณ์","บันทึกอุปกรณ์","บันทึกในอุปกรณ์ของฉัน","ชื่อเล่นของอุปกรณ์","(ไม่บังคับ)","บันทึกไว้สำหรับเซสชันนี้แล้ว","แก้ไขปัญหา","นำออก","เร็ว ๆ นี้","บันทึกไว้ดูภายหลัง","ดูรายละเอียดการเปิดตัว","เกิดปัญหาอะไรขึ้น","อย่างอื่น","การเข้าถึงแบบเต็ม","คู่มือขั้นสูง","ดูคู่มือ","กู้คืนการซื้อ","จัดการการสมัครสมาชิก","ดำเนินการต่อด้วยความช่วยเหลือฟรี","เริ่มใหม่","แก้ไขปัญหาต่อ","ขั้นตอน","ชื่อที่แสดงบนอุปกรณ์ของคุณ","ใช้ชื่อนี้","สิ้นสุดการเข้าถึงแบบสาธิต","ไม่แน่ใจ","ดูตัวอย่างการเข้าถึงแบบเต็ม","การเข้าถึงแบบเต็มของคุณ","อ่านคู่มือของคุณต่อ","ดูสรุปการช่วยเหลือ","กลับไปที่คู่มือของคุณ","สำรวจการเข้าถึงแบบเต็ม","ทบทวนคู่มือ","ตรวจสอบผลลัพธ์","เป็นเพียงตัวอย่าง ไม่มีการเรียกเก็บเงินหรือเริ่มการสมัครสมาชิก"]},{"code":"tr","name":"Turkish","nativeName":"Türkçe","dir":"ltr","values":["Dil","Dil ara","Kapat","Temel kontroller çevrilmiştir. Ayrıntılı kılavuzlar şu anda İngilizcedir.","Biraz yardım. Çok daha kolay.","Cihazlarını çalışır hâle getirelim.","Cihazını seç. Adım adım ilerleyeceğiz.","Ya da kendi sözlerinle anlat","Bir cihaz, uygulama veya sorunu yaz.","Başla","Emin değilim","Cihazlarım","Yardım al","Diğer seçenekler","Geri","İptal","Devam","Daha fazla yükle","TV ve yayın","Telefonlar ve tabletler","Dizüstü bilgisayarlar","Masaüstü bilgisayarlar","Yazıcılar ve tarayıcılar","Wi-Fi ve internet","Uygulamalar ve hesaplar","Diğer cihazlar","Hangi markayı kullanıyorsun?","Hangi modele sahipsin?","Hangi yazılımı kullanıyorsun?","Başka / emin değilim","Başka model veya ürün","Bulmama yardım et","Bilmiyorum","Cihazların.","Daha hızlı yardım almak için cihazlarını ekle.","Cihaz ekle","Cihazı kaydet","Cihazlarım’a kaydet","Cihaz takma adı","(isteğe bağlı)","Bu oturum için kaydedildi.","Sorun gider","Kaldır","Yakında","Daha sonrası için kaydet","Çıkış ayrıntılarını gör","Sorun nedir?","Başka bir şey","Tam erişim","Gelişmiş kılavuzlar","Kılavuzlara göz at","Satın alımları geri yükle","Aboneliği yönet","Ücretsiz yardımla devam et","Yeniden başla","Sorun gidermeye devam et","Adım","Cihazındaki ad","Adı kullan","Demo erişimini bitir","Emin değilim","Tam erişimi dene","Tam erişimin","Kılavuzuna devam et","Destek özetini gör","Kılavuzlarına dön","Tam erişimi keşfet","Kılavuzu incele","Sonucu kontrol et","Yalnızca önizleme. Ödeme alınmaz veya abonelik oluşturulmaz."]},{"code":"uk","name":"Ukrainian","nativeName":"Українська","dir":"ltr","values":["Мова","Пошук мов","Закрити","Основні елементи керування перекладено. Докладні інструкції наразі англійською.","Трохи допомоги. Значно простіше.","Налагодьмо вашу техніку.","Виберіть пристрій. Рухатимемося крок за кроком.","Або опишіть своїми словами","Введіть пристрій, застосунок або проблему.","Почати","Не впевнений","Моя техніка","Отримати допомогу","Інші параметри","Назад","Скасувати","Продовжити","Завантажити ще","Телевізори та стримінг","Телефони та планшети","Ноутбуки","Настільні комп’ютери","Принтери та сканери","Wi-Fi та інтернет","Застосунки й облікові записи","Інша техніка","Яким брендом користуєтеся?","Яка у вас модель?","Яким ПЗ користуєтеся?","Інше / не впевнений","Інша модель або продукт","Допоможіть знайти","Не знаю","Ваші пристрої.","Додайте пристрої, щоб швидше отримувати допомогу.","Додати пристрій","Зберегти пристрій","Зберегти в «Моя техніка»","Назва пристрою","(необов’язково)","Збережено на час сеансу.","Усунути проблему","Видалити","Незабаром","Зберегти на потім","Переглянути подробиці випуску","Що не працює?","Щось інше","Повний доступ","Розширені інструкції","Переглянути інструкції","Відновити покупки","Керувати підпискою","Продовжити безкоштовну допомогу","Почати знову","Продовжити діагностику","Крок","Назва на пристрої","Використати назву","Завершити демодоступ","Не впевнений","Спробувати повний доступ","Ваш повний доступ","Продовжити інструкцію","Переглянути підсумок допомоги","Повернутися до інструкцій","Дізнатися про повний доступ","Переглянути інструкцію","Перевірити результат","Лише попередній перегляд. Оплата не стягується, підписка не створюється."]},{"code":"ur","name":"Urdu","nativeName":"اردو","dir":"rtl","values":["زبان","زبانیں تلاش کریں","بند کریں","بنیادی کنٹرولز کا ترجمہ کیا گیا ہے۔ تفصیلی رہنما فی الحال انگریزی میں ہیں۔","تھوڑی سی مدد۔ بہت زیادہ آسانی۔","آئیے آپ کے آلات کو چلائیں۔","اپنا آلہ منتخب کریں۔ ہم ایک ایک قدم آگے بڑھیں گے۔","یا اپنے الفاظ میں بتائیں","آلے یا ایپ کا نام لکھیں یا مسئلہ بیان کریں۔","شروع کریں","مجھے یقین نہیں","میرے آلات","مدد حاصل کریں","مزید اختیارات","واپس","منسوخ کریں","جاری رکھیں","مزید لوڈ کریں","ٹی وی اور اسٹریمنگ","فون اور ٹیبلٹ","لیپ ٹاپ","ڈیسک ٹاپ کمپیوٹر","پرنٹر اور اسکینر","وائی فائی اور انٹرنیٹ","ایپس اور اکاؤنٹس","دیگر ٹیکنالوجی","آپ کون سا برانڈ استعمال کرتے ہیں؟","آپ کے پاس کون سا ماڈل ہے؟","آپ کون سا سافٹ ویئر استعمال کر رہے ہیں؟","کوئی اور / یقین نہیں","کوئی اور ماڈل یا پروڈکٹ","اسے ڈھونڈنے میں میری مدد کریں","مجھے معلوم نہیں","آپ کے آلات۔","جلد مدد حاصل کرنے کے لیے اپنے آلات شامل کریں۔","آلہ شامل کریں","آلہ محفوظ کریں","میرے آلات میں محفوظ کریں","آلے کا عرفی نام","(اختیاری)","اس سیشن کے لیے محفوظ ہو گیا۔","خرابی دور کریں","ہٹائیں","جلد آ رہا ہے","بعد کے لیے محفوظ کریں","لانچ کی تفصیلات دیکھیں","کیا مسئلہ پیش آ رہا ہے؟","کچھ اور","مکمل رسائی","تفصیلی رہنما","رہنما دیکھیں","خریداریاں بحال کریں","سبسکرپشن کا انتظام کریں","مفت مدد کے ساتھ جاری رکھیں","دوبارہ شروع کریں","خرابی دور کرنا جاری رکھیں","مرحلہ","آپ کے آلے پر درج نام","نام استعمال کریں","ڈیمو رسائی ختم کریں","یقین نہیں","مکمل رسائی کا پیش نظارہ","آپ کی مکمل رسائی","اپنا رہنما جاری رکھیں","سپورٹ کا خلاصہ دیکھیں","اپنے رہنماؤں پر واپس جائیں","مکمل رسائی کے بارے میں جانیں","رہنما کا جائزہ لیں","نتیجہ چیک کریں","صرف پیش نظارہ ہے۔ کوئی ادائیگی نہیں ہوگی اور نہ ہی سبسکرپشن بنے گی۔"]},{"code":"vi","name":"Vietnamese","nativeName":"Tiếng Việt","dir":"ltr","values":["Ngôn ngữ","Tìm ngôn ngữ","Đóng","Các nút điều khiển chính đã được dịch. Hướng dẫn chi tiết hiện có bằng tiếng Anh.","Giúp một chút. Dễ hơn nhiều.","Cùng giúp thiết bị của bạn hoạt động trở lại.","Chọn thiết bị của bạn. Chúng ta sẽ thực hiện từng bước.","Hoặc mô tả bằng lời của bạn","Nhập tên thiết bị, ứng dụng hoặc mô tả sự cố.","Bắt đầu","Tôi không chắc","Thiết bị của tôi","Nhận trợ giúp","Tùy chọn khác","Quay lại","Hủy","Tiếp tục","Tải thêm","TV và phát trực tuyến","Điện thoại và máy tính bảng","Máy tính xách tay","Máy tính để bàn","Máy in và máy quét","Wi-Fi và internet","Ứng dụng và tài khoản","Công nghệ khác","Bạn dùng thương hiệu nào?","Bạn có mẫu máy nào?","Bạn đang dùng phần mềm nào?","Khác / không chắc","Mẫu máy hoặc sản phẩm khác","Giúp tôi tìm","Tôi không biết","Thiết bị của bạn.","Thêm thiết bị để được trợ giúp nhanh hơn.","Thêm thiết bị","Lưu thiết bị","Lưu vào Thiết bị của tôi","Tên gọi riêng của thiết bị","(không bắt buộc)","Đã lưu cho phiên này.","Khắc phục sự cố","Xóa","Sắp ra mắt","Lưu để xem sau","Xem thông tin ra mắt","Bạn đang gặp vấn đề gì?","Vấn đề khác","Truy cập đầy đủ","Hướng dẫn nâng cao","Duyệt hướng dẫn","Khôi phục giao dịch mua","Quản lý gói đăng ký","Tiếp tục với trợ giúp miễn phí","Bắt đầu lại","Tiếp tục khắc phục sự cố","Bước","Tên trên thiết bị của bạn","Dùng tên này","Kết thúc quyền truy cập bản demo","Không chắc","Xem trước Truy cập đầy đủ","Quyền truy cập đầy đủ của bạn","Tiếp tục hướng dẫn của bạn","Xem tóm tắt hỗ trợ","Quay lại hướng dẫn của bạn","Khám phá Truy cập đầy đủ","Xem lại hướng dẫn","Kiểm tra kết quả","Chỉ xem trước. Không phát sinh thanh toán hay gói đăng ký."]}],"guideContentLanguage":"en","coverage":"Core navigation, categories, selection and premium actions; detailed guides remain English."};
  // Core interface localization. Device identities and guide content are not translated.
  const localeState={code:'en'};
  const localeRecords=Object.fromEntries(LS_LANGUAGE_PACK.languages.map(item=>[item.code,item]));
  const localeKeyIndex=new Map(LS_LANGUAGE_PACK.keys.map((key,index)=>[key,index]));
  const localeOriginalText=new WeakMap(),localeOriginalAttributes=new WeakMap();
  const localeAliases={
    "I'm not sure":'I’m not sure','← Back':'Back','→ Back':'Back',
    'Which brand is it?':'Which brand do you use?','Who makes the app?':'Which brand do you use?',
    'Which software do you use?':'Which software are you using?','Which software or service?':'Which software are you using?',
    'What would you like to add?':'Add device','Which app or service?':'Apps & accounts',
    'Type a brand, model, app or what went wrong.':'Type a device, app or what went wrong.',
    'Search for your device or describe the problem':'Type a device, app or what went wrong.',
    'Tech help, one step at a time.':'A little help. A lot simpler.','One small step at a time':'A little help. A lot simpler.',
    'Start a new search?':'Start again',
    'Load More brands':'Load More','Load More models and products':'Load More',
    'Name on your device or software':'Name on your device','Brand name':'Name on your device',
    'Model or product name':'Name on your device','Another brand':'Another / not sure',
    'Choose a problem':'What is going wrong?','Back to models':'Back',
    'Browse available guides':'Browse guides','Browse available advanced guides':'Browse guides',
    'See Full Access':'Explore Full Access','Keep using free help':'Continue with free help',
    'Back to free help':'Continue with free help','Free guided check':'Get help',
    'Show listed models':'Help me find it','Find your model':'Help me find it'
  };
  function localeText(value,code=localeState.code){
    const original=String(value??''),record=localeRecords[code]||localeRecords.en;
    if(record.code==='en')return original;
    const core=original.trim(),key=localeAliases[core]||core,index=localeKeyIndex.get(key);
    let translated=index===undefined?null:record.values[index];
    if(translated!==null&&translated!==undefined){
      if(core==='← Back'||core==='→ Back')translated=(record.dir==='rtl'?'→ ':'← ')+translated;
      return original.replace(core,translated);
    }
    if(core==='Saved to My Tech')return '✓ '+localeText('My Tech',code);
    if(/^Step \d+$/.test(core))return localeText('Step',code)+' '+core.slice(5);
    if(core.startsWith('Full Access · '))return localeText('Full Access',code)+core.slice(11);
    if(core.startsWith('Add device · '))return localeText('Add device',code)+core.slice(10);
    if(core.startsWith('See Full Access · '))return localeText('Explore Full Access',code)+core.slice(15);
    return original;
  }
  function localizedSearchQuery(value){
    if(localeState.code==='en')return value;
    const currentLocale=localeRecords[localeState.code],norm=value=>String(value).normalize('NFKC').toLocaleLowerCase().trim();
    const query=norm(value),categories=['TVs & streaming','Phones & tablets','Laptops','Desktop computers','Printers & scanners','Wi-Fi & internet','Apps & accounts','Other technology'];
    const searchWords=['TV','phone','laptop','desktop','printer','wifi','app','headphones'];
    for(let index=0;index<categories.length;index++){
      const translated=norm(currentLocale.values[localeKeyIndex.get(categories[index])]);
      if(query===translated)return searchWords[index];
      if(query.includes(translated))return query.replace(translated,searchWords[index]);
    }
    return value;
  }
  const languageButton=document.createElement('button');languageButton.type='button';languageButton.className='ls-language-button cursor-interaction';languageButton.setAttribute('aria-label','Language');languageButton.setAttribute('aria-expanded','false');languageButton.setAttribute('aria-controls','ls-language-panel');
  const languageIcon=document.createElement('i');languageIcon.setAttribute('data-lucide','languages');languageIcon.setAttribute('aria-hidden','true');languageButton.appendChild(languageIcon);
  const languageCode=document.createElement('span');languageCode.className='ls-language-code';languageCode.textContent='EN';languageButton.appendChild(languageCode);
  root.querySelector('.ls-header-actions').insertBefore(languageButton,aboutButton);
  const languagePanel=document.createElement('section');languagePanel.id='ls-language-panel';languagePanel.className='ls-language-panel';languagePanel.hidden=true;languagePanel.setAttribute('aria-labelledby','ls-language-title');
  const languageTop=document.createElement('div');languageTop.className='ls-language-top';
  const languageTitle=document.createElement('h3');languageTitle.id='ls-language-title';languageTitle.textContent='Language';languageTop.appendChild(languageTitle);
  const languageClose=document.createElement('button');languageClose.type='button';languageClose.className='ls-language-close cursor-interaction';languageClose.textContent='Close';languageTop.appendChild(languageClose);languagePanel.appendChild(languageTop);
  const languageSearchLabel=document.createElement('label');languageSearchLabel.htmlFor='ls-language-search';languageSearchLabel.textContent='Search languages';languagePanel.appendChild(languageSearchLabel);
  const languageSearch=document.createElement('input');languageSearch.id='ls-language-search';languageSearch.className='ls-language-search';languageSearch.type='search';languageSearch.placeholder='Search languages';languageSearch.autocomplete='off';languagePanel.appendChild(languageSearch);
  const languageSelect=document.createElement('select');languageSelect.className='ls-language-select';languageSelect.size=5;languageSelect.setAttribute('aria-label','Language');languagePanel.appendChild(languageSelect);
  const languagePanelNote=document.createElement('p');languagePanelNote.className='ls-language-panel-note';languagePanelNote.textContent='Key controls are translated. Detailed guides are currently in English.';languagePanel.appendChild(languagePanelNote);
  const languageNote=document.createElement('p');languageNote.className='ls-language-note';languageNote.textContent='Key controls are translated. Detailed guides are currently in English.';languageNote.hidden=true;
  phoneSurface.insertBefore(languagePanel,helpPanel);phoneSurface.insertBefore(languageNote,helpPanel);
  function fillLanguageChoices(filter=''){
    const search=filter.normalize('NFKC').toLocaleLowerCase().trim();languageSelect.replaceChildren();
    for(const record of LS_LANGUAGE_PACK.languages){
      if(search&&!`${record.name} ${record.nativeName} ${record.code}`.normalize('NFKC').toLocaleLowerCase().includes(search))continue;
      const option=document.createElement('option');option.value=record.code;option.lang=record.code;option.dir=record.dir;option.textContent=record.name===record.nativeName?record.nativeName:record.nativeName+' · '+record.name;option.selected=record.code===localeState.code;languageSelect.appendChild(option);
    }
    languageSelect.value=localeState.code;
  }
  function translateUI(){
    const record=localeRecords[localeState.code]||localeRecords.en;
    if(root.getAttribute('lang')!==record.code)root.setAttribute('lang',record.code);
    if(root.getAttribute('dir')!==record.dir)root.setAttribute('dir',record.dir);
    languageCode.textContent===record.code.toUpperCase()||(languageCode.textContent=record.code.toUpperCase());
    languageNote.hidden=record.code==='en';
    const protectedSelector='script,style,svg,.ls-language-select,.ls-language-code,.ls-saved-title,.ls-saved-subtitle,.ls-summary-copy,.th-case,.ls-brand-context,.th-suggestion';
    if(document.createTreeWalker){
      const walker=document.createTreeWalker(root,4);let node;
      while((node=walker.nextNode())){
        const parent=node.parentElement;if(!parent||parent.closest(protectedSelector)||parent.closest('.ls-brand-card')&&parent.classList.contains('ls-choice-label'))continue;
        if(parent===q&&current==='upcoming_model')continue;
        const value=node.nodeValue;let saved=localeOriginalText.get(node);
        if(!saved||value!==saved.rendered)saved={original:value};
        const rendered=localeText(saved.original);if(value!==rendered)node.nodeValue=rendered;
        saved.rendered=rendered;localeOriginalText.set(node,saved);
      }
    }
    for(const element of root.querySelectorAll('[aria-label],[placeholder],[title]')){
      if(element.matches('input:not([type="search"]),textarea'))continue;
      let saved=localeOriginalAttributes.get(element);if(!saved){saved={};localeOriginalAttributes.set(element,saved);}
      for(const attribute of ['aria-label','placeholder','title']){
        const value=element.getAttribute(attribute);if(value===null)continue;
        if(!saved[attribute]||value!==saved[attribute].rendered)saved[attribute]={original:value};
        const rendered=localeText(saved[attribute].original);if(value!==rendered)element.setAttribute(attribute,rendered);
        saved[attribute].rendered=rendered;
      }
    }
    for(const element of [q,detail,guideScope,guideCheck]){
      const text=element.textContent;
      const hasTranslation=record.code==='en'||record.values.some(value=>value===text);
      if(record.code!=='en'&&current!=='start'&&!hasTranslation){element.setAttribute('lang','en');element.setAttribute('dir','ltr');}
      else{element.removeAttribute('lang');element.removeAttribute('dir');}
    }
    // Keep long model names and user nicknames readable without mirroring product artwork.
    for(const element of root.querySelectorAll('.ls-brand-card .ls-choice-label,.ls-saved-title,.ls-saved-subtitle,.ls-summary-copy'))element.setAttribute('dir','auto');
  }
  function applyLocale(code){
    localeState.code=localeRecords[code]?code:'en';languageSelect.value=localeState.code;
    render(false);if(showingMyTech)renderSavedTech();translateUI();
  }
  function closeLanguagePanel(focus=true){languagePanel.hidden=true;languageButton.setAttribute('aria-expanded','false');if(focus)languageButton.focus({preventScroll:true});}
  languageButton.addEventListener('click',()=>{
    if(!languagePanel.hidden){closeLanguagePanel();return;}
    closeOptionsMenu();languagePanel.hidden=false;languageButton.setAttribute('aria-expanded','true');languageSearch.value='';fillLanguageChoices();translateUI();languageSearch.focus({preventScroll:true});
  });
  languageClose.addEventListener('click',()=>closeLanguagePanel());
  languagePanel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeLanguagePanel();}});
  languageSearch.addEventListener('input',()=>fillLanguageChoices(languageSearch.value));
  languageSelect.addEventListener('change',()=>{if(languageSelect.value)applyLocale(languageSelect.value);});
  aboutButton.addEventListener('click',()=>closeLanguagePanel(false));
  const localeBaseRender=render;render=function(...args){const result=localeBaseRender(...args);translateUI();return result;};
  const localeBaseWizard=renderDeviceWizard;renderDeviceWizard=function(...args){const result=localeBaseWizard(...args);translateUI();return result;};
  const localeBaseMyTech=showMyTech;showMyTech=function(...args){const result=localeBaseMyTech(...args);translateUI();return result;};
  const localeBaseSaved=renderSavedTech;renderSavedTech=function(...args){const result=localeBaseSaved(...args);translateUI();return result;};
  const localeBaseSave=renderSaveDevice;renderSaveDevice=function(...args){const result=localeBaseSave(...args);translateUI();return result;};
  const localeBaseSuggestions=updateSuggestions;updateSuggestions=function(...args){const result=localeBaseSuggestions(...args);translateUI();return result;};
  fillLanguageChoices();
  // Observe later insertions such as coverage badges; self-written text is stable on the next pass.
  if(typeof MutationObserver!=='undefined'){
    const localeObserver=new MutationObserver(()=>translateUI());
    localeObserver.observe(root,{childList:true,characterData:true,subtree:true});
  }

  prepareIllustrations();
  // Native purchases are the only source of Full Access. Saved app data never grants it.
  const consumerConfig=window.LITTLE_STEPS_CONFIG||{};
  const consumerRuntime=window.LittleStepsRuntime;
  let consumerReady=false,onboardingComplete=false,subscriptionBusy=false,consumerStorageWritable=true,consumerPersistent=true;
  let subscriptionState={status:'unavailable',price:null,period:'year'},lastSavedState='';
  const consumerNotice=root.querySelector('.ls-consumer-notice');
  function showConsumerNotice(message,error=false){
    consumerNotice.textContent=message||'';consumerNotice.hidden=!message;
    consumerNotice.setAttribute('role',error?'alert':'status');
  }
  function annualPrice(){return subscriptionState.price?subscriptionState.price+' / year':'$49.99 / year · USD';}
  function consumerSnapshot(){
    return {schemaVersion:1,savedProfiles:[...savedProfiles,...retainedProfiles].map(cleanProfile),guideProgress:{...retainedProgress,...guideProgress},
      lastAdvancedGuide,language:localeState.code,onboardingComplete,updatedAt:new Date().toISOString()};
  }
  function persistConsumerState(){
    if(!consumerReady||!consumerRuntime||!consumerStorageWritable)return;
    const state=consumerSnapshot(),signature=JSON.stringify({...state,updatedAt:''});
    if(signature===lastSavedState)return;
    lastSavedState=signature;
    consumerRuntime.saveState(state).then(result=>{
      consumerPersistent=result.ok&&result.persistent!==false;
      if(!result.ok){lastSavedState='';root.querySelector('.ls-save-note').textContent='Changes may not be saved.';showConsumerNotice('Your changes could not be saved. Keep the app open and try again.',true);}
    });
  }
  function applySubscription(result){
    subscriptionState=result&&result.ok!==false?result:{status:'unavailable',price:null,period:'year'};
    hasFullAccess=subscriptionState.status==='active';
    if(!hasFullAccess&&['member_home','guide_step','guide_result','guide_help','guide_summary'].includes(current))current='full_access';
    render(false);
  }
  async function refreshSubscription(){
    if(!consumerRuntime)return;
    applySubscription(await consumerRuntime.getSubscription());
  }
  async function subscriptionAction(action){
    if(subscriptionBusy||!consumerRuntime)return;
    subscriptionBusy=true;showConsumerNotice(action==='restore'?'Checking your purchases…':'Connecting to the App Store…');render(false);
    const result=await consumerRuntime[action]();
    subscriptionBusy=false;
    if(action==='manageSubscription'){
      if(!result.ok)showConsumerNotice(result.error?.message||'Subscription settings are not available right now.',true);
      else showConsumerNotice('You can manage your subscription with Apple.');
      await refreshSubscription();return;
    }
    applySubscription(result);
    if(result.status==='active'){
      if(selectedGuide())rememberAdvanced();
      showConsumerNotice(action==='restore'?'Your Full Access has been restored.':'Full Access is ready.');
      current='member_home';render(true);
    }else if(result.outcome==='pending')showConsumerNotice('Your purchase is awaiting approval. You can keep using free help.');
    else if(result.outcome==='cancelled')showConsumerNotice('Purchase cancelled. You can keep using free help.');
    else if(action==='restore'&&result.status==='inactive')showConsumerNotice('No active Full Access subscription was found for this Apple Account.');
    else showConsumerNotice(result.message||result.error?.message||'The App Store is unavailable. Please try again later; free help is still available.',true);
    render(false);
  }
  function consumerNode(){
    if(current==='welcome')return {section:'Welcome to Loop',q:'Tech support, one tap at a time.',detail:'Choose your Apple device, follow small checks, and save it for next time. No account needed. Loop provides troubleshooting guides, not physical repairs or replacement parts.',scope:'Basic help is free. Full Access adds advanced guides. Detailed guides are currently in English.',list:true,choices:[["Let’s begin",'@onboarding_done',true],['How your data is used','privacy']]};
    if(current==='settings')return {section:'More options',q:'Make yourself at home.',detail:'Your devices, guide progress and language are saved on this device.',list:true,choices:[['Privacy','privacy'],['Terms of use','terms'],['Contact support','support_info'],['About Loop','about_app'],['Manage subscription','@manage_subscription'],['Erase saved app data','erase_data'],['Back to help','@free_checks']]};
    if(current==='privacy')return {section:'Privacy',q:'Your tech stays your business.',detail:'Loop saves device names, optional nicknames, language and guide progress on this device. No Loop account is required. This version has no advertising or analytics SDK.',scope:'Apple handles purchases. Loop does not receive your card details. Opening manufacturer links uses their websites. A support summary is shared only when you choose to share it. Device backups may include your saved app data.',list:true,choices:[['Erase saved app data','erase_data'],['Back','@back']],links:consumerConfig.privacyURL?[{label:'Read the privacy policy',url:consumerConfig.privacyURL}]:[]};
    if(current==='terms')return {section:'Terms of use',q:'Help you can take at your pace.',detail:'Guides cover the devices and software stated in their scope. Follow only steps that match what you see. Loop is an independent service and is not affiliated with the brands in the catalogue.',scope:'Full Access renews yearly until cancelled with Apple. Your App Store confirms the local price and billing terms before purchase. Basic checks and My Tech remain free.',list:true,choices:[['Back','@back']],links:[{label:'Apple standard licence agreement',url:'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/'},...(consumerConfig.termsURL?[{label:'Loop terms',url:consumerConfig.termsURL}]:[])]};
    if(current==='support_info')return {section:'Support',q:'Let’s get you the right help.',detail:consumerConfig.supportEmail?'For help with Loop, contact '+consumerConfig.supportEmail+'.':'For device-specific help, use the official support link in your guide. Loop support details will appear here before launch.',scope:'Never send passwords, full card numbers or account recovery codes. You can share a guide summary after your checks.',list:true,choices:[...(consumerConfig.supportEmail?[['Email Loop','@contact_support']]:[]),['Browse device help','start'],['Back','@back']]};
    if(current==='about_app')return {section:'About Loop',q:'Small checks. Clear next steps.',detail:'Loop provides guided troubleshooting for Apple devices and software. It does not sell parts, book repairs or perform physical repairs.',scope:'Catalogue reviewed '+TECH_CATALOG_META.reviewedAt+'. Availability can differ by region. The catalogue is curated and updated with app releases; it is not a live product feed. Device illustrations represent product families.',list:true,choices:[['How Loop works','welcome'],['Privacy','privacy'],['Terms of use','terms'],['Back','@back']]};
    if(current==='erase_data')return {section:'Your saved data',q:'Erase saved app data?',detail:'This removes My Tech devices, nicknames, guide progress and your language preference from this app on this device. This cannot be undone.',scope:'Your Apple subscription is not cancelled or deleted. You can manage it separately with Apple.',list:true,choices:[['Keep my data','@back'],['Erase my saved data','@erase_confirm']]};
    if(current==='full_access')return {section:'Loop · Full Access',q:'A little more help. A lot more clarity.',detail:guideForConsumerTitle(),plan:true,list:true,choices:[[hasFullAccess?'Your Full Access':subscriptionBusy?'Please wait…':subscriptionState.price?'Subscribe · '+annualPrice():'Check App Store availability',hasFullAccess?'@member_home':'@purchase',true],['Full Access devices','paid_catalog'],['Browse guides','guide_library'],['Continue with free help','@free_checks'],['Restore purchases','@restore'],['Manage subscription','@manage_subscription']]};
    if(current==='billing_info')return {section:'Full Access',q:'Your subscription is managed by Apple.',detail:'Use Restore purchases with the Apple Account used to subscribe. To view your renewal date or cancel, open Manage subscription.',list:true,choices:[['Restore purchases','@restore'],['Manage subscription','@manage_subscription'],['Continue with free help','@free_checks']]};
    return null;
  }
  function guideForConsumerTitle(){return selectedGuide()?'A closer look: '+selectedGuide().title:ADVANCED_GUIDES.length+' advanced guides, with clear checks and official sources.';}
  const consumerBaseDynamicNode=dynamicNode;
  dynamicNode=function(){return consumerNode()||consumerBaseDynamicNode();};
  const consumerBaseRender=render;
  render=function(...args){
    const result=consumerBaseRender(...args);
    const price=root.querySelector('.ls-plan-price');price.textContent=annualPrice();
    root.querySelector('.ls-plan-renewal').textContent=subscriptionState.price?'Billed yearly through Apple. Renews automatically unless cancelled at least 24 hours before the current period ends. Basic checks stay free.':'US plan: $49.99 per year. The App Store confirms your local price before purchase. Basic checks stay free.';
    root.querySelector('.ls-plan-demo').textContent=hasFullAccess?'Your Full Access subscription is active.':subscriptionState.price?'Payment is charged to your Apple Account after you confirm.':'Connect to the App Store to check availability.';
    const buy=options.children[0];if(current==='full_access'&&buy){buy.disabled=subscriptionBusy;buy.setAttribute('aria-busy',String(subscriptionBusy));}
    for(const button of options.children)if(['@restore','@manage_subscription'].includes(button.dataset.action))button.disabled=subscriptionBusy;
    root.querySelector('.ls-share-summary').hidden=current!=='guide_summary'||!hasFullAccess;
    root.querySelector('.ls-save-note').textContent=!consumerPersistent?'Changes may not be saved.':savedProfiles.length?'Saved on this device.':'Your saved devices will appear here.';
    root.querySelector('.th-demo').textContent='1.0.0';
    endPreview.hidden=true;
    persistConsumerState();return result;
  };
  const consumerBaseGo=go;
  go=function(to,patch){
    if(['@purchase','@restore','@manage_subscription'].includes(to)){subscriptionAction({'@purchase':'purchase','@restore':'restore','@manage_subscription':'manageSubscription'}[to]);return;}
    if(to==='@preview_access')return;
    if(to==='@onboarding_done'){onboardingComplete=true;current='start';history.length=0;render(true);return;}
    if(to==='@erase_confirm'){eraseConsumerData();return;}
    if(to==='@contact_support'){if(consumerConfig.supportEmail)window.location.href='mailto:'+consumerConfig.supportEmail;return;}
    return consumerBaseGo(to,patch);
  };
  const consumerBaseStore=storeProfile;
  storeProfile=function(profile){
    if(savedProfiles.length>=100&&!savedProfiles.some(p=>profileKey(p)===profileKey(profile))){showConsumerNotice('You have saved 100 devices. Remove one from My Tech before adding another.',true);return;}
    consumerBaseStore(profile);persistConsumerState();
  };
  const consumerBaseSavedRender=renderSavedTech;
  renderSavedTech=function(...args){const result=consumerBaseSavedRender(...args);persistConsumerState();return result;};
  const consumerBaseRemember=rememberAdvanced;
  rememberAdvanced=function(...args){const result=consumerBaseRemember(...args);persistConsumerState();return result;};
  const consumerBaseLocale=applyLocale;
  applyLocale=function(code){const result=consumerBaseLocale(code);persistConsumerState();return result;};
  async function eraseConsumerData(){
    if(!consumerRuntime)return;
    consumerReady=false;
    const result=await consumerRuntime.clearState();
    if(!result.ok){consumerReady=true;showConsumerNotice('Your saved data could not be erased. Please try again.',true);return;}
    savedProfiles.splice(0);retainedProfiles.splice(0);for(const id of Object.keys(retainedProgress))delete retainedProgress[id];for(const key of Object.keys(guideProgress))delete guideProgress[key];
    lastAdvancedGuide=null;lastSavedState='';onboardingComplete=false;facts={};history.length=0;deviceDraft=null;deviceHistory.length=0;input.value='';selectedCandidate=null;
    current='welcome';localeState.code='en';showMyTech(false);consumerStorageWritable=true;consumerPersistent=true;consumerReady=true;render(true);
    showConsumerNotice('Your saved app data has been erased.');
  }
  root.querySelector('.ls-settings-menu').addEventListener('click',()=>{showMyTech(false);go('settings');});
  root.querySelector('.ls-share-summary').addEventListener('click',async()=>{
    if(!hasFullAccess||!consumerRuntime||current!=='guide_summary')return;
    const result=await consumerRuntime.shareSummary(guideSummary.textContent,'Loop support summary');
    if(!result.ok)showConsumerNotice(result.error?.message||'This summary could not be shared.',true);
    else if(result.copied)showConsumerNotice('Support summary copied.');
  });
  window.addEventListener('littleStepsStorageError',()=>showConsumerNotice('Storage is unavailable. Changes may not be kept after you close the app.',true));
  window.addEventListener('littleStepsSubscriptionChanged',()=>refreshSubscription());
  window.addEventListener('pageshow',()=>{if(consumerReady)refreshSubscription();});
  window.addEventListener('pagehide',persistConsumerState);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&consumerReady)refreshSubscription();else persistConsumerState();});
  async function bootstrapConsumer(){
    phoneSurface.setAttribute('aria-busy','true');root.classList.add('ls-booting');
    let saved=null;
    if(consumerRuntime){const result=await consumerRuntime.loadState();saved=result.state;consumerStorageWritable=result.ok===true;consumerPersistent=result.ok&&result.persistent!==false;if(!result.ok||result.persistent===false)showConsumerNotice(result.error?.code==='state_version'?'Your saved data belongs to a newer app version. Update Loop to use it. Your existing data has been kept.':'Storage is unavailable. Your devices may not be kept after you close the app.',true);}
    else showConsumerNotice('The app could not load its storage service. Please reopen it.',true);
    if(saved){
      for(const profile of saved.savedProfiles||[])if(typeof profile.modelLabel==='string'){if(TECH_CATALOG[profile.category]&&profile.brand==='Apple')savedProfiles.push(cleanProfile(profile));else retainedProfiles.push(cleanProfile(profile));}
      for(const [id,value] of Object.entries(saved.guideProgress||{})){
        const guide=ADVANCED_GUIDES.find(g=>g.id===id);
        if(!guide){retainedProgress[id]=value;continue;}if(!value||!value.facts||!Number.isInteger(value.step))continue;
        guideProgress[id]={caseKey:String(value.caseKey||''),facts:{...cleanProfile(value.facts),guideId:id,guideStep:Math.min(Math.max(value.step,0),guide.steps.length-1),browsing:value.facts.browsing===true},step:Math.min(Math.max(value.step,0),guide.steps.length-1),done:value.done===true,events:Array.isArray(value.events)?value.events.slice(0,guide.steps.length).filter(e=>e&&typeof e.title==='string'&&typeof e.answer==='string'):[]};
      }
      lastAdvancedGuide=guideProgress[saved.lastAdvancedGuide]?saved.lastAdvancedGuide:null;
      localeState.code=localeRecords[saved.language]?saved.language:'en';onboardingComplete=saved.onboardingComplete===true;
    }
    consumerReady=true;current=onboardingComplete?'start':'welcome';
    root.classList.remove('ls-booting');phoneSurface.removeAttribute('aria-busy');render(false);
    refreshSubscription();
  }
  bootstrapConsumer();

  root.querySelector('.ls-plan-privacy').addEventListener('click',()=>go('privacy'));
  root.querySelector('.ls-plan-terms').addEventListener('click',()=>go('terms'));

})();


