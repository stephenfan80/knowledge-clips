const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LIBRARY_DIR = path.join(os.homedir(), "KnowledgeClips");

function expandHome(filePath) {
  if (!filePath || filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function hashText(value, length = 12) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
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

function normalizeClip(input) {
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

  const articleKey = hashText(source.canonicalUrl || source.url, 16);
  const contentHash = hashText(`${source.canonicalUrl || source.url}\n${selection.text}`, 16);
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${hashText(
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

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function articlePathForClip(libraryDir, clip) {
  const articleIndexPath = path.join(libraryDir, "index", "articles.json");
  const articleIndex = readJson(articleIndexPath, {});
  const existing = articleIndex[clip.meta.articleKey];

  if (existing) {
    return {
      relativePath: existing,
      absolutePath: path.join(libraryDir, existing),
      isNewArticle: false
    };
  }

  const slug = safeBasename(clip.source.title || clip.source.site || "article");
  const relativePath = path.join("notes", `${slug}-${clip.meta.articleKey.slice(0, 8)}.md`);
  articleIndex[clip.meta.articleKey] = relativePath;
  writeJson(articleIndexPath, articleIndex);

  return {
    relativePath,
    absolutePath: path.join(libraryDir, relativePath),
    isNewArticle: true
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
  // 与 extension/clip-format.js 保持逐字一致：上下文去重 + 去掉模板（见漂移守卫测试）。
  const context = [clip.selection.beforeContext, clip.selection.afterContext].filter(Boolean).join("\n[……]\n");
  const contextBlock = context ? `\n### 上下文\n\n${context}\n` : "";

  // 末尾留空行：避免下一张卡的 --- 把本段渲染成 setext 标题。
  return `---\n\n## 摘录 ${clip.source.capturedAt}\n\nid: ${clip.id}\n主题: ${topic}\n标签: ${tags}${duplicateLine}\n\n### 原文片段\n\n${formatQuote(
    clip.selection.text
  )}\n\n### 我的想法\n\n${clip.note.thought}\n${contextBlock}\n`;
}

function writeClipsIndex(libraryDir, clips) {
  ensureDir(path.join(libraryDir, "index"));
  const body = clips.map((clip) => JSON.stringify(clip)).join("\n");
  fs.writeFileSync(path.join(libraryDir, "index", "clips.jsonl"), body ? `${body}\n` : "");
}

function loadClips(libraryDir) {
  const indexPath = path.join(libraryDir, "index", "clips.jsonl");
  try {
    return fs
      .readFileSync(indexPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function rebuildArticleMarkdown(libraryDir, relativeFile, clips) {
  if (!clips.length) return;

  const filePath = path.join(libraryDir, relativeFile);
  const content = [articleHeader(clips[0]), ...clips.map((clip) => clipMarkdown(clip, clip.duplicateOf))].join("");

  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function removeArticleIndexEntry(libraryDir, articleKey) {
  const articleIndexPath = path.join(libraryDir, "index", "articles.json");
  const articleIndex = readJson(articleIndexPath, {});

  if (!articleIndex[articleKey]) return;

  delete articleIndex[articleKey];
  writeJson(articleIndexPath, articleIndex);
}

function findDuplicate(existingClips, clip) {
  return existingClips.find(
    (item) => item.meta.articleKey === clip.meta.articleKey && item.meta.contentHash === clip.meta.contentHash
  );
}

function saveClip(input, options = {}) {
  const libraryDir = path.resolve(expandHome(options.libraryDir || DEFAULT_LIBRARY_DIR));
  const clip = normalizeClip(input);

  ensureDir(path.join(libraryDir, "notes"));
  ensureDir(path.join(libraryDir, "index"));

  const existingClips = loadClips(libraryDir);
  const duplicate = findDuplicate(existingClips, clip);
  const article = articlePathForClip(libraryDir, clip);

  if (article.isNewArticle) {
    fs.writeFileSync(article.absolutePath, articleHeader(clip));
  }

  fs.appendFileSync(article.absolutePath, clipMarkdown(clip, duplicate && duplicate.id));

  const indexRecord = {
    ...clip,
    file: article.relativePath,
    duplicateOf: duplicate && duplicate.id
  };
  fs.appendFileSync(path.join(libraryDir, "index", "clips.jsonl"), `${JSON.stringify(indexRecord)}\n`);

  return {
    id: clip.id,
    duplicate: Boolean(duplicate),
    duplicateOf: duplicate && duplicate.id,
    file: article.absolutePath,
    relativeFile: article.relativePath,
    libraryDir
  };
}

function updateClip(input, options = {}) {
  const libraryDir = path.resolve(expandHome(options.libraryDir || DEFAULT_LIBRARY_DIR));
  const id = normalizeText(input.id);
  const thought = normalizeText(input.note && input.note.thought);
  const tags = normalizeTags(input.note && input.note.tags);

  if (!id) throw new Error("missing_clip_id");
  if (!thought) throw new Error("missing_thought");

  const clips = loadClips(libraryDir);
  const clipIndex = clips.findIndex((clip) => clip.id === id);
  if (clipIndex === -1) throw new Error("clip_not_found");

  const current = clips[clipIndex];
  const updated = {
    ...current,
    note: {
      ...current.note,
      thought,
      tags
    },
    meta: {
      ...current.meta,
      updatedAt: new Date().toISOString()
    }
  };

  clips[clipIndex] = updated;
  writeClipsIndex(libraryDir, clips);
  rebuildArticleMarkdown(
    libraryDir,
    updated.file,
    clips.filter((clip) => clip.file === updated.file)
  );

  return {
    clip: updated,
    file: path.join(libraryDir, updated.file),
    relativeFile: updated.file,
    libraryDir
  };
}

function deleteClip(input, options = {}) {
  const libraryDir = path.resolve(expandHome(options.libraryDir || DEFAULT_LIBRARY_DIR));
  const id = normalizeText(input.id);

  if (!id) throw new Error("missing_clip_id");

  const clips = loadClips(libraryDir);
  const current = clips.find((clip) => clip.id === id);
  if (!current) throw new Error("clip_not_found");

  const remainingClips = clips
    .filter((clip) => clip.id !== id)
    .map((clip) => (clip.duplicateOf === id ? { ...clip, duplicateOf: undefined } : clip));
  const remainingArticleClips = remainingClips.filter((clip) => clip.file === current.file);

  writeClipsIndex(libraryDir, remainingClips);

  if (remainingArticleClips.length) {
    rebuildArticleMarkdown(libraryDir, current.file, remainingArticleClips);
  } else if (current.file) {
    const filePath = path.join(libraryDir, current.file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    removeArticleIndexEntry(libraryDir, current.meta && current.meta.articleKey);
  }

  return {
    deletedId: id,
    removedFile: !remainingArticleClips.length,
    relativeFile: current.file,
    libraryDir
  };
}

module.exports = {
  DEFAULT_LIBRARY_DIR,
  articleHeader,
  clipMarkdown,
  deleteClip,
  expandHome,
  loadClips,
  normalizeClip,
  safeBasename,
  saveClip,
  updateClip
};
