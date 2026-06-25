const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeElement() {
  const children = new Map();
  return {
    hidden: false,
    checked: false,
    value: "",
    textContent: "",
    innerHTML: "",
    listeners: {},
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    addEventListener(type, listener) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(listener);
    },
    querySelector(selector) {
      const attr = selector.match(/^\[([a-zA-Z0-9-]+)\]$/);
      if (attr && !this.innerHTML.includes(attr[1])) return null;
      if (!children.has(selector)) children.set(selector, makeElement());
      return children.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    focus() {}
  };
}

function loadPopupForTest() {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    document: {
      body: makeElement(),
      querySelector: element,
      querySelectorAll() {
        return [];
      }
    },
    window: {
      CSS: { escape: (value) => String(value) },
      addEventListener() {},
      clearTimeout,
      setTimeout
    },
    CSS: { escape: (value) => String(value) },
    navigator: {
      clipboard: { writeText: () => Promise.resolve() }
    },
    chrome: {
      storage: {
        sync: {
          get: (defaults) => Promise.resolve({ ...defaults }),
          set: () => Promise.resolve()
        },
        local: {
          get: (defaults) => Promise.resolve({ ...defaults }),
          set: () => Promise.resolve()
        }
      },
      runtime: {
        onMessage: { addListener() {} }
      }
    },
    KCHandle: {
      loadDirHandle: () => new Promise(() => {}),
      saveDirHandle: () => Promise.resolve()
    },
    KCStore: {}
  };
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.join(__dirname, "../extension/popup.js"), "utf8");
  vm.runInNewContext(
    `${source}\nglobalThis.__popupTest = { setConnectionState, renderDisconnectedList };`,
    sandbox,
    { filename: "extension/popup.js" }
  );

  return {
    api: sandbox.__popupTest,
    recentClips: element("#recentClips")
  };
}

test("saved tab can reconnect the remembered folder without sending users to settings", () => {
  const { api, recentClips } = loadPopupForTest();

  api.setConnectionState("needs-permission");
  api.renderDisconnectedList();

  assert.match(recentClips.innerHTML, /继续使用上次文件夹/);
  assert.match(recentClips.innerHTML, /data-reconnect-folder/);
  assert.doesNotMatch(recentClips.innerHTML, /设置 \/ Agent/);
  assert.strictEqual(recentClips.querySelector("[data-reconnect-folder]").listeners.click.length, 1);
});

test("saved tab asks users to pick a folder only when no stored folder is available", () => {
  const { api, recentClips } = loadPopupForTest();

  api.setConnectionState("not-selected");
  api.renderDisconnectedList();

  assert.match(recentClips.innerHTML, /选择知识库文件夹/);
  assert.match(recentClips.innerHTML, /data-pick-folder/);
  assert.doesNotMatch(recentClips.innerHTML, /data-reconnect-folder/);
  assert.strictEqual(recentClips.querySelector("[data-pick-folder]").listeners.click.length, 1);
});
