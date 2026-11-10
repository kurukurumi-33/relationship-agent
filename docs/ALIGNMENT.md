# 与推荐博主的架构对照

对照对象：博主文档《整套 Relationship Agent 架构梳理》（面试口述版）。
结论：**边界设计基本一致，他多出两块真正关键的东西——独立 Insight Agent 和可恢复问卷；我们多出两处他文档里没提但必须有的东西——toolCall/toolResult 配对修复、跨人校验。**

下面按他文档的七个模块逐条对照，并说明哪些照做、哪些没照做、为什么。

---

## 1. 主 Agent 一轮请求流程

| 他的设计 | 我们原来的状态 | 现在 |
|---|---|---|
| 输入含 `threadID` / `requestID` / `PageContext` | 只有 goal + personId | ✅ 已补 `requestId`（请求级幂等）与 `pageContext` |
| 同一 `requestID` 防重复提交 | 只有行动卡级幂等 | ✅ 重复 requestID 直接回放上次会话，不再调模型（审计 A11） |
| 先存证据再推理，分配 `evidenceID` | 有 Evidence + sourceIds | ✅ 补了内容哈希去重（`importEvidence`） |
| 截图 24h 失效，长期只留摘要 | 证据永久可见 | ✅ 补 `expiresAt` / `summary`，过期后正文不再进快照 |
| 快照含时间、时区、事实冲突、关系目标 | 只有记忆/证据/未完成行动 | ✅ 补 `now` / `timezone` / `relationshipGoal` / `conflicts` |

**快照字段增加的代价**：系统提示词更长。我们仍然只放证据索引（120 字预览），正文靠 `get_evidence_text` 按需拉，所以增长是常数级而不是随证据条数线性增长。

## 2. 工具权限与运行预算

| 他的设计 | 我们 | 现在 |
|---|---|---|
| 只读 / 提案 / 写入三类分开 | 只读 + 追问 + 提案，**没有写入工具** | 一致（比他更严：工具集里根本没有写接口） |
| 单轮工具次数 | 只有总次数 | ✅ 补 `maxToolCallsPerTurn` |
| 模型轮次 | 有 | 一致 |
| 总超时 | 有 | 一致 |
| 连续失败 N 次停止 | 没有 | ✅ 补 `maxConsecutiveToolFailures` |
| 用 `shouldStopAfterTurn` | — | ⚠️ **Agent 类没暴露这个钩子**，只有低层 `agentLoop` 有。用 `afterToolCall` + `abort()` 做等价实现，行为一致 |

## 3. Questionnaire：可恢复暂停点

| 他的设计 | 我们原来的状态 | 现在 |
|---|---|---|
| 1~4 个问题、单选/输入 | 最多 3 个问题，带选项 | 一致 |
| 问题、答案持久化 | ❌ 完全不持久化 | ✅ `SurveyRecord`（含 `toolCallId`） |
| 中断后恢复这一轮 | ❌ 进程挂了答案就没了 | ✅ 恢复时把答案**注入回原来那条 toolCall 的 toolResult** |
| 答案不进长期记忆 | 本来就满足（只走候选→审核→写入） | 一致 |

恢复的关键实现是 `injectSurveyResults`：如果直接交给配对修复，那条 `ask_user` 会被补成"中断、没有结果"的错误结果，这一轮追问就白问了。先注入真实答案，配对修复才有东西可配。

## 4. ActionCard：提案与执行的边界

| 他的设计 | 我们 | 说明 |
|---|---|---|
| proposed → 确认 → 执行 → 回执 | 一致 | — |
| 失败分"冲突类可重试" | 原来一律不重试 | ✅ 补 `retryable` + `maxAttempts` |
| 回执分 partial / 成功 / 失败 | 只有 ok / failed | ✅ 补 `partial` |
| 成功 = `confirmed`，失败 = `failed` | 我们是 `executed` / `failed` | ❌ **刻意不改**（见下） |
| 回执后触发 Insight | ❌ 原来没有 Insight | ✅ 已接 |

### 为什么状态名不改

他的状态机是 `proposed → confirmed / failed`，其中 `confirmed` 指"设备执行成功"。
我们把"用户确认"和"执行成功"拆成 `confirmed` 和 `executed`。

如果照抄，会把三个不同的卡点合并：**用户点了确认但没提交**、**提交了但设备没回执**、**设备执行成功**。
线上出问题时，这三种情况的处置完全不同（重新提交 / 查设备 / 查下游），合并后就查不出卡在哪。
所以保留 6 态，映射关系写在这里：

