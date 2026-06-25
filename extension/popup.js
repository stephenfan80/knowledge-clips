// 侧边栏：持有用户选择的文件夹句柄，直接用 FSA 读/列/编辑/删除；
// 连接成功后回灌 background 暂存的队列。数据权威源是用户本地文件夹。

const DEFAULT_SETTINGS = {
  autoPromptEnabled: true
};

const autoPromptEnabled = document.querySelector("#autoPromptEnabled");
const status = document.querySelector("#status");
const recentClips = document.querySelector("#recentClips");
const onboardingPanel = document.querySelector("#onboardingPanel");
const deleteDialog = document.querySelector("#deleteDialog");
const deletePreview = document.querySelector("#deletePreview");
const deleteStatus = document.querySelector("#deleteStatus");
const confirmDelete = document.querySelector("#confirmDelete");
const cancelDelete = document.querySelector("#cancelDelete");

const folderConnected = document.querySelector("#folderConnected");
const folderDisconnected = document.querySelector("#folderDisconnected");
const folderNeedsPermission = document.querySelector("#folderNeedsPermission");
const folderName = document.querySelector("#folderName");
const queueHint = document.querySelector("#queueHint");

let dirHandle = null;
let connectionState = "not-selected"; // not-selected | connecting | needs-permission | connected
let currentClips = [];
let pendingDeleteId = "";
let libraryDirPath = ""; // 仅用于补全 Agent 提示（FSA 拿不到系统路径，用户填一次）

chrome.storage.sync.get(DEFAULT_SETTINGS).then((settings) => {
  autoPromptEnabled.checked = Boolean(settings.autoPromptEnabled);
});

chrome.storage.local.get({ libraryDirPath: "" }).then(({ libraryDirPath: saved }) => {
  libraryDirPath = saved || "";
  const input = document.querySelector("#libraryDirPath");
  if (input) input.value = libraryDirPath;
});

document.querySelector("#libraryDirPath").addEventListener("change", (event) => {
  libraryDirPath = event.target.value.trim();
  chrome.storage.local.set({ libraryDirPath });
});

init();

async function init() {
  try {
    dirHandle = await KCHandle.loadDirHandle();
  } catch (error) {
    dirHandle = null;
  }
  await refreshConnection({ requestPermission: true });
}

autoPromptEnabled.addEventListener("change", () => {
  chrome.storage.sync.set({ autoPromptEnabled: autoPromptEnabled.checked });
});

document.querySelectorAll("[data-tab-button]").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tabButton));
});

document.querySelector("#refreshClips").addEventListener("click", loadRecentClips);
document.querySelector("#pickFolder").addEventListener("click", pickFolder);
document.querySelector("#changeFolder").addEventListener("click", pickFolder);
document.querySelector("#reconnectFolder").addEventListener("click", reconnectFolder);
document.querySelector("#copyAgentPrompt").addEventListener("click", () => {
  copyText(agentPrompt(), "已复制 Agent 提示");
});

cancelDelete.addEventListener("click", closeDeleteDialog);
confirmDelete.addEventListener("click", deletePendingClip);
deleteDialog.addEventListener("click", (event) => {
  if (event.target === deleteDialog) closeDeleteDialog();
});

// 侧边栏重新获得焦点时：已连接则回灌暂存队列，未连接则重查权限。
window.addEventListener("focus", () => {
  if (connectionState === "connected") {
    flushQueue().then(loadRecentClips);
  } else {
    refreshConnection({ requestPermission: true });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "clip-saved" || message.type === "clip-updated" || message.type === "clip-deleted") {
    if (connectionState === "connected") {
      activateTab("saved");
      loadRecentClips();
    }
  }
});

// ---- 文件夹连接 ----
async function refreshConnection({ requestPermission = false } = {}) {
  if (!dirHandle) {
    setConnectionState("not-selected");
  } else {
    let permission = await queryDirPermission();
    if (permission !== "granted" && requestPermission) {
      setConnectionState("connecting");
      permission = await requestDirPermission();
    }
    setConnectionState(permission === "granted" ? "connected" : "needs-permission");
  }

  if (connectionState === "connected") {
    await flushQueue();
    await loadRecentClips();
  } else {
    renderDisconnectedList();
  }
  await updateQueueHint();
}

function setConnectionState(state) {
  connectionState = state;
  const map = {
    connected: { text: "已连接文件夹", online: true },
    connecting: { text: "正在连接上次文件夹", online: false },
    "needs-permission": { text: "需要确认上次文件夹", online: false },
    "not-selected": { text: "未选择文件夹", online: false }
  };
  const meta = map[state];
  status.textContent = meta.text;
  status.classList.toggle("is-online", meta.online);
  status.classList.toggle("is-offline", !meta.online);

  folderConnected.hidden = state !== "connected";
  folderDisconnected.hidden = state !== "not-selected";
  folderNeedsPermission.hidden = state !== "needs-permission";
  if (state === "connected" && dirHandle) folderName.textContent = dirHandle.name;
}

