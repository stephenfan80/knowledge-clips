// 用 IndexedDB 持久化用户选择的文件夹句柄（DirectoryHandle 可结构化克隆）。
// 浏览器挂 globalThis.KCHandle。

(function (root) {
  const DB_NAME = "knowledge-clips";
  const STORE = "handles";
  const KEY = "libraryDir";

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function saveDirHandle(handle) {
    await withStore("readwrite", (store) => store.put(handle, KEY));
  }

  async function loadDirHandle() {
    return withStore("readonly", (store) => store.get(KEY));
  }

  async function clearDirHandle() {
    await withStore("readwrite", (store) => store.delete(KEY));
  }

  const KCHandle = { saveDirHandle, loadDirHandle, clearDirHandle };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = KCHandle;
  } else {
    root.KCHandle = KCHandle;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
