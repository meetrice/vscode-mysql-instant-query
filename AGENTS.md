# 项目上下文精确索引规则

## 核心规则：先查结构摘要，再搜代码

当收到任何开发需求时，必须按以下优先级执行：

### Step 1 — 读取项目结构摘要
- 立即读取 `.kilo/project-structure.md`
- 根据摘要中的「常见修改场景」表定位目标文件
- 使用 `read` 工具直接读取定位到的文件

### Step 2 — 按需探索
- 如果 Step 1 定位到的文件不足以完成任务，**只搜索相关目录**（通过 glob 限定路径范围）
- 禁止全局 grep/glob（除非 Step 3 触发）

### Step 3 — 最终兜底
- 只在 `.kilo/project-structure.md` 中**完全找不到相关模块**时，才发起全项目代码搜索
- 完成搜索后，建议将新发现的模块路径补充到 `.kilo/project-structure.md` 中

## 例外
- README.md、package.json、tsconfig.json 等根级配置可直接读取，无需先查摘要
