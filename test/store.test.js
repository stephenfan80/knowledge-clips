const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { exportAgentContext } = require("../server/export-agent-context");
const { searchClips } = require("../server/search");
const { deleteClip, loadClips, normalizeClip, safeBasename, saveClip, updateClip } = require("../server/store");

function tempLibrary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-clips-"));
}

function sampleClip(overrides = {}) {
  return {
    source: {
      title: "一篇关于 AI 产品的文章",
      url: "https://example.com/article?id=1",
      canonicalUrl: "https://example.com/article",
      site: "example.com",
      capturedAt: "2026-06-22T08:00:00.000Z"
    },
    selection: {
      text: "好的认知库不是收藏更多内容，而是保留可复用的判断。",
      beforeContext: "文章前文",
      afterContext: "文章后文"
    },
    note: {
      thought: "这能约束产品第一版：必须让用户写自己的判断。",
      tags: "AI 产品, 认知库"
    },
    ...overrides
  };
}

test("safeBasename keeps readable names and removes filesystem separators", () => {
  assert.equal(safeBasename("AI/产品: 认知库?"), "AI-产品-认知库");
});

test("normalizeClip requires selected text and user thought", () => {
  assert.throws(() => normalizeClip(sampleClip({ note: { thought: "" } })), /missing_thought/);
  assert.throws(() => normalizeClip(sampleClip({ selection: { text: "" } })), /missing_selection_text/);
});

test("saveClip appends repeated captures from one article into one markdown file", () => {
  const libraryDir = tempLibrary();
  const first = saveClip(sampleClip(), { libraryDir });
  const second = saveClip(sampleClip({ note: { thought: "第二次看到时，我更关心后续 AI 调用质量。", tags: "AI 产品" } }), {
    libraryDir
  });

  assert.equal(first.relativeFile, second.relativeFile);
  assert.equal(second.duplicate, true);
  assert.equal(loadClips(libraryDir).length, 2);

  const markdown = fs.readFileSync(first.file, "utf8");
  assert.match(markdown, /### 原文片段/);
  assert.match(markdown, /### 我的想法/);
  assert.match(markdown, /重复片段:/);
});

test("saveClip preserves paragraph breaks in selected original text", () => {
  const libraryDir = tempLibrary();
  const selectedText = "第一段原文判断。\n\n第二段继续展开。\n第三行保留在同一段逻辑里。";
  const saved = saveClip(sampleClip({ selection: { text: selectedText, beforeContext: "", afterContext: "" } }), {
    libraryDir
  });

  const clips = loadClips(libraryDir);
  assert.equal(clips[0].selection.text, selectedText);

  const markdown = fs.readFileSync(saved.file, "utf8");
  assert.match(markdown, /> 第一段原文判断。\n> \n> 第二段继续展开。\n> 第三行保留在同一段逻辑里。/);
});

test("searchClips returns AI-context candidates from index records", () => {
  const libraryDir = tempLibrary();
  saveClip(sampleClip(), { libraryDir });

  const results = searchClips("认知库 判断", { libraryDir });
  assert.equal(results.length, 1);
  assert.equal(results[0].clip.source.url, "https://example.com/article?id=1");
  assert.deepEqual(results[0].clip.note.tags, ["AI 产品", "认知库"]);
});

test("exportAgentContext writes a portable markdown file for external agents", () => {
  const libraryDir = tempLibrary();
  saveClip(sampleClip(), { libraryDir });

  const result = exportAgentContext("认知库", { libraryDir });
  assert.equal(path.basename(result.outputPath), "agent-context.md");
  assert.match(fs.readFileSync(result.outputPath, "utf8"), /# AI 调用上下文/);
  assert.match(result.context, /原文依据/);
});

test("updateClip rewrites index and markdown for edited thought and tags", () => {
  const libraryDir = tempLibrary();
  const saved = saveClip(sampleClip(), { libraryDir });

  updateClip(
    {
      id: saved.id,
      note: {
        thought: "更新后的启发：先让保存和复用闭环，再做复杂 AI。",
        tags: "产品体验, Agent"
      }
    },
    { libraryDir }
  );

  const clips = loadClips(libraryDir);
  assert.equal(clips[0].note.thought, "更新后的启发：先让保存和复用闭环，再做复杂 AI。");
  assert.deepEqual(clips[0].note.tags, ["产品体验", "Agent"]);

  const markdown = fs.readFileSync(path.join(libraryDir, saved.relativeFile), "utf8");
  assert.match(markdown, /更新后的启发/);
  assert.match(markdown, /#产品体验 #Agent/);
});

test("deleteClip removes one note and rebuilds the article markdown", () => {
  const libraryDir = tempLibrary();
  const first = saveClip(sampleClip({ note: { thought: "保留这一条。", tags: "保留" } }), { libraryDir });
  const second = saveClip(
    sampleClip({
      selection: {
        text: "这是一条准备删除的片段。",
        beforeContext: "",
        afterContext: ""
      },
      note: {
        thought: "删除这一条。",
        tags: "删除"
      }
    }),
    { libraryDir }
  );

  deleteClip({ id: second.id }, { libraryDir });

  const clips = loadClips(libraryDir);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].id, first.id);

  const markdown = fs.readFileSync(path.join(libraryDir, first.relativeFile), "utf8");
  assert.match(markdown, /保留这一条/);
  assert.doesNotMatch(markdown, /这是一条准备删除的片段/);
});

test("deleteClip removes the markdown file when deleting the last note from an article", () => {
  const libraryDir = tempLibrary();
  const saved = saveClip(sampleClip(), { libraryDir });
  const filePath = path.join(libraryDir, saved.relativeFile);

  deleteClip({ id: saved.id }, { libraryDir });

  assert.deepEqual(loadClips(libraryDir), []);
  assert.equal(fs.existsSync(filePath), false);
});
