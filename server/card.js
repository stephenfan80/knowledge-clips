// 按 id 取一张完整卡片（npm run card -- <id>）。
// 供 agent 渐进式披露：先读索引挑出 id，再用本命令只取相关卡，避免整库读取。
// 用 KNOWLEDGE_CLIPS_DIR 指向你的知识库文件夹，默认 ~/KnowledgeClips。

const path = require("node:path");
const { DEFAULT_LIBRARY_DIR, expandHome, loadClips, clipMarkdown } = require("./store");

function main() {
  const id = process.argv.slice(2).join(" ").trim();
  if (!id) {
    console.log('用法: KNOWLEDGE_CLIPS_DIR=<目录> npm run card -- "<id>"');
    process.exit(0);
  }

  const libraryDir = path.resolve(expandHome(process.env.KNOWLEDGE_CLIPS_DIR || DEFAULT_LIBRARY_DIR));
  const clip = loadClips(libraryDir).find((item) => item.id === id);

  if (!clip) {
    console.error(`未找到 id=${id}`);
    process.exit(1);
  }

  console.log(`# ${clip.source.title}`);
  console.log(`来源: ${clip.source.url}`);
  console.log(`文件: ${clip.file || ""}`);
  console.log("");
  console.log(clipMarkdown(clip, clip.duplicateOf));
}

main();
