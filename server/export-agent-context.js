const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_LIBRARY_DIR, expandHome } = require("./store");
const { formatContext, recentClips, searchClips } = require("./search");

function buildContext(query, options = {}) {
  const results = query
    ? searchClips(query, options)
    : recentClips(options).map((clip) => ({ clip, score: "recent" }));

  return formatContext(results, query || "最近保存的摘录");
}

function exportAgentContext(query, options = {}) {
  const libraryDir = path.resolve(expandHome(options.libraryDir || process.env.KNOWLEDGE_CLIPS_DIR || DEFAULT_LIBRARY_DIR));
  const outputPath = path.join(libraryDir, "exports", "agent-context.md");
  const context = buildContext(query, { ...options, libraryDir });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, context);

  return {
    outputPath,
    context
  };
}

if (require.main === module) {
  const query = process.argv.slice(2).join(" ").trim();
  const result = exportAgentContext(query);

  console.log(`已导出: ${result.outputPath}`);
  console.log("把这个文件作为素材交给 Codex、Claude Code、Kimi Agent、WorkBuddy 等 agent 即可。");
}

module.exports = {
  buildContext,
  exportAgentContext
};
