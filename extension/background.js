// 传输层：用 File System Access 把划线写入用户选择的本地文件夹。
// 侧边栏直接走 FSA（读/列/编辑/删除）。content.js 的划线保存经此处：
// 用 offscreen 文档即时写盘；写不成（无句柄/权限未授予/刚重启）就入队 storage.local，
// 等侧边栏连接后回灌。数据权威源永远是硬盘文件夹。

const DEFAULT_SETTINGS = {
  autoPromptEnabled: true
};

// ---- offscreen 管理 ----
let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "把划线内容写入用户选择的本地知识库文件夹"
    });
  }
  try {
    await creatingOffscreen;
  } catch (error) {
    // 并发或已存在时忽略；只要文档在即可
    if (!(await chrome.offscreen.hasDocument())) throw error;
  } finally {
    creatingOffscreen = null;
  }
}

function askOffscreen(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no_response" });
    });
  });
}

async function enqueueClip(clip) {
  const { kcQueue = [] } = await chrome.storage.local.get({ kcQueue: [] });
  kcQueue.push({ clip, queuedAt: Date.now() });
  await chrome.storage.local.set({ kcQueue });
}

async function saveClipViaOffscreen(clip) {
  try {
    await ensureOffscreen();
    const result = await askOffscreen({ target: "offscreen", op: "save", clip });
    if (result && result.ok) {
      chrome.runtime.sendMessage({ type: "clip-saved", payload: result }).catch(() => {});
      return { ok: true, payload: result };
    }
    await enqueueClip(clip);
    return { ok: true, queued: true, reason: result && result.error };
  } catch (error) {
    await enqueueClip(clip);
    return { ok: true, queued: true, reason: error.message };
  }
}

// ---- content script 注入 / 命令 / 侧栏（沿用原逻辑）----
function canInjectIntoTab(tab) {
  return Boolean(tab && tab.id && /^https?:\/\//.test(tab.url || ""));
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function refreshContentScriptsInOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter(canInjectIntoTab).map((tab) => injectContentScript(tab.id)));
}

async function openClipBoxInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "open-clip-box", source: "command" });
  } catch (error) {
    try {
      await injectContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: "open-clip-box", source: "command" });
    } catch (injectionError) {
      // 浏览器内置页面无法注入 content script，忽略。
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS).then((current) => {
    chrome.storage.sync.set({ autoPromptEnabled: current.autoPromptEnabled });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  refreshContentScriptsInOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
refreshContentScriptsInOpenTabs().catch(() => {});

chrome.commands.onCommand.addListener((command) => {
  if (command === "save-selection") {
    openClipBoxInActiveTab();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "open-active-tab") {
    openClipBoxInActiveTab().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "save-clip") {
    saveClipViaOffscreen(message.clip).then(sendResponse);
    return true;
  }

  return false;
});
