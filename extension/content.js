(function initKnowledgeClipsContent() {
if (window.__knowledgeClipsContentLoaded) {
  document.querySelectorAll('[data-knowledge-clips="popover"]').forEach((element) => element.remove());
  return;
}

window.__knowledgeClipsContentLoaded = true;
document.querySelectorAll('[data-knowledge-clips="popover"]').forEach((element) => element.remove());

const KC_DEFAULT_SETTINGS = {
  autoPromptEnabled: true
};

const KC_PROMPT_DEFAULTS = {
  disabledPagePrompts: {},
  autoPromptPausedUntil: 0
};

let kcSettings = { ...KC_DEFAULT_SETTINGS };
let kcPromptPrefs = { ...KC_PROMPT_DEFAULTS };
let kcPopover = null;
let kcToast = null;
let kcLastAutoText = "";
let kcAutoTimer = 0;

chrome.storage.sync.get(KC_DEFAULT_SETTINGS).then((settings) => {
  kcSettings = settings;
});

chrome.storage.local.get(KC_PROMPT_DEFAULTS).then((prefs) => {
  kcPromptPrefs = prefs;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    for (const [key, change] of Object.entries(changes)) {
      kcSettings[key] = change.newValue;
    }
  }

  if (area === "local") {
    for (const [key, change] of Object.entries(changes)) {
      kcPromptPrefs[key] = change.newValue;
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "open-clip-box") {
    const selection = getSelectionInfo();
    if (!selection) {
      showToast("请先选中文章正文内容。");
      return;
    }
    openClipBox(selection, { auto: false });
  }
});

document.addEventListener("mouseup", scheduleAutoPrompt, true);
document.addEventListener("keyup", (event) => {
  if (event.key === "Shift" || event.key.startsWith("Arrow")) {
    scheduleAutoPrompt();
  }
});
document.addEventListener("selectionchange", () => {
  if (!isAutoPromptAllowed()) return;
  window.clearTimeout(kcAutoTimer);
  kcAutoTimer = window.setTimeout(() => {
    if (!isAutoPromptAllowed()) return;
    const selection = getSelectionInfo();
    if (!selection || selection.text === kcLastAutoText) return;
    openClipBox(selection, { auto: true });
    kcLastAutoText = selection.text;
  }, 650);
});

function scheduleAutoPrompt() {
  if (!isAutoPromptAllowed()) return;
  window.clearTimeout(kcAutoTimer);
  kcAutoTimer = window.setTimeout(() => {
    if (!isAutoPromptAllowed()) return;
    const selection = getSelectionInfo();
    if (!selection || selection.text === kcLastAutoText) return;
    openClipBox(selection, { auto: true });
    kcLastAutoText = selection.text;
  }, 220);
}

function getSelectionInfo() {
  const selection = window.getSelection();
  const text = selection && selectedTextWithParagraphs(selection);
  if (!selection || !text || text.length < 2 || !selection.rangeCount) return null;
  if (!isSelectionFromPageContent(selection)) return null;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  const pageText = document.body ? normalizeSelectedText(document.body.innerText) : "";
  const context = selectionContext(pageText, text);
  const canonical = document.querySelector('link[rel="canonical"]');

  return {
    text,
    beforeContext: context.before,
    afterContext: context.after,
    rect: {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width
    },
    source: {
      title: document.title || location.hostname,
      url: location.href,
      canonicalUrl: canonical && canonical.href ? canonical.href : location.href,
      site: location.hostname,
      capturedAt: new Date().toISOString()
    }
  };
}

function selectedTextWithParagraphs(selection) {
  const textParts = [];

  for (let index = 0; index < selection.rangeCount; index += 1) {
    textParts.push(textFromFragment(selection.getRangeAt(index).cloneContents()));
  }

  const structuredText = normalizeSelectedText(textParts.join("\n\n"));
  const browserText = normalizeSelectedText(selection.toString());

  if (!structuredText) return browserText;
  if (!browserText) return structuredText;

  return structuredText.length >= browserText.length ? structuredText : browserText;
}

function textFromFragment(fragment) {
  const chunks = [];
  appendReadableText(fragment, chunks);
  return chunks.join("");
}

function appendReadableText(node, chunks) {
  if (node.nodeType === Node.TEXT_NODE) {
    chunks.push(node.nodeValue || "");
    return;
  }

  if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "br") {
    chunks.push("\n");
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

  const isBlock = node.nodeType === Node.ELEMENT_NODE && isTextBlock(node);
  if (isBlock) appendParagraphBreak(chunks);

  Array.from(node.childNodes).forEach((child) => appendReadableText(child, chunks));

  if (isBlock) appendParagraphBreak(chunks);
}

function appendParagraphBreak(chunks) {
  const last = chunks[chunks.length - 1] || "";
  if (!chunks.length || last.endsWith("\n\n")) return;
  chunks.push(last.endsWith("\n") ? "\n" : "\n\n");
}

function isTextBlock(node) {
  return [
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul"
  ].includes(node.tagName.toLowerCase());
}

function normalizeSelectedText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function selectionContext(pageText, selectedText) {
  let source = pageText;
  let needle = selectedText;
  let index = source.indexOf(needle);

  if (index < 0) {
    source = compactTextForContext(pageText);
    needle = compactTextForContext(selectedText);
    index = source.indexOf(needle);
  }

  if (index < 0) return { before: "", after: "" };

  const CONTEXT_RADIUS = 120; // 前后各保留约 120 字，足够回忆位置又不臃肿
  return {
    before: source.slice(Math.max(0, index - CONTEXT_RADIUS), index).trim(),
    after: source.slice(index + needle.length, index + needle.length + CONTEXT_RADIUS).trim()
  };
}

function compactTextForContext(value) {
  return normalizeSelectedText(value).replace(/\n+/g, " ").replace(/[ \t]+/g, " ").trim();
}

function openClipBox(selection, options) {
  closeClipBox();

  kcPopover = document.createElement("div");
  kcPopover.setAttribute("data-knowledge-clips", "popover");
  const shadow = kcPopover.attachShadow({ mode: "open" });
  shadow.innerHTML = renderPopover(selection, { ...options, dark: detectDarkBackground() });
  document.documentElement.appendChild(kcPopover);

    positionPopover(kcPopover, selection.rect);

  const thought = shadow.querySelector("[data-thought]");
  const tags = shadow.querySelector("[data-tags]");
  const status = shadow.querySelector("[data-status]");
  const save = shadow.querySelector("[data-save]");
  const copySelection = shadow.querySelector("[data-copy-selection]");
  const disableMenu = shadow.querySelector("[data-disable-menu]");

  installPopoverEventGuards(kcPopover, shadow);
  installPopoverDrag(kcPopover, shadow);
  shadow.querySelector("[data-close]").addEventListener("click", closeClipBox);
  shadow.querySelector("[data-disable-auto]").addEventListener("click", () => {
    disableMenu.hidden = !disableMenu.hidden;
  });
  shadow.querySelector("[data-disable-current]").addEventListener("click", () => {
    disableCurrentPagePrompt();
  });
  shadow.querySelector("[data-disable-week]").addEventListener("click", () => {
    pauseAutoPromptForSevenDays();
  });
  shadow.querySelector("[data-disable-cancel]").addEventListener("click", () => {
    disableMenu.hidden = true;
  });
  copySelection.addEventListener("click", () => {
    copyTextToClipboard(selection.text)
      .then(() => showToast("已复制划线内容。"))
      .catch(() => showToast("复制失败，请手动选择复制。"));
  });

  thought.focus({ preventScroll: true });

  save.addEventListener("click", async () => {
    const userThought = thought.value.trim();
    if (!userThought) {
      status.textContent = "先写一句你的想法，再保存。";
      thought.focus();
      return;
    }

    save.disabled = true;
    status.textContent = "正在保存...";

    const clip = {
      source: selection.source,
      selection: {
        text: selection.text,
        beforeContext: selection.beforeContext,
        afterContext: selection.afterContext
      },
      note: {
        thought: userThought,
        tags: tags.value,
        topic: ""
      }
    };

    sendSaveMessage(clip, (response) => {
      save.disabled = false;

      if (!response || !response.ok) {
        status.textContent = saveErrorText(response && response.error);
        return;
      }

      if (response.queued) {
        showToast("已暂存。打开右侧面板并连接文件夹后会自动写入。");
        closeClipBox();
        return;
      }

      const payload = response.payload || {};
      const file = payload.relativeFile ? `文件：${payload.relativeFile}` : "可在右侧面板查看。";
      const message = payload.duplicate
        ? `已追加新想法。右侧面板「已保存」可查看，${file}`
        : `已保存。右侧面板「已保存」可查看，${file}`;
      showToast(message);
      closeClipBox();
    });
  });
}

function sendSaveMessage(clip, callback) {
  let settled = false;
  const timeout = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    callback({ ok: false, error: "save_timeout" });
  }, 10000);

  try {
    chrome.runtime.sendMessage({ type: "save-clip", clip }, (response) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);

      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        callback({ ok: false, error: runtimeError.message });
        return;
      }

      callback(response);
    });
  } catch (error) {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    callback({ ok: false, error: error.message });
  }
}