async function queryDirPermission() {
  try {
    return await dirHandle.queryPermission({ mode: "readwrite" });
  } catch (error) {
    return "prompt";
  }
}

async function requestDirPermission() {
  try {
    return await dirHandle.requestPermission({ mode: "readwrite" });
  } catch (error) {
    return "prompt";
  }
}

async function pickFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: "knowledge-clips", mode: "readwrite" });
    dirHandle = handle;
    await KCHandle.saveDirHandle(handle);
    setConnectionState("connected");
    await flushQueue();
    await loadRecentClips();
    await updateQueueHint();
    showToast("已连接文件夹");
  } catch (error) {
    if (error && error.name === "AbortError") return; // 用户取消
    showToast("选择文件夹失败");
  }
}

async function reconnectFolder() {
  if (!dirHandle) {
    pickFolder();
    return;
  }
  const permission = await requestDirPermission();
  if (permission === "granted") {
    setConnectionState("connected");
    await flushQueue();
    await loadRecentClips();
    await updateQueueHint();
    showToast("已连接上次文件夹");
  } else {
    showToast("浏览器未确认文件夹权限");
  }
}

async function flushQueue() {
  if (connectionState !== "connected" || !dirHandle) return;
  const { kcQueue = [] } = await chrome.storage.local.get({ kcQueue: [] });
  if (!kcQueue.length) return;

  const remaining = [];
  let flushed = 0;
  for (const item of kcQueue) {
    try {
      await KCStore.saveClip(dirHandle, item.clip);
      flushed += 1;
    } catch (error) {
      remaining.push(item);
    }
  }
  await chrome.storage.local.set({ kcQueue: remaining });
  if (flushed) showToast(`已同步 ${flushed} 条暂存`);
}

async function updateQueueHint() {
  const { kcQueue = [] } = await chrome.storage.local.get({ kcQueue: [] });
  if (kcQueue.length && connectionState !== "connected") {
    queueHint.hidden = false;
    queueHint.textContent = `有 ${kcQueue.length} 条暂存，连接文件夹后会自动写入。`;
  } else {
    queueHint.hidden = true;
  }
}

// ---- 列表 ----
function activateTab(tabName) {
  document.querySelectorAll("[data-tab-button]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tabButton === tabName);
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === tabName);
  });
}

async function loadRecentClips() {
  if (connectionState !== "connected" || !dirHandle) {
    renderDisconnectedList();
    return;
  }
  try {
    const clips = await KCStore.recentClips(dirHandle, 30);
    renderClips(clips);
  } catch (error) {
    document.body.classList.remove("has-clips");
    onboardingPanel.hidden = true;
    recentClips.innerHTML = `<div class="empty">读取失败：${escapeHtml(error.message || "未知错误")}</div>`;
  }
}

function renderDisconnectedList() {
  document.body.classList.remove("has-clips");
  onboardingPanel.hidden = true;
  const prompts = {
    connecting: {
      message: "正在连接上次选择的知识库文件夹..."
    },
    "needs-permission": {
      message: "已记住上次选择的知识库文件夹。点一下继续使用；浏览器确认后会自动恢复，不需要重新选择。",
      action: "继续使用上次文件夹",
      actionAttr: "data-reconnect-folder"
    },
    "not-selected": {
      message: "还没有可用的知识库文件夹。先选择一个本地文件夹，之后打开侧边栏会优先自动恢复它。",
      action: "选择知识库文件夹",
      actionAttr: "data-pick-folder"
    }
  };
  const prompt = prompts[connectionState] || prompts["not-selected"];
  recentClips.innerHTML = `
    <div class="empty connection-empty">
      <p>${prompt.message}</p>
      ${prompt.action ? `<button class="solid-button" type="button" ${prompt.actionAttr}>${prompt.action}</button>` : ""}
    </div>
  `;
  bindDisconnectedActions();
}

function bindDisconnectedActions() {
  const reconnectButton = recentClips.querySelector("[data-reconnect-folder]");
  if (reconnectButton) reconnectButton.addEventListener("click", reconnectFolder);

  const pickButton = recentClips.querySelector("[data-pick-folder]");
  if (pickButton) pickButton.addEventListener("click", pickFolder);
}

