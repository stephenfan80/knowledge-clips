// FSA IO 层：用 File System Access 的 DirectoryHandle 读写知识库。
// 复用 clip-format.js 的格式逻辑，产出与 server/store.js 完全同构的磁盘结构
// （notes/*.md + index/clips.jsonl + index/articles.json），与 Node CLI 兼容。
// 浏览器挂 globalThis.KCStore。

(function (root) {
  // 浏览器里 clip-format.js 先加载并挂到 globalThis；Node（测试）下回退到 require。
  const KCFormat = root.KCFormat || (typeof require === "function" ? require("./clip-format") : null);

  function getDir(dirHandle, name, create) {
    return dirHandle.getDirectoryHandle(name, { create: Boolean(create) });
  }

  function indexDir(rootHandle, create) {
    return getDir(rootHandle, "index", create);
  }

  function notesDir(rootHandle, create) {
    return getDir(rootHandle, "notes", create);
  }

  async function readText(dirHandle, name) {
    try {
      const fileHandle = await dirHandle.getFileHandle(name);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (error) {
      if (error && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async function writeText(dirHandle, name, text) {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  // FSA 没有原生 append：以 keepExistingData 打开后在文件末尾写入。
  async function appendText(dirHandle, name, text) {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const file = await fileHandle.getFile();
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    await writable.write({ type: "write", position: file.size, data: text });
    await writable.close();
  }

  async function readJson(dirHandle, name, fallback) {
    const text = await readText(dirHandle, name);
    if (text == null) return fallback;
    try {
      return JSON.parse(text);
    } catch (error) {
      return fallback;
    }
  }

  function baseName(relativePath) {
    const parts = String(relativePath).split("/");
    return parts[parts.length - 1];
  }

  async function loadClips(rootHandle) {
    let dir;
    try {
      dir = await indexDir(rootHandle, false);
    } catch (error) {
      if (error && error.name === "NotFoundError") return [];
      throw error;
    }
    const text = await readText(dir, "clips.jsonl");
    if (!text) return [];
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function recentClips(rootHandle, limit) {
    const clips = await loadClips(rootHandle);
    return clips.slice().reverse().slice(0, limit || 20);
  }

  // 每次写入后刷新一行流索引（agent 渐进式披露用的目录）。
  async function writeCardIndex(rootHandle) {
    const clips = await loadClips(rootHandle);
    const idx = await indexDir(rootHandle, true);
    await writeText(idx, "cards.index.md", KCFormat.buildCardIndex(clips));
  }

  async function articlePathForClip(rootHandle, clip) {
    const idx = await indexDir(rootHandle, true);
    const articleIndex = await readJson(idx, "articles.json", {});
    const existing = articleIndex[clip.meta.articleKey];

    if (existing) {
      return { relativePath: existing, isNewArticle: false };
    }

    const slug = KCFormat.safeBasename(clip.source.title || clip.source.site || "article");
    const relativePath = `notes/${slug}-${clip.meta.articleKey.slice(0, 8)}.md`;
    articleIndex[clip.meta.articleKey] = relativePath;
    await writeText(idx, "articles.json", `${JSON.stringify(articleIndex, null, 2)}\n`);
    return { relativePath, isNewArticle: true };
  }

  function findDuplicate(existingClips, clip) {
    return existingClips.find(
      (item) => item.meta.articleKey === clip.meta.articleKey && item.meta.contentHash === clip.meta.contentHash
    );
  }

  async function saveClip(rootHandle, input) {
    const clip = await KCFormat.normalizeClip(input);
    const notes = await notesDir(rootHandle, true);
    await indexDir(rootHandle, true);

    const existingClips = await loadClips(rootHandle);
    const duplicate = findDuplicate(existingClips, clip);
    const article = await articlePathForClip(rootHandle, clip);
    const fileName = baseName(article.relativePath);

    if (article.isNewArticle) {
      await writeText(notes, fileName, KCFormat.articleHeader(clip));
    }
    await appendText(notes, fileName, KCFormat.clipMarkdown(clip, duplicate && duplicate.id));

    const indexRecord = { ...clip, file: article.relativePath, duplicateOf: duplicate && duplicate.id };
    const idx = await indexDir(rootHandle, true);
    await appendText(idx, "clips.jsonl", `${JSON.stringify(indexRecord)}\n`);
    await writeCardIndex(rootHandle);

    return {
      id: clip.id,
      duplicate: Boolean(duplicate),
      duplicateOf: duplicate && duplicate.id,
      relativeFile: article.relativePath
    };
  }

  async function writeClipsIndex(rootHandle, clips) {
    const idx = await indexDir(rootHandle, true);
    const body = clips.map((clip) => JSON.stringify(clip)).join("\n");
    await writeText(idx, "clips.jsonl", body ? `${body}\n` : "");
  }

  async function rebuildArticleMarkdown(rootHandle, relativeFile, clips) {
    if (!clips.length) return;
    const notes = await notesDir(rootHandle, true);
    const content = [
      KCFormat.articleHeader(clips[0]),
      ...clips.map((clip) => KCFormat.clipMarkdown(clip, clip.duplicateOf))
    ].join("");
    await writeText(notes, baseName(relativeFile), content);
  }

  async function removeArticleIndexEntry(rootHandle, articleKey) {
    const idx = await indexDir(rootHandle, true);
    const articleIndex = await readJson(idx, "articles.json", {});
    if (!articleIndex[articleKey]) return;
    delete articleIndex[articleKey];
    await writeText(idx, "articles.json", `${JSON.stringify(articleIndex, null, 2)}\n`);
  }

  async function updateClip(rootHandle, input) {
    const id = KCFormat.normalizeText(input.id);
    const thought = KCFormat.normalizeText(input.note && input.note.thought);
    const tags = KCFormat.normalizeTags(input.note && input.note.tags);

    if (!id) throw new Error("missing_clip_id");
    if (!thought) throw new Error("missing_thought");

    const clips = await loadClips(rootHandle);
    const clipIndex = clips.findIndex((clip) => clip.id === id);
    if (clipIndex === -1) throw new Error("clip_not_found");

    const current = clips[clipIndex];
    const updated = {
      ...current,
      note: { ...current.note, thought, tags },
      meta: { ...current.meta, updatedAt: new Date().toISOString() }
    };

    clips[clipIndex] = updated;
    await writeClipsIndex(rootHandle, clips);
    await rebuildArticleMarkdown(
      rootHandle,
      updated.file,
      clips.filter((clip) => clip.file === updated.file)
    );
    await writeCardIndex(rootHandle);

    return { clip: updated, relativeFile: updated.file };
  }

  async function deleteClip(rootHandle, input) {
    const id = KCFormat.normalizeText(input.id);
    if (!id) throw new Error("missing_clip_id");

    const clips = await loadClips(rootHandle);
    const current = clips.find((clip) => clip.id === id);
    if (!current) throw new Error("clip_not_found");

    const remainingClips = clips
      .filter((clip) => clip.id !== id)
      .map((clip) => (clip.duplicateOf === id ? { ...clip, duplicateOf: undefined } : clip));
    const remainingArticleClips = remainingClips.filter((clip) => clip.file === current.file);

    await writeClipsIndex(rootHandle, remainingClips);

    if (remainingArticleClips.length) {
      await rebuildArticleMarkdown(rootHandle, current.file, remainingArticleClips);
    } else if (current.file) {
      const notes = await notesDir(rootHandle, true);
      try {
        await notes.removeEntry(baseName(current.file));
      } catch (error) {
        if (!error || error.name !== "NotFoundError") throw error;
      }
      await removeArticleIndexEntry(rootHandle, current.meta && current.meta.articleKey);
    }

    await writeCardIndex(rootHandle);
    return { deletedId: id, removedFile: !remainingArticleClips.length, relativeFile: current.file };
  }

  const KCStore = { loadClips, recentClips, saveClip, updateClip, deleteClip };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = KCStore;
  } else {
    root.KCStore = KCStore;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