| 他的说法 | 我们的状态 |
|---|---|
| proposed | `proposed` |
| 用户确认通过 | `confirmed` |
| 已下发设备 | `submitted` |
| 执行成功（他的 confirmed） | `executed` |
| 执行失败 | `failed` |

## 5. 会话上下文与压缩

| 他的设计 | 我们原来的状态 | 现在 |
|---|---|---|
| 会话记忆与长期记忆分开 | 分开（transcript vs MemoryDoc） | 一致 |
| Pi 原生 compaction | ❌ 写了 `makeContextPruner` 但**没接进 Agent** | ✅ 已接 `transformContext` |
| 原文仍持久化，摘要喂模型 | 只保留最近 N 条 | ⚠️ 目前是**结构化裁剪**（保留首条 + 最近 N 条），没有生成摘要 |
| 压缩更新用 generation CAS | 没有 | ✅ `recordCompaction` 带 CAS |

**未做的部分说清楚**：真正的 LLM 摘要把旧消息压成一段话，会在 `transformContext` 里多一次模型调用，
成本和时序都要单独设计（尤其会影响 faux 测试的响应队列）。现在只做了"裁剪 + 记账"，
摘要字段 `CompactionRecord.summary` 已预留。

另外补了一个自查发现的问题：原来 `saveSession` 只在跑完后调一次，**跑到一半崩溃整段会话都不落盘**，
所谓"断点恢复"只对"跑完之后"成立。现在每条 `message_end` 都落一次。

## 6. Insight Agent（独立）

| 他的设计 | 我们原来的状态 | 现在 |
|---|---|---|
| 独立 Agent，专门审记忆 | ❌ 只有 host 里一个 review 回调 | ✅ `src/agent/insight.ts` |
| 输入证据 + 执行结果 + 会话 | — | ✅ 三者都进 prompt |
| 过滤临时指令、猜测、未证实动机 | — | ✅ 写进系统提示词 + 审计 B4 验证 |
| draft 需用户审核才生效 | 候选本来就要用户审核 | 一致（现在变成两道：洞察 → 用户） |
| baseVersion CAS | 有 generation CAS | 一致 |
| 保留旧版本历史 | ❌ 只存当前文档 | ⚠️ 未做（见下） |

**唯一没对齐的是"保留旧版本历史"**：现在 `MemoryDoc` 只存当前版本，`generation` 递增但旧内容被覆盖。
要做到"可回溯"，需要一张 `memory_doc_versions` 表存每次快照。这是 M2 换数据库时顺手做的事，
在 JSON 存储里做会变成两套真值来源，不划算。

## 7. 三层评测

| 层 | 他的设计 | 我们 |
|---|---|---|
| 第 1 层：接口与状态断言 | 参数、权限、版本、回执、sourceIDs | ✅ `npm run audit`（15 条） |
| 第 2 层：轨迹 Trace 回放 | 完整回放 toolCall → toolResult → action → 回执 | ✅ `npm run trace`（request / session / person 三个视角） |
| 第 3 层：语义评测 LLM Judge | 证据一致性、新增价值、可行性 | ⚠️ 只有**规则 Judge**（核对引用是否存在、有没有谎称执行）+ `createLlmJudge` 接口占位 |

规则 Judge 不能替代语义评测，它的分数也不能当"回答质量"讲。这一点在 `src/eval/judge.ts` 里写死了。

---

## 我们保留的、他文档里没有的东西

1. **toolCall / toolResult 配对修复**（`session/resume.ts`）
   他提到"断点恢复"，但没说恢复时怎么处理残缺上下文。进程在"工具已发起、结果未落盘"时崩掉，
   直接喂给模型会 400。我们补错误结果、丢孤儿结果。
2. **sourceIds 跨人校验**
   他提"证据绑定"，没说跨联系人的情况。我们做成了硬校验：证据属于别人一律拒绝（审计 A1/A2）。
3. **重复调用拦截**
   同名同参调用 3 次直接拦下，这是比"轮次上限"更早生效的一道闸。

---

## 还没对齐的（按优先级）

| 项 | 影响 | 计划 |
|---|---|---|
| 记忆旧版本历史 | "保留旧版本"讲不全 | M2 换库时加 `memory_doc_versions` 表 |
| LLM 摘要压缩 | 只有裁剪，没有语义摘要 | M5，需要先解决多一次模型调用的成本问题 |
| LLM Judge | 第 3 层只有规则版 | M6 |
| 真实设备 / 截图入库 | 仍是 mock 和手写文本 | M3 / M4 |
| 请求级幂等的"结果存储" | 重放只能回放最后一条回答，不是完整 RunResult | 需要 `session_results` 表，M2 一起做 |