function renderClips(clips) {
  currentClips = clips;
  document.body.classList.toggle("has-clips", clips.length > 0);
  onboardingPanel.hidden = clips.length > 0;

  if (!clips.length) {
    recentClips.innerHTML = ""; // 空态由 #onboardingPanel（荧光手帐新手引导）承担
    return;
  }

  recentClips.innerHTML = clips.map(renderClip).join("");
  bindClipActions();
}

function renderClip(clip) {
  const selectedText = clip.selection && clip.selection.text ? clip.selection.text : "";
  const thought = clip.note && clip.note.thought ? clip.note.thought : "";
  const tags = clip.note && Array.isArray(clip.note.tags) ? clip.note.tags.join(", ") : "";
  const capturedAt = clip.source && clip.source.capturedAt ? formatDate(clip.source.capturedAt) : "";
  const isLong = `${thought}\n${selectedText}`.length > 120;

  return `
    <article class="clip ${isLong ? "collapsed" : ""}" data-clip-id="${escapeHtml(clip.id)}">
      <div class="clip-meta">
        <span class="clip-context">
          <time>${escapeHtml(capturedAt)}</time>
          ${renderTags(clip.note && clip.note.tags)}
        </span>
        <span class="clip-actions">
          <button class="icon-button" type="button" data-edit-clip="${escapeHtml(clip.id)}">编辑</button>
          <button class="icon-button danger-link" type="button" data-request-delete="${escapeHtml(clip.id)}">删除</button>
        </span>
      </div>
      <p class="clip-thought">${highlightThought(thought)}</p>
      <blockquote class="clip-text">${escapeHtml(selectedText)}</blockquote>
      ${isLong ? `<button class="expand-button" type="button" data-toggle-clip="${escapeHtml(clip.id)}">展开</button>` : ""}
      <form class="clip-editor" data-edit-form="${escapeHtml(clip.id)}" hidden>
        <label>
          <span>启发</span>
          <textarea data-edit-thought>${escapeHtml(thought)}</textarea>
        </label>
        <label>
          <span>标签</span>
          <input data-edit-tags value="${escapeHtml(tags)}" />
        </label>
        <div class="editor-actions">
          <button type="button" data-cancel-edit="${escapeHtml(clip.id)}">取消</button>
          <button class="solid-button" type="submit">保存修改</button>
        </div>
        <p class="edit-status" data-edit-status></p>
      </form>
    </article>
  `;
}

function bindClipActions() {
  recentClips.querySelectorAll("[data-toggle-clip]").forEach((button) => {
    button.addEventListener("click", () => {
      const article = recentClips.querySelector(`[data-clip-id="${cssEscape(button.dataset.toggleClip)}"]`);
      if (!article) return;
      const collapsed = article.classList.toggle("collapsed");
      button.textContent = collapsed ? "展开" : "收起";
    });
  });

  recentClips.querySelectorAll("[data-edit-clip]").forEach((button) => {
    button.addEventListener("click", () => setEditing(button.dataset.editClip, true));
  });

  recentClips.querySelectorAll("[data-cancel-edit]").forEach((button) => {
    button.addEventListener("click", () => setEditing(button.dataset.cancelEdit, false));
  });

  recentClips.querySelectorAll("[data-request-delete]").forEach((button) => {
    button.addEventListener("click", () => openDeleteDialog(button.dataset.requestDelete));
  });

  recentClips.querySelectorAll("[data-edit-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveEditedClip(form);
    });
  });
}

function setEditing(id, editing) {
  const article = recentClips.querySelector(`[data-clip-id="${cssEscape(id)}"]`);
  if (!article) return;
  const form = article.querySelector("[data-edit-form]");
  if (form) form.hidden = !editing;
  article.classList.toggle("editing", editing);
}

async function saveEditedClip(form) {
  const id = form.dataset.editForm;
  const thought = form.querySelector("[data-edit-thought]").value.trim();
  const tags = form.querySelector("[data-edit-tags]").value.trim();
  const saveButton = form.querySelector(".solid-button");
  const editStatus = form.querySelector("[data-edit-status]");

  if (!thought) {
    editStatus.textContent = "启发不能为空。";
    return;
  }
  if (connectionState !== "connected" || !dirHandle) {
    editStatus.textContent = "请先在设置里连接文件夹。";
    return;
  }

  saveButton.disabled = true;
  editStatus.textContent = "正在保存...";
  try {
    await KCStore.updateClip(dirHandle, { id, note: { thought, tags } });
    editStatus.textContent = "已更新";
    await loadRecentClips();
  } catch (error) {
    editStatus.textContent = updateErrorText(error.message);
  } finally {
    saveButton.disabled = false;
  }
}

