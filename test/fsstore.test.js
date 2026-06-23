const test = require("node:test");
const assert = require("node:assert");

const KCStore = require("../extension/fsstore");

// ---- 内存版 File System Access mock（实现 fsstore 用到的最小接口）----
function createMemoryDir(name) {
  const files = new Map(); // name -> Uint8Array
  const dirs = new Map(); // name -> dirHandle

  function fileHandle(fileName) {
    return {
      kind: "file",
      name: fileName,
      async getFile() {
        const data = files.get(fileName) || new Uint8Array();
        return {
          size: data.length,
          async text() {
            return new TextDecoder().decode(data);
          }
        };
      },
      async createWritable(opts = {}) {
        let buf = opts.keepExistingData ? Array.from(files.get(fileName) || []) : [];
        return {
          async write(chunk) {
            if (typeof chunk === "string") {
              buf = buf.concat(Array.from(new TextEncoder().encode(chunk)));
            } else if (chunk && chunk.type === "write") {
              const bytes = new TextEncoder().encode(String(chunk.data));
              const position = chunk.position || 0;
              for (let i = 0; i < bytes.length; i += 1) buf[position + i] = bytes[i];
            }
          },
          async close() {
            files.set(fileName, new Uint8Array(buf));
          }
        };
      }
    };
  }

  return {
    kind: "directory",
    name,
    async getDirectoryHandle(n, opts = {}) {
      if (!dirs.has(n)) {
        if (!opts.create) {
          const error = new Error("not found");
          error.name = "NotFoundError";
          throw error;
        }
        dirs.set(n, createMemoryDir(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n, opts = {}) {
      if (!files.has(n)) {
        if (!opts.create) {
          const error = new Error("not found");
          error.name = "NotFoundError";
          throw error;
        }
        files.set(n, new Uint8Array());
      }
      return fileHandle(n);
    },
    async removeEntry(n) {
      if (!files.has(n) && !dirs.has(n)) {
        const error = new Error("not found");
        error.name = "NotFoundError";
        throw error;
      }
      files.delete(n);
      dirs.delete(n);
    },
    _files: files,
    _dirs: dirs
  };
}

function makeInput(overrides = {}) {
  return {
    source: {
      title: "Agent 护城河",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      site: "example.com",
      capturedAt: "2026-06-22T14:30:00.000Z",
      ...(overrides.source || {})
    },
    selection: { text: "第一段\n第二段", beforeContext: "", afterContext: "", ...(overrides.selection || {}) },
    note: { thought: "我的想法", tags: "AI 产品, 方法论", ...(overrides.note || {}) }
  };
}

async function readIndex(root) {
  const idx = await root.getDirectoryHandle("index", { create: true });
  const file = await (await idx.getFileHandle("clips.jsonl")).getFile();
  return (await file.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("saveClip writes notes md + clips.jsonl + articles.json", async () => {
  const root = createMemoryDir("KnowledgeClips");
  const result = await KCStore.saveClip(root, makeInput());

  assert.ok(result.id);
  assert.match(result.relativeFile, /^notes\/.+\.md$/);

  const notes = await root.getDirectoryHandle("notes", { create: true });
  const mdName = result.relativeFile.split("/")[1];
  const md = await (await notes.getFileHandle(mdName)).getFile();
  const mdText = await md.text();
  assert.match(mdText, /# Agent 护城河/);
  assert.match(mdText, /### 我的想法\n\n我的想法/);

  const records = await readIndex(root);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].file, result.relativeFile);

  const idx = await root.getDirectoryHandle("index", { create: true });
  const articles = JSON.parse(await (await idx.getFileHandle("articles.json")).getFile().then((f) => f.text()));
  assert.strictEqual(Object.keys(articles).length, 1);

  // 一行流索引应随保存自动生成，并包含该卡 id 与文件路径
  const indexText = await (await idx.getFileHandle("cards.index.md")).getFile().then((f) => f.text());
  assert.match(indexText, /# 知识卡片索引/);
  assert.match(indexText, new RegExp(result.id));
  assert.match(indexText, new RegExp(result.relativeFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("two saves to one article append into the same md and grow jsonl", async () => {
  const root = createMemoryDir("KnowledgeClips");
  await KCStore.saveClip(root, makeInput({ selection: { text: "片段一" }, note: { thought: "想法一" } }));
  const second = await KCStore.saveClip(root, makeInput({ selection: { text: "片段二" }, note: { thought: "想法二" } }));

  const records = await readIndex(root);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].file, second.relativeFile, "same article file");

  const notes = await root.getDirectoryHandle("notes", { create: true });
  const md = await (await notes.getFileHandle(second.relativeFile.split("/")[1])).getFile().then((f) => f.text());
  assert.match(md, /想法一/);
  assert.match(md, /想法二/);
  // 只有一个文章头
  assert.strictEqual((md.match(/^# Agent 护城河$/gm) || []).length, 1);
});

test("recentClips returns newest first", async () => {
  const root = createMemoryDir("KnowledgeClips");
  await KCStore.saveClip(root, makeInput({ selection: { text: "片段一" }, note: { thought: "想法一" } }));
  await KCStore.saveClip(root, makeInput({ selection: { text: "片段二" }, note: { thought: "想法二" } }));
  const recent = await KCStore.recentClips(root, 10);
  assert.strictEqual(recent[0].note.thought, "想法二");
  assert.strictEqual(recent[1].note.thought, "想法一");
});

test("updateClip rewrites thought/tags in jsonl and md", async () => {
  const root = createMemoryDir("KnowledgeClips");
  const saved = await KCStore.saveClip(root, makeInput());
  await KCStore.updateClip(root, { id: saved.id, note: { thought: "改后的想法", tags: "新标签" } });

  const records = await readIndex(root);
  assert.strictEqual(records[0].note.thought, "改后的想法");
  assert.deepStrictEqual(records[0].note.tags, ["新标签"]);

  const notes = await root.getDirectoryHandle("notes", { create: true });
  const md = await (await notes.getFileHandle(saved.relativeFile.split("/")[1])).getFile().then((f) => f.text());
  assert.match(md, /改后的想法/);
});

test("deleteClip removes the only note's md and clears the index", async () => {
  const root = createMemoryDir("KnowledgeClips");
  const saved = await KCStore.saveClip(root, makeInput());
  const result = await KCStore.deleteClip(root, { id: saved.id });

  assert.strictEqual(result.removedFile, true);
  const records = await readIndex(root);
  assert.strictEqual(records.length, 0);

  const notes = await root.getDirectoryHandle("notes", { create: true });
  await assert.rejects(notes.getFileHandle(saved.relativeFile.split("/")[1]), /not found/i);
});

test("deleting one of two notes keeps the article md and rebuilds it", async () => {
  const root = createMemoryDir("KnowledgeClips");
  const first = await KCStore.saveClip(root, makeInput({ selection: { text: "片段一" }, note: { thought: "想法一" } }));
  await KCStore.saveClip(root, makeInput({ selection: { text: "片段二" }, note: { thought: "想法二" } }));
  await KCStore.deleteClip(root, { id: first.id });

  const records = await readIndex(root);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].note.thought, "想法二");

  const notes = await root.getDirectoryHandle("notes", { create: true });
  const md = await (await notes.getFileHandle(first.relativeFile.split("/")[1])).getFile().then((f) => f.text());
  assert.doesNotMatch(md, /想法一/);
  assert.match(md, /想法二/);
});
