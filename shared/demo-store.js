"use strict";

(() => {
  const storageKey = "best-loans-demo-v1";
  const listeners = new Set();

  function getSnapshot() {
    try {
      const stored = window.localStorage.getItem(storageKey);
      const data = stored ? JSON.parse(stored) : {};
      return {
        users: Array.isArray(data.users) ? data.users.map(({ paid, ...user }) => user) : [],
        applications: Array.isArray(data.applications) ? data.applications : []
      };
    } catch {
      return { users: [], applications: [] };
    }
  }

  function save(collection, record) {
    if (!record || record.id === undefined || record.id === null) {
      throw new TypeError("Shared demo records need an id.");
    }

    const snapshot = getSnapshot();
    const records = snapshot[collection];
    const exists = records.some(item => String(item.id) === String(record.id));
    const updated = exists
      ? records.map(item => String(item.id) === String(record.id) ? record : item)
      : [...records, record];

    window.localStorage.setItem(storageKey, JSON.stringify({ ...snapshot, [collection]: updated }));
    return record;
  }

  window.addEventListener("storage", event => {
    if (event.key === storageKey || event.key === null) {
      const snapshot = getSnapshot();
      listeners.forEach(listener => listener(snapshot));
    }
  });

  window.BestLoansStore = Object.freeze({
    storageKey,
    getSnapshot,
    getUsers: () => getSnapshot().users,
    getApplications: () => getSnapshot().applications,
    saveUser: user => save("users", user),
    saveApplication: application => save("applications", application),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
})();
