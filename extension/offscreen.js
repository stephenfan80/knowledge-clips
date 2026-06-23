// 离屏文档：接收 background 的写盘请求，用已授权的文件夹句柄写入。
// 只处理"已授权"的情况；无句柄或权限未授予时回失败，由 background 入队兜底。

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;

  if (message.op === "save") {
    handleSave(message.clip).then(sendResponse);
    return true; // async
  }

  return false;
});

async function handleSave(clip) {
  try {
    const handle = await KCHandle.loadDirHandle();
    if (!handle) return { ok: false, error: "no_handle" };

    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") return { ok: false, error: "permission" };

    const result = await KCStore.saveClip(handle, clip);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