// 读取元素的有效背景色，返回 [r,g,b]；完全透明或解析失败返回 null。
function readBackgroundRgb(element) {
  if (!element) return null;
  const value = getComputedStyle(element).backgroundColor;
  const match = value && value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(",").map((piece) => parseFloat(piece.trim()));
  const [r, g, b, a = 1] = parts;
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  if (a === 0) return null; // 透明背景视为未知，交给上层回退
  return [r, g, b];
}

// 自适应深色：根据页面背景亮度判断是否给浮层套用深色主题。
// 阈值偏保守（只在确实较暗的页面切换），解析不到时一律回退浅色，避免误判。
function detectDarkBackground() {
  try {
    const rgb = readBackgroundRgb(document.body) || readBackgroundRgb(document.documentElement);
    if (!rgb) return false;
    const [r, g, b] = rgb;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.4;
  } catch (error) {
    return false;
  }
}

function renderPopover(selection, options) {
  const hint = options.auto ? "划词后自动提示" : "快捷键保存";
  return `
    <style>
      :host { all: initial; }
      /* 荧光手帐：浅色为默认，.kc-dark 覆盖为深色（自适应深色页面） */
      .kc-box {
        --kc-bg: #FFFDF9;
        --kc-sunken: #F7F1E8;
        --kc-ink: #211D18;
        --kc-ink2: #57514A;
        --kc-ink3: #8A8278;
        --kc-line: rgba(33, 29, 24, 0.10);
        --kc-line2: rgba(33, 29, 24, 0.14);
        --kc-accent: #E8623C;
        --kc-accent-weak: rgba(232, 98, 60, 0.10);
        --kc-danger: #c0392b;
        --kc-shadow: 0 2px 6px rgba(33, 29, 24, 0.08), 0 18px 40px rgba(33, 29, 24, 0.18);
        width: min(390px, calc(100vw - 24px));
        max-height: calc(100vh - 24px);
        box-sizing: border-box;
        border: 1px solid var(--kc-line);
        border-radius: 16px;
        background: var(--kc-bg);
        color: var(--kc-ink);
        box-shadow: var(--kc-shadow);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: flex;
        flex-direction: column;
        user-select: none;
        overflow: hidden;
      }
      .kc-box.kc-dark {
        --kc-bg: #262219;
        --kc-sunken: #1D1A13;
        --kc-ink: #F2EEE6;
        --kc-ink2: #C2BCAE;
        --kc-ink3: #9A9182;
        --kc-line: rgba(255, 255, 255, 0.08);
        --kc-line2: rgba(255, 255, 255, 0.16);
        --kc-accent: #F0744E;
        --kc-accent-weak: rgba(240, 116, 78, 0.18);
        --kc-danger: #ff7a6b;
        --kc-shadow: 0 2px 6px rgba(0, 0, 0, 0.4), 0 18px 44px rgba(0, 0, 0, 0.55);
      }
      .kc-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 13px 14px;
        border-bottom: 1px solid var(--kc-line);
        cursor: move;
        touch-action: none;
      }
      .kc-title { position: relative; display: inline-block; font-size: 14px; font-weight: 700; line-height: 20px; letter-spacing: 0.01em; }
      .kc-wave { position: absolute; left: 0; bottom: -5px; width: 100%; height: 7px; overflow: visible; pointer-events: none; }
      .kc-hint { margin-top: 4px; font-size: 12px; color: var(--kc-ink3); line-height: 18px; }
      .kc-close {
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--kc-ink3);
        font-size: 20px;
        line-height: 24px;
        cursor: pointer;
        transition: background 0.12s, color 0.12s;
      }
      .kc-close:hover { background: var(--kc-sunken); color: var(--kc-ink); }
      .kc-body {
        flex: 1 1 auto;
        min-height: 0;
        padding: 13px 14px 0;
        overflow: auto;
      }
      .kc-source {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 9px;
        font-size: 12px;
        color: var(--kc-ink3);
        line-height: 18px;
      }
      .kc-source-title {
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kc-quote {
        max-height: 88px;
        overflow: auto;
        margin: 0 0 11px;
        padding: 9px 11px;
        border-left: 3px solid var(--kc-accent);
        border-radius: 0 8px 8px 0;
        background: var(--kc-sunken);
        color: var(--kc-ink2);
        font-size: 13px;
        line-height: 19px;
        user-select: text;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .kc-copy {
        flex: 0 0 auto;
        height: 26px;
        padding: 0 10px;
        border: 1px solid var(--kc-line2);
        border-radius: 7px;
        background: transparent;
        color: var(--kc-ink2);
        cursor: pointer;
        transition: border-color 0.12s, color 0.12s;
      }
      .kc-copy:hover {
        border-color: var(--kc-accent);
        color: var(--kc-accent);
      }
      textarea, input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--kc-line2);
        border-radius: 8px;
        background: var(--kc-bg);
        color: var(--kc-ink);
        font: 13px/19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        outline: none;
        user-select: text;
        transition: border-color 0.12s, box-shadow 0.12s;
      }
      textarea::placeholder, input::placeholder { color: var(--kc-ink3); }
      textarea {
        min-height: 92px;
        resize: vertical;
        padding: 9px 11px;
      }
      input {
        height: 34px;
        margin-top: 8px;
        padding: 0 11px;
      }
      textarea:focus, input:focus {
        border-color: var(--kc-accent);
        box-shadow: 0 0 0 3px var(--kc-accent-weak);
      }
      /* 「我的想法」手写浮标 + 主角输入框强调边 */
      .kc-thought-wrap { position: relative; margin-top: 4px; }
      .kc-thought-wrap textarea { border: 1.5px solid var(--kc-accent); }
      .kc-thought-badge {
        position: absolute; top: -9px; left: 10px; z-index: 1;
        padding: 0 6px;
        background: var(--kc-bg);
        color: var(--kc-accent);
        font-family: "Caveat", "Bricolage Grotesque", cursive;
        font-size: 15px; font-weight: 700; line-height: 18px;
        transform: rotate(-3deg);
        pointer-events: none;
      }
      .kc-actions {
        position: sticky;
        bottom: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 11px;
        padding: 10px 0 14px;
        border-top: 1px solid var(--kc-line);
        background: var(--kc-bg);
      }
      .kc-status {
        min-height: 18px;
        color: var(--kc-danger);
        font-size: 12px;
        line-height: 18px;
      }
      .kc-buttons {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      button {
        font: 600 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .kc-disable {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--kc-ink3);
        cursor: pointer;
        transition: color 0.12s;
      }
      .kc-disable:hover { color: var(--kc-ink); }
      .kc-disable-menu {
        display: grid;
        gap: 6px;
        margin-top: 11px;
        padding: 10px;
        border: 1px solid var(--kc-line);
        border-radius: 10px;
        background: var(--kc-sunken);
      }
      .kc-disable-menu[hidden] { display: none; }
      .kc-disable-title {
        color: var(--kc-ink2);
        font-size: 12px;
        font-weight: 700;
        line-height: 18px;
      }
      .kc-menu-button {
        width: 100%;
        height: 30px;
        border: 1px solid var(--kc-line2);
        border-radius: 8px;
        background: var(--kc-bg);
        color: var(--kc-ink);
        cursor: pointer;
        transition: border-color 0.12s;
      }
      .kc-menu-button:hover { border-color: var(--kc-accent); }
      .kc-menu-cancel {
        border: 0;
        background: transparent;
        color: var(--kc-ink3);
        cursor: pointer;
      }
      .kc-save {
        min-width: 74px;
        height: 34px;
        border: 0;
        border-radius: 10px;
        background: var(--kc-accent);
        color: #ffffff;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(232, 98, 60, 0.35);
        transition: filter 0.12s, opacity 0.12s;
      }
      .kc-box.kc-dark .kc-save { color: #1D150F; }
      .kc-save:hover { filter: brightness(0.95); }
      .kc-save:disabled { opacity: 0.56; cursor: default; }
    </style>
    <div class="kc-box${options.dark ? " kc-dark" : ""}">
      <div class="kc-head">
        <div>
          <div class="kc-title">保存到荧光手帐<svg class="kc-wave" viewBox="0 0 118 8" preserveAspectRatio="none" aria-hidden="true"><path d="M2 5 Q 16 1 32 4.5 T 64 5 T 96 4 T 116 5.5" fill="none" stroke="var(--kc-accent)" stroke-width="2.4" stroke-linecap="round"/></svg></div>
          <div class="kc-hint">${escapeHtml(hint)}</div>
        </div>
        <button class="kc-close" type="button" data-close aria-label="关闭">×</button>
      </div>
      <div class="kc-body">
        <div class="kc-source">
          <div class="kc-source-title" title="${escapeHtml(selection.source.title)}">${escapeHtml(selection.source.title)}</div>
          <button class="kc-copy" type="button" data-copy-selection>复制</button>
        </div>
        <div class="kc-quote">${escapeHtml(selection.text)}</div>
        <div class="kc-thought-wrap">
          <span class="kc-thought-badge">我的想法</span>
          <textarea data-thought placeholder="写下这一段给你的启发、判断或疑问"></textarea>
        </div>
        <input data-tags placeholder="标签，可选。例：AI 产品, 阅读, 方法论" />
        <div class="kc-disable-menu" data-disable-menu hidden>
          <div class="kc-disable-title">这次想怎么减少打扰？</div>
          <button class="kc-menu-button" type="button" data-disable-current>当前网页不再自动弹出</button>
          <button class="kc-menu-button" type="button" data-disable-week>7 天内不自动弹出</button>
          <button class="kc-menu-cancel" type="button" data-disable-cancel>取消</button>
        </div>
        <div class="kc-actions">
          <button class="kc-disable" type="button" data-disable-auto>不再自动弹出</button>
          <div class="kc-buttons">
            <span class="kc-status" data-status></span>
            <button class="kc-save" type="button" data-save>保存</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function positionPopover(element, rect) {
  const margin = 12;
  const gap = 10;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const popoverHeight = Math.min(element.getBoundingClientRect().height, viewportHeight - margin * 2);
  const spaceBelow = viewportHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  let top;

  if (spaceBelow >= popoverHeight + gap || spaceBelow >= spaceAbove) {
    top = rect.bottom + gap;
  } else {
    top = rect.top - popoverHeight - gap;
  }

  top = Math.min(viewportHeight - popoverHeight - margin, Math.max(margin, top));

  const preferredLeft = rect.left + rect.width / 2 - 195;
  const maxLeft = Math.max(margin, viewportWidth - 402);
  const left = Math.min(maxLeft, Math.max(margin, preferredLeft));

  element.style.position = "fixed";
  element.style.zIndex = "2147483647";
  element.style.top = `${top}px`;
  element.style.left = `${left}px`;
}

function installPopoverEventGuards(element, shadow) {
  const stopOnlyEvents = ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "dblclick"];
  const guardedEvents = [...stopOnlyEvents, "selectstart", "dragstart"];

  guardedEvents.forEach((eventName) => {
    shadow.addEventListener(
      eventName,
      (event) => {
        event.stopPropagation();
        if ((eventName === "selectstart" || eventName === "dragstart") && !isEditableTarget(event.target)) {
          event.preventDefault();
        }
      },
      false
    );
  });

  element.addEventListener("mousedown", (event) => event.stopPropagation());
  element.addEventListener("mouseup", (event) => event.stopPropagation());
  element.addEventListener("click", (event) => event.stopPropagation());
}

function installPopoverDrag(element, shadow) {
  const handle = shadow.querySelector(".kc-head");
  if (!handle) return;

  let dragState = null;

  handle.addEventListener("pointerdown", (event) => {
    if (isInteractiveDragTarget(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = element.getBoundingClientRect();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top
    };
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragState) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = element.getBoundingClientRect();
    const nextLeft = dragState.left + event.clientX - dragState.startX;
    const nextTop = dragState.top + event.clientY - dragState.startY;
    const position = clampPopoverPosition(nextLeft, nextTop, rect.width, rect.height);

    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
  });

  handle.addEventListener("pointerup", (event) => {
    if (!dragState) return;
    event.preventDefault();
    event.stopPropagation();
    dragState = null;
    handle.releasePointerCapture(event.pointerId);
  });

  handle.addEventListener("pointercancel", () => {
    dragState = null;
  });
}

function clampPopoverPosition(left, top, width, height) {
  const margin = 12;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);

  return {
    left: Math.min(maxLeft, Math.max(margin, left)),
    top: Math.min(maxTop, Math.max(margin, top))
  };
}

function isEditableTarget(target) {
  if (!target) return false;
  const tagName = String(target.tagName || "").toLowerCase();
  return tagName === "textarea" || tagName === "input" || target.isContentEditable;
}

function isInteractiveDragTarget(target) {
  if (isEditableTarget(target)) return true;
  const tagName = String(target && target.tagName ? target.tagName : "").toLowerCase();
  return tagName === "button" || tagName === "a" || tagName === "select";
}

function isAutoPromptAllowed() {
  if (hasAnyKnowledgeClipsPopover()) return false;
  if (!kcSettings.autoPromptEnabled) return false;

  const pausedUntil = Number(kcPromptPrefs.autoPromptPausedUntil || 0);
  if (pausedUntil && Date.now() < pausedUntil) return false;

  const disabledPagePrompts = kcPromptPrefs.disabledPagePrompts || {};
  return !disabledPagePrompts[getPagePromptKey()];
}

function hasAnyKnowledgeClipsPopover() {
  return Boolean(kcPopover || document.querySelector('[data-knowledge-clips="popover"]'));
}

function isSelectionFromPageContent(selection) {
  if (!selection || !selection.rangeCount) return false;

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (isNodeInsideKnowledgeClips(anchorNode) || isNodeInsideKnowledgeClips(focusNode)) return false;

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (isNodeInsideKnowledgeClips(range.startContainer) || isNodeInsideKnowledgeClips(range.endContainer)) {
      return false;
    }
  }

  return true;
}

function isNodeInsideKnowledgeClips(node) {
  if (!node) return false;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!element) return false;

  const root = element.getRootNode && element.getRootNode();
  if (root && root.host && root.host.matches && root.host.matches('[data-knowledge-clips="popover"]')) {
    return true;
  }

  return Boolean(element.closest && element.closest('[data-knowledge-clips="popover"]'));
}

function getPagePromptKey() {
  const canonical = document.querySelector('link[rel="canonical"]');
  return ((canonical && canonical.href) || location.href).split("#")[0];
}

function disableCurrentPagePrompt() {
  const disabledPagePrompts = {
    ...(kcPromptPrefs.disabledPagePrompts || {}),
    [getPagePromptKey()]: Date.now()
  };

  chrome.storage.local.set({ disabledPagePrompts });
  showToast("已关闭当前网页的自动弹出，仍可用按钮或快捷键保存。");
  closeClipBox();
}

function pauseAutoPromptForSevenDays() {
  const autoPromptPausedUntil = Date.now() + 7 * 24 * 60 * 60 * 1000;

  chrome.storage.local.set({ autoPromptPausedUntil });
  showToast("已暂停 7 天自动弹出，仍可用按钮或快捷键保存。");
  closeClipBox();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  fallbackCopyText(text);
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = [
    "position:fixed",
    "left:-9999px",
    "top:0",
    "opacity:0",
    "pointer-events:none"
  ].join(";");

  document.documentElement.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("copy_failed");
    }
  } finally {
    textarea.remove();
  }
}

function closeClipBox() {
  window.clearTimeout(kcAutoTimer);
  if (kcPopover) {
    kcPopover.remove();
    kcPopover = null;
  }
}

function showToast(message) {
  if (kcToast) kcToast.remove();

  kcToast = document.createElement("div");
  kcToast.textContent = message;
  kcToast.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "right:18px",
    "bottom:18px",
    "max-width:360px",
    "padding:11px 13px",
    "border-radius:9px",
    "background:#18202e",
    "color:#fff",
    "box-shadow:0 14px 38px rgba(24,32,46,.22)",
    "font:13px/19px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
  ].join(";");

  document.documentElement.appendChild(kcToast);
  window.setTimeout(() => {
    if (kcToast) {
      kcToast.remove();
      kcToast = null;
    }
  }, 3200);
}

function saveErrorText(error) {
  if (error === "missing_thought") return "先写一句你的想法，再保存。";
  if (error === "forbidden") return "浏览器暂时没有文件夹权限，请在侧边栏重新连接知识库文件夹。";
  if (error === "save_timeout") return "保存超时，请打开侧边栏确认知识库文件夹已连接。";
  if (error && error.includes("Extension context invalidated")) return "扩展刚更新过，请刷新当前文章页后再试。";
  if (error && error.includes("Receiving end does not exist")) return "当前页面需要刷新后才能连接扩展。";
  if (error && error.includes("Failed to fetch")) return "保存链路暂时不可用，请刷新页面并重新连接知识库文件夹。";
  return `保存失败：${error || "未知错误"}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
})();
