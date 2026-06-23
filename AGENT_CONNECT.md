# Agent 对接说明

Knowledge Clips 不在插件里内置 AI。它把你的原文摘录和个人想法保存成稳定的本地素材库，再交给你常用的 agent 二次创作。

## 推荐路径（渐进式披露，避免撑爆上下文）

知识库可能有几百上千张卡，**不要让 agent 整库读取**。把下面这段提示复制给 Codex、Claude Code、Kimi Agent、WorkBuddy 或其他 agent：

```text
你是我的个人知识库协作助手。我的知识保存在一个本地文件夹。
它的绝对路径：【在这里粘贴你的完整路径】——如果我没填，先问我要，别猜。

文件夹结构：
- index/cards.index.md —— 一行一卡的目录：日期 · 标签 · 我的想法 · 原文摘要 · id · 文件路径
- notes/*.md —— 每张卡的完整内容
- index/clips.jsonl —— 全量机器索引（不要整份读进对话）

读取规则（务必遵守，避免一次性塞爆上下文）：
1. 先只读 index/cards.index.md（或对它 grep 关键词），按「我的想法 / 标签」判断哪些卡相关。
2. 只对相关的卡，去读它那一行末尾的 notes/<文件> 取完整内容。
3. 绝不要整库读取 notes/ 目录或 index/clips.jsonl。
4. 若 index/cards.index.md 不存在，提醒我先生成（扩展里保存任意一条即可，或在 knowledge-clips 仓库跑 npm run index）。

可选快捷方式（仅当你能跑命令、且在 knowledge-clips 仓库目录时；路径含空格/中文务必加引号）：
- 主题检索： KNOWLEDGE_CLIPS_DIR="<绝对路径>" npm run search -- "关键词"
- 取单卡：   KNOWLEDGE_CLIPS_DIR="<绝对路径>" npm run card -- "<id>"

输出约束：严格区分「原文依据」(我划的原文) 和「我的想法」(我的判断)，别把你的总结当成原文；二次创作要标注来源链接或 notes 文件名；证据不足就直说，不要编造。
```

## 为什么这样读

- `index/cards.index.md` 是一行一卡的**轻量目录**，每行约几十 token，agent 扫它/grep 它来判断"哪些卡相关、要不要展开"，不必把全文塞进上下文。
- 扩展每次保存/编辑/删除都会自动刷新这个索引；首次给已有库建索引：`KNOWLEDGE_CLIPS_DIR=<目录> npm run index`。

## 给本地开发型 Agent

Codex、Claude Code 这类能读文件/跑命令的 agent，典型流程：

```bash
cd path/to/knowledge-clips
export KNOWLEDGE_CLIPS_DIR="<你的知识库文件夹>"   # 扩展里选的那个目录

grep "关键词" "$KNOWLEDGE_CLIPS_DIR/index/cards.index.md"   # 1) 在目录里筛
npm run card -- "<命中的 id>"                                # 2) 只取相关卡
npm run search -- "主题关键词"                               # 或按主题检索
```

也可以导出一个便于上传/读取的精简上下文文件（只含原文依据 + 我的想法）：

```bash
npm run export:agent -- "你的主题关键词"
```

导出文件位置：

```text
<你的知识库文件夹>/exports/agent-context.md
```

## 给上传文件型 Agent

Kimi Agent、WorkBuddy 或其他需要上传素材的 agent，可以上传：

```text
~/KnowledgeClips/exports/agent-context.md
```

如果需要完整库，再上传：

```text
~/KnowledgeClips/index/clips.jsonl
~/KnowledgeClips/notes/
```

## 输出质量约束

- 原文片段只能作为引用依据，不要被改写成“我的观点”。
- “我的想法”是二次创作的核心，要优先调用。
- 每次生成文章、方案、复盘或观点稿时，至少保留来源链接或本地文件名。
- 如果素材不足，要明确说“当前知识库证据不足”，不要补写不存在的依据。
