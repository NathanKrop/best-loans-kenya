const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const storePath = join(__dirname, "demo-store.js");

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

function loadStore(storage) {
  const listeners = {};
  const window = {
    localStorage: storage,
    addEventListener: (name, listener) => { listeners[name] = listener; }
  };
  vm.runInNewContext(readFileSync(storePath, "utf8"), { window });
  return { store: window.BestLoansStore, listeners };
}

test("records are available after loading the store again", () => {
  const storage = createStorage();
  const { store } = loadStore(storage);

  store.saveUser({ id: "user-1", name: "Amina", phone: "0712345678" });
  store.saveApplication({ id: "application-1", userId: "user-1", amount: 5000, status: "PENDING" });

  const reloaded = loadStore(storage).store;
  assert.equal(reloaded.getUsers()[0].name, "Amina");
  assert.equal(reloaded.getApplications()[0].status, "PENDING");
});

test("updating a record replaces it without duplicating it", () => {
  const { store } = loadStore(createStorage());

  store.saveUser({ id: "user-1", name: "Amina" });
  store.saveUser({ id: "user-1", name: "Amina updated" });

  assert.equal(store.getUsers().length, 1);
  assert.equal(store.getUsers()[0].name, "Amina updated");
});

test("subscribers receive updates from another page", () => {
  const { store, listeners } = loadStore(createStorage());
  let observedUsers = -1;
  store.subscribe(data => { observedUsers = data.users.length; });

  listeners.storage({ key: store.storageKey });

  assert.equal(observedUsers, 0);
});

test("normalizes Kenyan mobile numbers in local and international formats", () => {
  const { store } = loadStore(createStorage());

  assert.equal(store.normalizeKenyanPhone("0712 345 678"), "254712345678");
  assert.equal(store.normalizeKenyanPhone("0112-345-678"), "254112345678");
  assert.equal(store.normalizeKenyanPhone("+254 712 345 678"), "254712345678");
  assert.equal(store.normalizeKenyanPhone("+254 112 345 678"), "254112345678");
  assert.equal(store.normalizeKenyanPhone("12345"), null);
});
