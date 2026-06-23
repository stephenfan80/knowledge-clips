const test = require("node:test");
const assert = require("node:assert");

const KCFormat = require("../extension/clip-format");
const store = require("../server/store");

// 固定 clip，用于逐字对比两套格式逻辑（无哈希、无随机）。
const fixedClip = {
  id: "20260622143000-deadbeef",
  source: {
    title: '为什么 Agent 的护城河是数据"而非"模型',
    url: "https://example.com/a?b=1",
    canonicalUrl: "https://example.com/a",
    site: "example.com",
    capturedAt: "2026-06-22T14:30:00.000Z"
  },
  selection: {
    text: "第一段\n第二段",
    beforeContext: "前文",
    afterContext: "后文"
  },
  note: {
    thought: "我的判断：工具化是壁垒。",
    tags: ["AI 产品", "方法论"],
    topic: ""
  },
  meta: { articleKey: "abc123", contentHash: "def456", appVersion: "0.1.0" }
};

test("clipMarkdown matches server/store.js byte-for-byte", () => {
  assert.strictEqual(KCFormat.clipMarkdown(fixedClip), store.clipMarkdown(fixedClip));
});

test("clipMarkdown with duplicateOf matches server/store.js", () => {
  assert.strictEqual(KCFormat.clipMarkdown(fixedClip, "dup-id"), store.clipMarkdown(fixedClip, "dup-id"));
});

test("articleHeader matches server/store.js byte-for-byte", () => {
  assert.strictEqual(KCFormat.articleHeader(fixedClip), store.articleHeader(fixedClip));
});

test("safeBasename matches server/store.js", () => {
  for (const value of ['为什么 Agent: 数据/模型?', "  ...trim.. ", "a#b\nc", ""]) {
    assert.strictEqual(KCFormat.safeBasename(value), store.safeBasename(value));
  }
});

test("normalizeClip produces same articleKey/contentHash as server/store.js", async () => {
  const input = {
    source: { title: "T", url: "https://x.com/p", canonicalUrl: "https://x.com/p", site: "x.com", capturedAt: "2026-06-22T00:00:00.000Z" },
    selection: { text: "原文片段", beforeContext: "", afterContext: "" },
    note: { thought: "想法", tags: "AI 产品, 方法论" }
  };

  const browser = await KCFormat.normalizeClip(input);
  const node = store.normalizeClip(input);

  assert.strictEqual(browser.meta.articleKey, node.meta.articleKey);
  assert.strictEqual(browser.meta.contentHash, node.meta.contentHash);
  assert.deepStrictEqual(browser.note.tags, node.note.tags);
  assert.deepStrictEqual(browser.source, node.source);
});

test("normalizeClip throws on missing thought (same contract)", async () => {
  await assert.rejects(
    KCFormat.normalizeClip({ source: { url: "https://x.com" }, selection: { text: "t" }, note: {} }),
    /missing_thought/
  );
});

test("clipMarkdown drops the 后续可追问 template and does not duplicate the quote in context", () => {
  const md = KCFormat.clipMarkdown(fixedClip);
  assert.doesNotMatch(md, /后续可追问/);
  // 选中句出现在「原文片段」一次，不应再出现在「上下文」里
  assert.strictEqual((md.match(/第二段/g) || []).length, 1);
  // 上下文用 [……] 标记选中句位置，前后文都在
  assert.match(md, /### 上下文\n\n前文\n\[……\]\n后文\n/);
});

test("clipMarkdown omits the 上下文 section entirely when there is no context", () => {
  const noCtx = { ...fixedClip, selection: { text: "只有正文", beforeContext: "", afterContext: "" } };
  const md = KCFormat.clipMarkdown(noCtx);
  assert.doesNotMatch(md, /### 上下文/);
});

test("cardIndexLine and buildCardIndex produce a one-line, grep-able entry", () => {
  const clip = { ...fixedClip, file: "notes/agent-护城河-abc12345.md" };
  const line = KCFormat.cardIndexLine(clip);
  assert.match(line, /^- 2026-06-22 · #AI 产品 #方法论 · 我的判断：工具化是壁垒。 · 「/);
  assert.match(line, /· 20260622143000-deadbeef · notes\/agent-护城河-abc12345\.md$/);

  const index = KCFormat.buildCardIndex([clip]);
  assert.match(index, /# 知识卡片索引/);
  assert.match(index, /共 1 条/);
  assert.match(index, /20260622143000-deadbeef/);
  assert.match(KCFormat.buildCardIndex([]), /（暂无卡片）/);
});
