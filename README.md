# Redaction Review Studio

地址/姓名脱敏审阅工作台。范围集合在服务端基于**固定文档 revision** 规范化，
最终替换采用**流式切片**，绝不复用已变化坐标。

## 坐标约定

- 所有 `start/end` 均为 Unicode **码元（code point）偏移**，半开区间 `[start, end)`；
  emoji / 代理对 / ZWJ 序列按码元计数，不会被拆散。
- 前端从 textarea 选区（UTF-16 下标）添加范围时用 `fromUtf16Offset` 换算。

## 范围关系处理（`src/server/redaction.ts`）

| 关系 | 处理 |
| --- | --- |
| 完全包含 | **外层策略主导**，内层范围仅保留在 `contained` 审计引用中，不产生独立替换 |
| 部分相交且策略冲突 | 产生 `conflict`（kind=`overlap`），**必须用户解决**，服务端不猜测、不预览 |
| 同跨度不同策略 | 产生 `conflict`（kind=`identical`），同样必须解决 |
| 冲突联合被非冲突外层完全吞下 | 外层策略主导（确定性规则），冲突成员降级为审计引用 |
| 相邻（`end === 下一 start`）且策略相同 | 合并为一个规范范围（`mergedAdjacent`） |
| 相邻但策略不同（含 label 文本不同） | **保留两个独立范围**，不丢策略 |
| 零长度建议 | 忽略并在 `ignored` 中回报（`reason: zero_length`） |

冲突解决后前端**重新计算整个规范集合**；请求带单调序号，旧响应直接丢弃，
旧预览不会覆盖新决策。

## 安全替换

`applyPlan` 从左到右按原文坐标流式切片：未改动间隙与替换片段各读一次原文，
替换结果不再被当作坐标索引（等价于从后向前替换），从根本上消除
“先处理内层、再用旧偏移处理外层导致外层尾部泄露”。

输出前守卫：

- 已接受的内层原文不得出现在覆盖它的替换片段中（`leaks`，仅按所属片段检查，
  不会误伤文档其他位置出现的相同文字）；
- 与原文恒等的 label 标记为 `ineffective`，apply 接口返回 422——
  **最终输出不得包含任何已接受范围的原文**。

## API

- `GET /api/documents/:id/suggestions` — 固定 revision 上的初始建议（码元坐标）
- `POST /api/documents/:id/redaction/plan` — `{revision, ranges, resolutions}` →
  规范集合、冲突、忽略项与预览；revision 不匹配返回 409
- `POST /api/documents/:id/redaction/apply` — 冲突未解决返回 422；
  服务端重新流式替换并校验，不信任任何客户端预览；`persist:true` 时落库并推进 revision

## 开发

- `npm run dev` — 服务端 (4174) + Vite (4173)
- `npm test` — 32 个测试（核心规则 + API 集成）
- `npm run build` — 类型检查 + 构建
