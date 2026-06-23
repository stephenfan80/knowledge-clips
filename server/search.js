const path = require("node:path");
const { DEFAULT_LIBRARY_DIR, expandHome, loadClips } = require("./store");

function tokenize(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[\s,，。.!?？、#]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function searchableText(clip) {
  return [
    clip.source && clip.source.title,
    clip.source && clip.source.site,
    clip.selection && clip.selection.text,
    clip.selection && clip.selection.beforeContext,
    clip.selection && clip.selection.afterContext,
    clip.note && clip.note.thought,
    clip.note && clip.note.topic,
    clip.note && Array.isArray(clip.note.tags) && clip.note.tags.join(" ")
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function scoreClip(clip, tokens) {
  const text = searchableText(clip);
  return tokens.reduce((score, token) => {
    if (!text.includes(token)) return score;
    const inThought = String((clip.note && clip.note.thought) || "").toLowerCase().includes(token);
    const inSelection = String((clip.selection && clip.selection.text) || "").toLowerCase().includes(token);
    return score + 1 + (inThought ? 2 : 0) + (inSelection ? 1 : 0);
  }, 0);
}

function searchClips(query, options = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  const libraryDir = path.resolve(expandHome(options.libraryDir || process.env.KNOWLEDGE_CLIPS_DIR || DEFAULT_LIBRARY_DIR));
  return loadClips(libraryDir)
    .map((clip) => ({ clip, score: scoreClip(clip, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit || 8);
}

function recentClips(options = {}) {
  const libraryDir = path.resolve(expandHome(options.libraryDir || process.env.KNOWLEDGE_CLIPS_DIR || DEFAULT_LIBRARY_DIR));
  return loadClips(libraryDir)
    .slice()
    .reverse()
    .slice(0, options.limit || 20);
}

function formatContext(results, query) {
  if (!results.length) {
    return `# AI 调用上下文\n\n问题: ${query}\n\n未找到相关摘录。\n`;
  }

  const body = results
    .map(({ clip, score }, index) => {
      return `## ${index + 1}. ${clip.source.title}\n\n- 匹配分: ${score}\n- 来源: ${clip.source.url}\n- 文件: ${
        clip.file
      }\n- 标签: ${(clip.note.tags || []).join(", ") || "未标注"}\n\n### 原文依据\n\n> ${clip.selection.text.replace(
        /\n/g,
        "\n> "
      )}\n\n### 我的想法\n\n${clip.note.thought}\n`;
    })
    .join("\n");

  return `# AI 调用上下文\n\n问题: ${query}\n\n${body}`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const query = args.join(" ").trim();

  if (!query) {
    console.log("用法: npm run search -- \"你的问题或关键词\"");
    process.exit(0);
  }

  console.log(formatContext(searchClips(query), query));
}

module.exports = {
  formatContext,
  recentClips,
  searchClips,
  tokenize
};
