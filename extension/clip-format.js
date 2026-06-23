// 磁盘格式的单一事实源：normalize / 哈希 / Markdown / 标签。
// 纯逻辑，不碰任何 IO。逐字对齐 server/store.js 的格式函数，
// 以便 FSA 写出的文件与 Node helper / CLI 完全兼容。
//
// UMD：浏览器挂到 globalThis.KCFormat；Node 走 module.exports（供 node:test 跨校验）。
// 哈希用 globalThis.crypto.subtle（浏览器与 Node 20+ 都有），因此 normalizeClip 是异步的。

(function (root) {
  async function hashText(value, length = 12) {
    const data = new TextEncoder().encode(String(value || ""));
    const digest = await root.crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, length);
  }

  function safeBasename(value, fallback = "untitled") {
    const cleaned = String(value || "")
      .replace(/[\\/:*?"<>|#\r\n\t]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/^\.+|\.+$/g, "")
      .replace(/-+/g, "-")
      .slice(0, 90)
      .replace(/-$/g, "");

    return cleaned || fallback;
  }

  function escapeYaml(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function normalizeText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").trim();
  }

  function formatQuote(text) {
    return normalizeText(text)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  function normalizeTags(tags) {
    if (Array.isArray(tags)) {
      return tags.map((tag) => String(tag).trim()).filter(Boolean);
    }

    const raw = String(tags || "").trim();
    if (!raw) return [];

    const separator = /[#，,、]+/g;
    if (separator.test(raw)) {
      return raw
        .split(separator)
        .map((tag) => tag.trim())
        .filter(Boolean);
    }

    return raw.split(/\s+/g).filter(Boolean);
  }

  function normalizeSource(source = {}) {
    const url = normalizeText(source.url);
    const canonicalUrl = normalizeText(source.canonicalUrl) || url;

    return {
      title: normalizeText(source.title) || "未命名文章",
      url,
      canonicalUrl,
      site: normalizeText(source.site),
      capturedAt: normalizeText(source.capturedAt) || new Date().toISOString()
    };
  }

  async function normalizeClip(input) {
    const source = normalizeSource(input.source);
    const selection = {
      text: normalizeText(input.selection && input.selection.text),
      beforeContext: normalizeText(input.selection && input.selection.beforeContext),
      afterContext: normalizeText(input.selection && input.selection.afterContext)
    };
    const note = {
      thought: normalizeText(input.note && input.note.thought),
      tags: normalizeTags(input.note && input.note.tags),
      topic: normalizeText(input.note && input.note.topic)
    };

    if (!source.url) {
      throw new Error("missing_source_url");
    }

    if (!selection.text) {
      throw new Error("missing_selection_text");
    }

    if (!note.thought) {
      throw new Error("missing_thought");
    }

    const articleKey = await hashText(source.canonicalUrl || source.url, 16);
    const contentHash = await hashText(`${source.canonicalUrl || source.url}\n${selection.text}`, 16);
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${await hashText(
      `${contentHash}\n${note.thought}\n${Math.random()}`,
      8
    )}`;

    return {
      id,
      source,
      selection,
      note,
      meta: {
        articleKey,
        contentHash,
        appVersion: "0.1.0"
      }
    };
  }

  function articleHeader(clip) {
    const tags = clip.note.tags.map((tag) => `"${escapeYaml(tag)}"`).join(", ");

    return `---\ntitle: "${escapeYaml(clip.source.title)}"\nurl: "${escapeYaml(clip.source.url)}"\ncanonicalUrl: "${escapeYaml(
      clip.source.canonicalUrl
    )}"\nsite: "${escapeYaml(clip.source.site)}"\ncreatedAt: "${escapeYaml(clip.source.capturedAt)}"\ntags: [${tags}]\n---\n\n# ${
      clip.source.title
    }\n\n来源: ${clip.source.url}\n\n`;
  }

  function clipMarkdown(clip, duplicateOf) {
    const tags = clip.note.tags.length ? clip.note.tags.map((tag) => `#${tag}`).join(" ") : "未标注";
    const topic = clip.note.topic || "未归类";
    const duplicateLine = duplicateOf ? `\n重复片段: ${duplicateOf}\n` : "";
    // 上下文不再重复选中句（去冗余），用 [……] 标记其原位置；为空则整段省略。
    const context = [clip.selection.beforeContext, clip.selection.afterContext].filter(Boolean).join("\n[……]\n");
    const contextBlock = context ? `\n### 上下文\n\n${context}\n` : "";

    // 末尾留空行：避免下一张卡的 --- 把本段渲染成 setext 标题。
    return `---\n\n## 摘录 ${clip.source.capturedAt}\n\nid: ${clip.id}\n主题: ${topic}\n标签: ${tags}${duplicateLine}\n\n### 原文片段\n\n${formatQuote(
      clip.selection.text
    )}\n\n### 我的想法\n\n${clip.note.thought}\n${contextBlock}\n`;
  }

  // 一行流索引：给 agent 当"目录"，先扫这个判断相关性，再按 id/file 取完整卡。
  function cardIndexLine(clip) {
    const date = String((clip.source && clip.source.capturedAt) || "").slice(0, 10);
    const tags =
      clip.note && Array.isArray(clip.note.tags) && clip.note.tags.length
        ? clip.note.tags.map((tag) => `#${tag}`).join(" ")
        : "#未标注";
    const thought = normalizeText(clip.note && clip.note.thought).replace(/\s+/g, " ");
    const quote = normalizeText(clip.selection && clip.selection.text)
      .replace(/\s+/g, " ")
      .slice(0, 30);
    const file = String(clip.file || "").trim();
    return `- ${date} · ${tags} · ${thought} · 「${quote}…」 · ${clip.id} · ${file}`;
  }

  function buildCardIndex(clips) {
    const header = `# 知识卡片索引

共 ${clips.length} 条。这是给 AI agent 的轻量目录，用于"渐进式披露"：
1. 先读 / grep 本文件，按「我的想法 / 标签 / 原文摘要」判断相关性，挑出相关 id。
2. 不要整库读取 notes/ 或 index/clips.jsonl（会撑爆上下文）。
3. 取完整卡片：\`KNOWLEDGE_CLIPS_DIR=<目录> npm run card -- <id>\`，或直接读该行末尾的 notes/<file>。
4. 按主题检索：\`KNOWLEDGE_CLIPS_DIR=<目录> npm run search -- "关键词"\`。

---
`;
    const lines = clips
      .slice()
      .reverse()
      .map(cardIndexLine)
      .join("\n");
    return lines ? `${header}\n${lines}\n` : `${header}\n（暂无卡片）\n`;
  }

  const KCFormat = {
    hashText,
    safeBasename,
    escapeYaml,
    normalizeText,
    formatQuote,
    normalizeTags,
    normalizeSource,
    normalizeClip,
    articleHeader,
    clipMarkdown,
    cardIndexLine,
    buildCardIndex
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = KCFormat;
  } else {
    root.KCFormat = KCFormat;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
