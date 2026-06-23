// 生成/刷新一行流索引 index/cards.index.md（npm run index）。
// 给已有库（含 iCloud 里的老卡）一次性建索引；新卡由扩展自动维护。
// 用 KNOWLEDGE_CLIPS_DIR 指向你的知识库文件夹，默认 ~/KnowledgeClips。

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_LIBRARY_DIR, expandHome, loadClips } = require("./store");
const { buildCardIndex } = require("../extension/clip-format");

function main() {
  const libraryDir = path.resolve(expandHome(process.env.KNOWLEDGE_CLIPS_DIR || DEFAULT_LIBRARY_DIR));
  const clips = loadClips(libraryDir);
  const outputPath = path.join(libraryDir, "index", "cards.index.md");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildCardIndex(clips));

  console.log(`已生成索引：${outputPath}（共 ${clips.length} 条）`);
}

main();
