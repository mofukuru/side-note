# SideNote（中文说明）

> 本项目是 [mofukuru/side-note](https://github.com/mofukuru/side-note) 的 Fork，遵循上游 MIT 许可，保留原作者版权声明。
> 本文件只说明**本 Fork 相对上游增加了什么**；上游的完整功能与用法请阅读 [README.md](./README.md)（英文）与 [README-ja.md](./README-ja.md)（日文）。

## 一、这个 Fork 解决什么问题

上游的评论与笔记之间只靠一个字段关联：`Comment.filePath`。它只在 Obsidian 自己的 `rename` 事件里被更新。

当你用 **PowerShell、Python、Git、脚本或 AI Agent** 直接移动/重命名文件时，Obsidian 收不到 `rename` 事件，于是：

- 评论仍然存在，仍然显示在 All Notes 里，看起来一切正常；
- 但它指向的路径已经不存在，点击时只会得到 `Failed to jump to Markdown view.`；
- `isOrphaned` 也不会被置位（那个标记是"引用的文字被删了"，不是"笔记不见了"）；
- 没有任何提示、日志或警告。

本 Fork 在保留上游全部功能的前提下，补上了**检测、恢复、保护**三件事。

## 二、新增能力

### 1. 失联检测（只读）

| 触发时机 | 说明 |
|---|---|
| 启动后约 10 秒 | 等 vault 索引就绪后扫描一次 |
| 每 3 分钟 | 兜底扫描，覆盖"Obsidian 关闭期间被移动"的情况 |
| 文件事件 | `rename` / `delete` / `create` 触发一次防抖扫描，作为加速 |

判定时**以磁盘为准**（`adapter.exists`），而不是 Obsidian 的内存索引——索引可能因监听漏报而过期。

### 2. 自动恢复（零点击）

新建评论时会记录笔记内容的 **SHA-256 指纹**与**字节长度**。之后即使文件被改名或移动，只要能按内容唯一匹配上，就自动把评论接回去，通常在 **2–5 秒**内完成。

### 3. 人工修复（有歧义时）

无法自动判断时不会瞎猜，而是给出一个修复面板：

- 列出候选笔记及其依据（内容哈希 / 原文命中 / 同名 / 无候选）；
- **点一下候选即完成修复**；
- 找不到候选时可 `Choose note…` 从全库手动选择；
- 也可选择 `Ignore` 或 `Delete comments`（删除前二次确认）。

### 4. 锚点恢复（P1）

评论还会记录选区前后各 **32 个字符**的上下文。笔记正文被编辑后：

| 情况 | 行为 |
|---|---|
| 段落被移动到很远的位置 | 仍能找到（不受 ±10 行限制） |
| 空格/换行被改动 | 宽松匹配找到，并在侧栏标 `Moved?` 提醒复核 |
| 原文被整句删除 | 标记为孤儿，不猜位置 |
| 同一句话出现多次 | 用上下文判断；判不了就按低置信处理 |

### 5. 数据安全

- 每次写入前自动备份 `data.json`（保留最近 5 份，自动轮转）；
- 写入后**回读 `data.json` 校验**，失败会明确报错，不会假报成功；
- 每次修复写入 `link-repair.log`（JSONL，一行一条：时间、旧路径、新路径、依据、评论 id、备份文件名）；
- 只改 `filePath` / `commentPath`，**绝不修改**评论 id、正文、选区文字与锚点字段；
- 修复操作幂等：重复扫描不会重复写盘。

## 三、怎么用

### 命令

| 命令 | 作用 |
|---|---|
| `SideNote: Scan for unattached comments` | 只扫描并提示结果，不改数据 |
| `SideNote: Scan and repair comment links` | 扫描后打开修复面板 |

### 设置项（设置 → SideNote）

| 设置 | 默认 | 说明 |
|---|---|---|
| `Unattached comments` | — | 显示失联评论数量、上次扫描时间，附 `Rescan` 与 `Review and repair…` 按钮 |
| `Re-link comments automatically` | 开 | 内容/原文唯一命中时自动修复 |
| `Re-link after a rename too` | 开 | 连"文件名也变了"的情况也自动修复；多设备共享 vault 时可关闭 |

### 界面提示

- 侧栏中失联评论带红色左边框与 `Note not found` 角标；
- 锚点被宽松匹配到的评论带 `Moved?` 角标。

## 四、数据变化（向后兼容）

新增字段全部**可选**，旧版 `data.json` 直接可用，旧版插件读到也会忽略：

| 字段 | 含义 |
|---|---|
| `fileHashAtAttach` | 创建/重挂时笔记内容的 SHA-256 |
| `fileSizeAtAttach` | 同上时刻的字节长度（用于快速预筛） |
| `prefix` / `suffix` | 选区前后各最多 32 字符的上下文 |
| `anchorNeedsReview` | 锚点是宽松匹配得到的，建议人工复核 |

插件目录新增文件：`link-repair.log`（审计）、`build-marker.json`（记录当前加载的构建哈希，便于排查）、`data.v1-backup-<时间戳>.json`（备份，自动保留 5 份）。

## 五、已知限制

- **旧评论无法自动修复**：功能上线之前创建的评论没有内容指纹，只能人工确认或删除。
- **笔记被删除**（不是移动）：没有任何线索可循，只能由人决定重挂或删除。
- **正文被大幅改写**：当原文与上下文都不复存在时，只能标记为孤儿。
- **多设备同时运行**（如 Syncthing）：两个设备可能各自修复一次，属 P2 范畴，尚未处理。
- **仅桌面端**：与上游一致。

## 六、与上游的差异一览

| 维度 | 上游 1.3.1 | 本 Fork |
|---|---|---|
| 外部移动/改名 | 静默失联 | 自动恢复或明确标出 |
| 关闭 Obsidian 期间的移动 | 无感知 | 重开后由启动扫描恢复 |
| 正文被编辑后的定位 | 仅 ±10 行内按哈希搜索 | 全文上下文匹配 + 置信分级 |
| 失败可见性 | 只有点击时才报错 | 计数 + 角标 + 命令 + 面板 |
| 数据安全 | 仅 `data.json` | 备份 + 审计 + 写后回读校验 |

## 七、设计文档

- [评论路径恢复](./docs/design-comment-link-recovery.md)（英文）
- [锚点恢复](./docs/design-anchor-recovery.md)（英文）

## 八、构建

```bash
npm ci
npm run build      # 类型检查 + 打包，产物为 main.js
npm test           # 单元测试
```

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<vault>/.obsidian/plugins/side-note/` 即可安装。

## 九、许可与归属

- 基于 [mofukuru/side-note](https://github.com/mofukuru/side-note)，MIT License，见 [LICENSE](./LICENSE)；
- 原作者版权声明保留，未做任何移除；
- 本 Fork 的功能改动以本文件与 `docs/` 下的设计文档为准，不代表上游官方版本。
