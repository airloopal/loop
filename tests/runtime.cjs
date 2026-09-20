/* Behavior checks for persistence, bridge failures and subscription fail-closed rules. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app/consumer-runtime.js'), 'utf8');
const KEY = 'little-steps-state-v1';
const productId = 'com.littlesteps.techhelp.fullaccess.annual';
const state = () => ({ schemaVersion: 1, savedProfiles: [{ category: 'mobile', brand: 'Apple', modelId: 'iphone-16', nickname: 'My phone' }], guideProgress: { 'iphone-wifi': { caseKey: 'mobile|iphone-16|iOS|device', facts: { category: 'mobile', modelId: 'iphone-16', software: 'iOS', guideStep: 2 }, step: 2, done: false, events: [{ title: 'Check Wi-Fi', answer: 'Still offline' }] } }, lastAdvancedGuide: 'iphone-wifi', language: 'ar', onboardingComplete: true, updatedAt: '2026-09-19T12:00:00.000Z' });
function boot(options = {}) {
  const stored = new Map(options.stored || []), events = [], messages = [];
  const localStorage = options.localStorage || { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const window = { LITTLE_STEPS_CONFIG: { productID: productId, purchasesEnabled: true, ...options.config }, localStorage, dispatchEvent: event => events.push(event) };
  if (options.native) window.webkit = { messageHandlers: { littleSteps: { postMessage: message => { messages.push(message); return options.native(message); } } } };
  const context = vm.createContext({ window, navigator: options.navigator || {}, CustomEvent: class CustomEvent { constructor(type, args) { this.type = type; this.detail = args.detail; } }, setTimeout: options.setTimeout || setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return { runtime: window.LittleStepsRuntime, window, stored, events, messages };
}
const active = extra => ({ status: 'active', price: '$49.99', period: 'year', productId, expirationDate: '2027-09-19T12:00:00Z', ...extra });
(async () => {
  const web = boot();
  assert.equal((await web.runtime.loadState()).state, null);
  assert.equal((await web.runtime.saveState(state())).persistent, true);
  const recovered = await boot({ stored: [...web.stored] }).runtime.loadState();
  assert.equal(recovered.state.savedProfiles[0].nickname, 'My phone');
  assert.equal(recovered.state.guideProgress['iphone-wifi'].step, 2);
  assert.equal(recovered.state.language, 'ar');
  assert.equal(recovered.state.onboardingComplete, true);
  const polluted = JSON.parse(JSON.stringify(state()));
  Object.assign(polluted, { previewAccess: true, subscription: { status: 'active' }, entitlement: true });
  polluted.guideProgress = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true}}');
  const sanitized = await web.runtime.saveState(polluted);
  assert.equal(sanitized.state.previewAccess, undefined);
  assert.equal(sanitized.state.entitlement, undefined);
  assert.deepEqual(Object.keys(sanitized.state.guideProgress), []);
  assert.equal({}.polluted, undefined);
  assert.equal((await web.runtime.getSubscription()).status, 'unavailable');
  assert.equal((await web.runtime.purchase()).status, 'unavailable');
  assert.equal((await web.runtime.restore()).status, 'unavailable');
  assert.equal((await web.runtime.clearState()).ok, true);
  assert.equal(web.stored.has(KEY), false);

  const corrupt = boot({ stored: [[KEY, '{invalid']] });
  const reset = await corrupt.runtime.loadState();
  assert.equal(reset.reset, true);
  assert.equal(reset.state, null);
  assert.equal(corrupt.stored.has(KEY), false);
  assert.equal(corrupt.events[0].type, 'littleStepsStorageError');
  const newer = boot({ stored: [[KEY, JSON.stringify({ ...state(), schemaVersion: 2 })]] });
  assert.equal((await newer.runtime.loadState()).ok, false);
  assert.equal(newer.stored.has(KEY), true);
  assert.equal((await web.runtime.saveState({ ...state(), schemaVersion: 2 })).ok, false);
  assert.equal((await web.runtime.saveState({ ...state(), savedProfiles: Array(101).fill(state().savedProfiles[0]) })).ok, false);
  assert.equal((await web.runtime.saveState({ ...state(), guideProgress: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`guide-${i}`, {}])) })).ok, false);

  const blocked = boot({ localStorage: { getItem() { throw Error('SecurityError'); }, setItem() { throw Error('QuotaExceededError'); }, removeItem() { throw Error('SecurityError'); } } });
  const blockedSave = await blocked.runtime.saveState(state());
  assert.equal(blockedSave.ok, false);
  assert.equal(blockedSave.persistent, false);
  assert.equal(blockedSave.state.savedProfiles.length, 1);
  const volatile = await blocked.runtime.loadState();
  assert.equal(volatile.persistent, false);
  assert.equal(volatile.state.savedProfiles.length, 1);
  assert.equal((await blocked.runtime.clearState()).ok, false);
  assert.ok(blocked.events.every(event => event.type === 'littleStepsStorageError'));

  const rejected = boot({ native: () => Promise.reject(Error('Native storage unavailable')) });
  assert.equal((await rejected.runtime.saveState(state())).ok, false);
  assert.equal(rejected.stored.size, 0, 'Native errors must never fall back to localStorage');
  assert.equal((await rejected.runtime.loadState()).ok, false);
  assert.equal((await rejected.runtime.getSubscription()).status, 'unavailable');
  const malformed = boot({ native: () => Promise.resolve({}) });
  assert.equal((await malformed.runtime.saveState(state())).ok, false);
  assert.equal((await malformed.runtime.loadState()).ok, false);
  assert.equal((await malformed.runtime.getSubscription()).status, 'unavailable');
  const nonPromise = boot({ native: () => ({ status: 'active' }) });
  assert.equal((await nonPromise.runtime.getSubscription()).status, 'unavailable');
  const timeout = boot({ native: () => new Promise(() => {}), setTimeout: callback => setTimeout(callback, 1) });
  assert.equal((await timeout.runtime.getSubscription()).error.code, 'native_timeout');

  const verified = boot({ native: () => Promise.resolve(active()) });
  assert.equal((await verified.runtime.getSubscription()).status, 'active');
  assert.equal((await verified.runtime.purchase()).price, '$49.99');
  assert.equal((await verified.runtime.restore()).status, 'active');
  assert.deepEqual(verified.messages.map(message => message.action), ['getSubscription', 'purchase', 'restore']);
  for (const invalid of [{ status: 'anything' }, { productId: 'another.product' }, { expirationDate: null }, { expirationDate: 'not-a-date' }, { expirationDate: '2000-01-01T00:00:00Z' }, { period: 'month' }]) {
    const client = boot({ native: () => Promise.resolve(active(invalid)) });
    assert.equal((await client.runtime.getSubscription()).status, 'unavailable');
  }
  const pending = boot({ native: () => Promise.resolve(active({ status: 'inactive', expirationDate: null, outcome: 'pending' })) });
  assert.equal((await pending.runtime.purchase()).status, 'inactive');
  assert.equal((await pending.runtime.purchase()).outcome, 'pending');
  const disabled = boot({ native: () => Promise.resolve(active()), config: { purchasesEnabled: false } });
  assert.equal((await disabled.runtime.purchase()).status, 'unavailable');
  assert.equal(disabled.messages.length, 0);

  const orderedActions = [];
  const ordered = boot({ native: async ({ action }) => {
    orderedActions.push(action);
    if (action === 'saveState') await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: true };
  } });
  await Promise.all([ordered.runtime.saveState(state()), ordered.runtime.clearState()]);
  assert.deepEqual(orderedActions, ['saveState', 'clearState']);

  assert.equal((await web.runtime.shareSummary('Useful steps')).ok, false);
  const clipboard = boot({ navigator: { clipboard: { writeText: async text => assert.equal(text, 'Useful steps') } } });
  assert.equal((await clipboard.runtime.shareSummary('Useful steps')).copied, true);
  const copyFailure = boot({ navigator: { clipboard: { writeText: async () => { throw Error('denied'); } } } });
  assert.equal((await copyFailure.runtime.shareSummary('Useful steps')).ok, false);
  const cancelShare = boot({ navigator: { share: async () => { throw Object.assign(Error('cancelled'), { name: 'AbortError' }); } } });
  assert.equal((await cancelShare.runtime.shareSummary('Useful steps')).outcome, 'cancelled');
  const nativeShare = boot({ native: async () => ({ ok: true }) });
  assert.equal((await nativeShare.runtime.shareSummary('Useful steps')).method, 'native');
  assert.equal(nativeShare.messages[0].payload.text, 'Useful steps');
  assert.equal((await nativeShare.runtime.manageSubscription()).ok, true);
  console.log('Runtime checks passed: persistence, corruption recovery, bounds, native failure isolation, verified entitlement normalization, mutation ordering and honest sharing results.');
})().catch(error => { console.error(error); process.exitCode = 1; });