function openDeleteDialog(id) {
  const clip = currentClips.find((item) => item.id === id);
  if (!clip) return;
  pendingDeleteId = id;
  deleteStatus.textContent = "";
  confirmDelete.disabled = false;
  deletePreview.textContent = previewClip(clip);
  deleteDialog.hidden = false;
  cancelDelete.focus();
}

function closeDeleteDialog() {
  pendingDeleteId = "";
  deleteDialog.hidden = true;
  deleteStatus.textContent = "";
  confirmDelete.disabled = false;
}

async function deletePendingClip() {
  if (!pendingDeleteId) return;
  if (connectionState !== "connected" || !dirHandle) {
    deleteStatus.textContent = "请先在设置里连接文件夹。";
    return;
  }

  confirmDelete.disabled = true;
  deleteStatus.textContent = "正在删除...";
  try {
    await KCStore.deleteClip(dirHandle, { id: pendingDeleteId });
    closeDeleteDialog();
    showToast("已删除");
    await loadRecentClips();
  } catch (error) {
    deleteStatus.textContent = deleteErrorText(error.message);
  } finally {
    confirmDelete.disabled = false;
  }
}

function previewClip(clip) {
  const thought = clip.note && clip.note.thought ? clip.note.thought : "";
  const selectedText = clip.selection && clip.selection.text ? clip.selection.text : "";
  return thought || selectedText;
}

function renderTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return "";
  return tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("");
}

function agentPrompt() {
  const folderName = dirHandle && dirHandle.name ? dirHandle.name : "荧光手帐";
  const pathForCmd = libraryDirPath || "<绝对路径>";
  const pathLine = libraryDirPath
    ? `它的绝对路径：${libraryDirPath}`
    : `它的绝对路径：【在这里粘贴你的完整路径，例如 /Users/你的用户名/.../${folderName}】——如果我没填，先问我要，别猜。`;
  return `你是我的个人知识库协作助手。我的知识保存在一个本地文件夹（名为「${folderName}」）。
${pathLine}

文件夹结构：
- index/cards.index.md —— 一行一卡的目录：日期 · 标签 · 我的想法 · 原文摘要 · id · 文件路径
- notes/*.md —— 每张卡的完整内容
- index/clips.jsonl —— 全量机器索引（不要整份读进对话）

读取规则（务必遵守，避免一次性塞爆上下文）：
1. 先只读 index/cards.index.md（或对它 grep 关键词），按「我的想法 / 标签」判断哪些卡相关。
2. 只对相关的卡，去读它那一行末尾的 notes/<文件> 取完整内容。
3. 绝不要整库读取 notes/ 目录或 index/clips.jsonl。
4. 若 index/cards.index.md 不存在，提醒我先生成（在扩展里保存任意一条即可）。

可选快捷方式（仅当你能跑命令、且我已把 knowledge-clips 仓库给你时；路径含空格/中文务必加引号）：
- 主题检索： KNOWLEDGE_CLIPS_DIR="${pathForCmd}" npm run search -- "关键词"
- 取单卡：   KNOWLEDGE_CLIPS_DIR="${pathForCmd}" npm run card -- "<id>"

如果你读不了本地文件（纯聊天类 AI）：告诉我，我把 cards.index.md 的相关行贴给你，你挑出 id，我再贴对应的 notes 卡片。

输出约束：严格区分「原文依据」(我划的原文) 和「我的想法」(我的判断)，别把你的总结当成原文；二次创作要标注来源链接或 notes 文件名；证据不足就直说，不要编造。`;
}

function copyText(text, successText) {
  navigator.clipboard.writeText(text).then(() => showToast(successText));
}

let toastTimer = 0;
function showToast(text) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 1600);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function updateErrorText(error) {
  if (error === "missing_thought") return "启发不能为空。";
  if (error === "clip_not_found") return "这条记录不存在，请刷新列表。";
  return `保存失败：${error || "未知错误"}`;
}

function deleteErrorText(error) {
  if (error === "clip_not_found") return "这条记录不存在，请刷新列表。";
  return `删除失败：${error || "未知错误"}`;
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 荧光高亮：把「想法」的第一句（到首个句末标点）用 <mark> 包起来，得到荧光笔效果。
// 没有句末标点则高亮前 24 个字符；其余原样转义。纯展示，不改数据。
function highlightThought(thought) {
  const text = String(thought || "");
  if (!text) return "";
  const match = text.match(/^[\s\S]*?[。！？!?；;]/);
  const head = match ? match[0] : text.slice(0, 24);
  const rest = text.slice(head.length);
  return `<mark>${escapeHtml(head)}</mark>${escapeHtml(rest)}`;
}
