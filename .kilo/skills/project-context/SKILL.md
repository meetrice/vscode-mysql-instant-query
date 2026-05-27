---
name: project-context
description: 使用项目结构摘要快速定位文件，避免全量扫描。适用于需要了解项目架构、定位代码文件的场景。
---
# Project Context Skill

## 用法
当收到需求时，执行：
1. 读取 `.kilo/project-structure.md` 定位目标文件
2. 直接读取目标文件，而非全项目搜索
3. 如果找不到相关模块，再执行全项目搜索
4. 搜索到新模块后，建议补充到 `.kilo/project-structure.md`
