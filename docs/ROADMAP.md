# 阶段计划（M2 → M6）

M1 已完成：端到端最小闭环跑通（`npm run demo` / `npm run smoke` / `npm run audit` 全绿）。

> 2026-10-31 更新：按推荐博主的架构做了一轮对齐（见 `docs/ALIGNMENT.md`），
> **M5 的可恢复问卷、M6 的轨迹回放和 Judge 接口已提前落地**；
> M2 仍是地基（换库做真 CAS），M3 证据入库、M4 真实设备未动。

下面每一阶段都写成「目标 → 技术栈 → 作用 → 验收标准」，验收标准是**可执行或可数的**，不是"感觉做完了"。

---

## M2 存储替换：让 CAS 真的成立

**状态：已完成（2026-11-06）** — `node:sqlite`，12 张表，CAS 与幂等由数据库保证。

**目标**：把单文件 JSON 换成数据库，让乐观并发控制从"单进程比较"变成数据库事务。

**技术栈**

| 选择 | 用途 | 为什么 |
|---|---|---|
| SQLite + `better-sqlite3` | 本地开发库 | 零部署，同步 API，适合单机 |
| Drizzle ORM | schema 定义 + 迁移 | TS 原生类型，迁移文件可读 |
| （可选）PostgreSQL + Docker | 生产形态 | 面试可讲"换库只改一层" |

**要改的代码**

- `src/store/store.ts` 拆成 `store/db.ts`（连接）+ `store/repositories/*.ts`（每张表一个）
- `commitMemory` 改成：
  ```sql
  UPDATE memory_doc SET generation = generation + 1, version = version + 1
   WHERE person_id = ? AND generation = ?
  ```
  受影响行数为 0 就是冲突。**这一步是整个项目最有面试价值的一行 SQL。**
- 幂等表加唯一索引 `UNIQUE(request_id)`，插入冲突即视为重复提交

**作用**：现在 `generation CAS` 只在单进程内成立，讲出来会被追问"你怎么保证多实例"。换库后这句话才立得住。

**验收**

1. `npm run demo` 仍然全绿（行为不变）
2. 新增并发用例：两个 `applyCandidate` 同时写同一个 personId，恰好一个成功、一个抛冲突
3. 新增用例：同一个 requestId 插入两次，第二次命中唯一索引而不是产生第二条

**预估**：2~3 天

---

## M3 证据入库：让证据是真的

**状态：已完成（2026-11-11，`RRULE` 展开 2026-11-12 补齐）** ICS 解析、内容哈希去重、`pending_review` 与审核 CLI、截图 OCR（视觉模型）、重复日程展开已落地。

**目标**：现在证据是手写文本。这一阶段把"聊天截图 / 日历"变成入库管线。

**技术栈**

| 选择 | 用途 |
|---|---|
| 多模态模型（qwen-vl / deepseek-vl） | 截图 OCR + 结构化抽取 |
| `ics` 或 `ical.js` | 日历解析 |
| 内容哈希（sha256） | 入库幂等：同一张图重复导入只存一条 |

**要做的**

- `src/ingest/screenshot.ts`：图片 → `{kind:'message', capturedAt, content, sourceRef}`；抽取失败要落"待人工确认"，不能静默丢
- `src/ingest/calendar.ts`：ICS → 多条 Evidence
- Evidence 增加 `contentHash` 字段，入库前查重

**作用**：这是"证据输入"这条链路从假的变真的。也是唯一需要多模态的地方。

**验收**

1. 导入 10 张真实截图（可脱敏），产出 ≥10 条 Evidence，字段完整率 100%
2. 同一张图导入两次，Evidence 数量不变
3. 抽不出的图进入 `pending_review` 状态，不进入快照

**预估**：3~4 天

**已完成（2026-11-11）：确定性部分**

- `src/ingest/calendar.ts`：ICS 解析。处理折行、`\,` `\;` `\\` `\n` 转义、`DTSTART` / `DTEND` / `DURATION`、UTC（`Z`）、`TZID` 本地时间、浮动时间、全天日期。时区换算只依赖 Node 内置 `Intl`：先假设墙钟是 UTC，再按目标时区反算偏移，算两遍收敛，不引第三方库。
- `src/ingest/screenshot.ts`：图片按字节哈希去重，解析器通过 `ScreenshotExtractor` 注入。没配提取器、格式不支持、提取器抛错、提取结果为空，四种情况都落 `pending_review`，原因写进 `summary`。
- `Evidence` 新增 `status`（`active` / `pending_review`）。快照、`search_evidence`、`get_evidence_text` 三处都过滤待确认材料；`listEvidence` 仍然返回全部，供人工审核和审计使用。
- 保留期三个入口一致（2026-11-12 修）：快照只给摘要，`search_evidence` 的片段和 `get_evidence_text` 的正文在过期后也换成摘要。之前只有快照生效，模型换个工具就能拿到全文。
- 保留期改为从入库时间起算（2026-11-12）：按拍摄时间算会让补录的旧截图一入库就过期，OCR 识别出来的正文当场作废。
- SQLite 用 `PRAGMA table_info` 检查后 `ALTER TABLE` 补列，PostgreSQL 用 `ADD COLUMN IF NOT EXISTS`；旧库打开时自动迁移。
- 去重键：日历用 `UID + 原始事件块`，不用解析后的时间，避免解析器时区行为变化造成重复入库；截图用图片字节的 sha256，与文件名和导入时间无关。
- CLI 新增 `--ics` 和 `--image`，都要求 `--person`；重复导入会显示"重复跳过"。
- 新增 `npm run review`：无参数列出待确认材料；`--accept <id> [--content "正文"] [--title "标题"]` 转成 `active`，没有正文时拒绝接受；`--reject <id>` 转成 `rejected`。空正文的截图必须先补 OCR 结果才能接受。接受后按材料类型重新计算保留期（截图 24h、日历 90d），因为确认之前不能把原文清掉。
- smoke 新增第 21 段 29 项，共 142 项，覆盖时区换算、折行、转义、取消事件、解析失败、重复导入、快照/检索/工具三层过滤、截图失败与成功两条路径、人工接受与拒绝。

**截图 OCR（2026-11-11）**

- `src/ingest/ocr.ts`：`createVisionExtractor()` 返回一个 `ScreenshotExtractor`，直接把图片 base64 塞进 `ImageContent` 交给视觉模型。默认走百炼 compatible-mode（`https://dashscope.aliyuncs.com/compatible-mode/v1`），模型 `qwen3-vl-plus`（各账号可见的视觉模型不同，实测有的账号没有 `qwen-vl-max`），可用 `RELATIONSHIP_OCR_MODEL` / `RELATIONSHIP_OCR_BASE_URL` 覆盖。
- key 从 `RELATIONSHIP_OCR_API_KEY` 或 `DASHSCOPE_API_KEY` 读，通过 `completeSimple` 的 `options.apiKey` 传，不改 `process.env`。这样截图 OCR 和主 Agent 可以用两把不同的 key，互不影响。
- 提示词要求只输出 `{ capturedAt, title, content, confidence }`。`parseOcrJson` 容错三种常见偏差：套了 markdown 代码围栏、前后夹解释文字、`capturedAt` 给的不是合法时间（丢掉时间保留正文）。标题截到 80 字，和参数规则层的标题上限对齐。
- 失败一律抛异常，由 `ingestScreenshot` 接住落 `pending_review`，不在这里兜底成空正文。所以缺 key、模型超时、返回非 JSON 三种情况走的是同一条人工确认路径，原因写进 `summary`。
- 超过 10MB 的图片在发请求前就拦掉，避免白付一次上传。
- `scripts/ingest.ts` 新增 `--ocr`，不加就保持旧行为（落待确认）。新增 `npm run ocr-check -- --image <path>` 作为手工验收入口：只调模型不写库，打印耗时、各字段、正文前五行，`--show-raw` 看全文；key 只打印是否存在和长度。
- smoke 新增 3 项（缺 key 的截图落待确认、原因可见、不写正文）和第 22 段 13 项（解析合法/围栏/夹解释/坏时间/超长标题/置信度夹取/空正文/非 JSON/缺 key 报错/超大图拦截），共 158 项。

**重复日程展开（2026-11-12）**

- 支持的规则：`DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`，加 `INTERVAL` / `COUNT` / `UNTIL` / 周规则的 `BYDAY` / 月度和年度规则的 `BYMONTHDAY` / `EXDATE`（可多行、可带 `TZID`）。
- 按墙钟日历推进，不按 24 小时毫秒数加：夏令时切换那天按"每日 9 点"重复才还是 9 点。月度和年度遇到不存在的日期直接跳过，1 月 31 日按月重复时 2 月没有实例，不会滑到 3 月 3 日。
- 周规则带 `BYDAY` 时，一周内按"距 `DTSTART` 的天数"排序，不能按星期几排序：起点是周三、`BYDAY=MO,FR` 时，周五在本周、周一在下一周。
- 展开窗口是现在往后 90 天，单事件最多 120 个实例，两个上限防"每 5 分钟重复"把库撑爆。窗口内的首个实例始终保留，之后的只导入最近一天以远的。
- `COUNT` 在排除 `EXDATE` 之前计数，和 RFC 5545 一致：先生成再排除，被排除的实例仍然占一个名额。
- 不支持的规则（`BYSETPOS` / `BYMONTH` / `BYWEEKNO` / `BYYEARDAY` / `BYHOUR` / `BYMINUTE` / `BYSECOND` / `BYEASTER`、`BYDAY` 的序号写法如 `2TU`）退化成只导入首个实例，原因写进正文，不静默当成普通日程。
- 去重键加实例的墙钟标识（`UID|原始块|20261111T090000`），同一事件的多个实例各自成条；非重复事件仍用原来的键，已经入库的材料不会因为升级而翻倍。
- 起点在多年前的规则会产出几千条历史候选。这些日期一定在窗口外，只用来数 `COUNT`，不做时区换算：一条 2015 年起的每日事件从 681ms 降到 39ms。
- smoke 新增第 21b 段 15 项，共 180 项。

**还没做的**

- OCR 准确率没有标注集。现在只能手工拿几张截图跑 `npm run ocr-check` 看结果，不能报"字段完整率 100%"这种数字。
- `confidence` 目前只打印，没有参与"低于阈值就不收"的判定。要做的话得先有一个标注集确定阈值。
- 复杂的重复规则不展开，只导入首个实例并在正文写明原因。
- 展开结果是入库时算好的快照，不会随日期推移自动往后补新实例；要用得重新导入一次。

---

## M4 真实设备与回执补偿

**状态：进行中** — 文件日历设备已完成（2026-11-12），CalDAV 与 IM 通道未接。

**目标**：`MockDevice` 换成真实通道，并且处理失败。

**技术栈**

- 设备侧：系统日历（ICS 写入）、企业微信/钉钉 webhook、邮件 SMTP（任选两个）
- 重试：指数退避 + 最大次数，**只对没有回执的提交重试**
- 补偿：`ActionCard` 增加 `attempts` / `compensation` 字段

**要改的**

- `runtime/device.ts` 拆成多实现：`CalendarDevice` / `WebhookDevice` / `MockDevice`
- 新增 `runtime/compensate.ts`：回执 failed 时决定"重试 / 撤销 / 转人工"
- 回执要能区分：没送达、送达但被拒、执行成功

**作用**：真实系统里"设备回执"是异步且会失败的。这块做出来，才敢说"支持问题追溯"。

**验收**

1. 注入 30% 失败率跑 50 条，最终成功数 + 明确失败数 = 50，无悬挂状态
2. 同一 requestId 在失败重试后，设备侧只出现一条最终记录
3. 断网中途 kill 进程，重启后能看出哪些卡在 submitted 并继续推进

**预估**：3 天（不含申请 webhook 的等待）

**已完成（2026-11-12）：文件日历设备**

- `src/runtime/ics-file-device.ts`：`execute` 渲染标准 ICS 写到 `data/device-calendar/<requestId>.ics`，`lookup` 查文件是否存在。`UID` 就是 `requestId`，同一个 requestId 重复执行只对应一个文件。
- 写入用临时文件加 `rename`，目录里出现某个 `.ics` 就意味着内容完整，不存在写了一半的状态，`lookup` 不会把半截文件当成执行成功。
- 已存在的文件不覆盖：设备上次执行成功、回执却没落库时会重试，这时直接返回 ok，不破坏用户可能已经改过的日程。
- 失败分两类：`draft_message` 和非法 `at` 属于参数问题，标不可重试；磁盘写不进去标可重试，交给 `Outbox` 的有限重试。查询本身失败必须抛异常，不能返回 `undefined` 冒充"没执行过"。
- **Windows 的坑**：对"普通文件/子项"做 `stat` 返回的是 `ENOENT` 而不是 `ENOTDIR`，照直翻译会把"查询失败"误判成"设备没执行过"，然后安全重发。`lookup` 先检查设备目录本身是不是目录，才能把这两种情况分开。
- 文本按 RFC 5545 转义（`\` `;` `,` 和换行），按字节折行到 75 字节且不切断中文字符。提醒用 `VALARM` 加 `TRIGGER:-PT0M`，导入后日历会弹通知。
- `scripts/execute.ts` / `scripts/reconcile.ts` 支持 `--device ics-file`、`--calendar-dir`，也可以用 `RELATIONSHIP_DEVICE` / `RELATIONSHIP_CALENDAR_DIR`。`Outbox`、执行器、对账一行没改。
- `npm run device-check` 是验收脚本：默认 50 张卡、30% 失败，核对"执行成功 + 明确失败 = 总数"、无悬挂、每张 executed 恰好一个文件、failed 没有文件、文件能被自己的解析器读回且 UID 对得上。`--lost 0.1` 再加一档"设备执行了但回执丢了"。
- smoke 新增第 23 段 20 项，共 200 项。
- 边界：这不是静默写系统日历，只是写出可导入的 `.ics`，用户要手动导入一次。真正的"写入后手机自动同步"要等 CalDAV 版。

---

## M5 异步确认与会话记忆

**状态：异步确认与会话摘要均已完成（2026-11-11）** — 提议、确认、执行拆成三次独立进程；长会话改为摘要 + 原文检索。

**目标**：`await confirm(card)` 是同步阻塞的，真实产品里用户可能十分钟后才点。

**技术栈**

- 待确认队列：数据库表 + 状态机
- 定时任务：`node-cron` 或直接一个轮询循环
- 会话摘要：模型生成 + 结构化存储（不要只存自由文本）

**要做的**

- 提案落库后立刻返回，确认通过 API/CLI 异步到达
- `runSession` 拆成"提议阶段"和"执行阶段"，两者通过 ActionCard 解耦
- 会话压缩从"按条数裁剪"升级为"生成摘要 + 保留原文引用"

**作用**：这是从 demo 到产品的分界线之一。也是"跨会话跟进"真正成立的前提。

**验收**

1. 提案后不确认，进程退出，隔一次启动确认，仍能正确执行
2. 长会话（50 轮）压缩后，早期关键事实仍能被召回（造 10 个探针问题）
3. 同一提案在确认前被修改（换时间），版本号递增且旧确认失效

**预估**：2~3 天

**已完成（2026-11-09）**

- `runSession({ deferConfirm, deferReview })`：会议结束时不碰确认，卡留 `proposed`，候选留 `pending`
- `StorePort.amendAction()`：改提案内容并递增 `cardVersion`，旧版本上的确认自然失效
- `runtime/confirm.ts`：`confirmAction({ requestId, cardVersion, decision })`，版本不符直接拒
- `runtime/executor.ts`：`executeConfirmed()`，扫全库 `confirmed` 卡并提交；并发靠 `cardVersion` CAS
- CLI：`npm run pending` / `npm run confirm` / `npm run execute`，三步可以跨进程、跨天
- 验收 1 和 3 已进 smoke 第 15 段（含"两个执行器抢同一张卡，设备侧只收到一次"）
- 验收 2（会话摘要与召回）由 2026-11-11 的改动加 `npm run probe` 覆盖，见下

**会话摘要与长上下文召回（2026-11-11）**

- 摘要存在已有的 `compaction.summary` 字段里，不新增表。格式是结构化 JSON：
  `{ facts: [{ text, evidenceIds }], openThreads, coveredMessages, generatedAt }`。
  存结构化而不是一段自由文本，是为了将来能按 evidenceId 追回依据。
- `session/summary.ts` 的 `compactMessages` 接管 `transformContext`：超限时保留最早一条用户消息，把中间部分交给模型摘要，保留最近的消息。摘要生成失败就退回"已省略 N 条"的截断说明，对话照常继续。
- 原文不删。pi 的 `transformContext` 只改发给模型的那一份，`context.messages` 仍是全量（`@mariozechner/pi-agent-core` 的 `agent-loop.js` 里能看到）。
- 新工具 `recall_history`：按关键词检索本次会话的完整存档，返回最早命中的原文片段。摘要负责"知道有这回事"，检索负责"把细节说出来"。
- 探针 `npm run probe`：造 50 轮会话，前 10 轮埋 10 条事实，上下文上限压到 20 条，A/B/C 三臂各跑一次真模型。A 只截断，B 截断加检索，C 摘要加检索。A→B 是原文可查的贡献，B→C 是摘要的贡献。结果写 `evals/probe.json`。

```
npm run probe
npm run probe -- --rounds 80 --max-context 16
```

判读和局限写在 `docs/EVAL.md`：每题只跑一次，只能看方向，不能拿单次结果当召回率。

第一次实测是 A 0/10、B 2/10、C 10/10。B 的低分是检索截断造成的，修完重跑：**A 0/10、B 9/10、C 10/10**。代价上 B 用了 14948 tokens、10 次工具调用，C 只用 3180 tokens、0 次工具调用。摘要是一次性付费，检索是按问题付费，所以问题越多检索越贵。B 剩下那一题是词面缺口（问"哪本书"，原文是《人类简史》，没有"书"字），属于子串检索的已知边界。

**同一天修掉的四处实现问题**

1. 重新摘要原来每次都用 `slice(1, cut)`，把整个中段反复摘一遍。改成从 `coveredMessages` 摘到 `cut`，只处理新增掉出的那段，费用随会话长度线性增长的问题消失。
2. 摘要输入有 12k 字符预算，超了会静默截断，但 `coveredMessages` 仍按全覆盖记账。现在 `renderTranscript` 回报实际吃掉的条数，覆盖位置按真实进度推进，剩下的下一次接着摘。
3. `recall_history` 的多关键词查询按最早命中截断，前几个词占满额度。现在按词轮询，每个词至少占一个位置，返回条数随词数放大到上限 8，有未返回的匹配时明确告诉模型。
4. 摘要调用的 tokens 和成本原来不进 `RunResult.usage`。现在单独累计后并入，探针 C 臂的数字包含摘要开销。

smoke 新增第 19 段验证多关键词轮询，共 104 项；typecheck、eval 8/8、audit 15/15 全绿。

**压缩改成滞回式（2026-11-11）**

滑动窗口每轮都把保留窗口往前推一点，摘要之后的前缀每轮都变，prompt cache 基本一直失效。现在改成高水位触发、低水位回落：超过 `maxContextMessages` 才压缩，一次压到它的 60%。两次压缩之间上下文只追加，前缀不动。

30 轮模拟（高水位 20）：滑窗压缩 20 次、稳态 20 条上下文；滞回压缩 4 次、稳态 16 条。代价是每次压缩多丢一截最近对话。smoke 新增第 20 段 7 项断言，覆盖触发点、回落点、窗口视图不被重置、压缩次数和平均长度。

第一次实测抓到一个真 bug：`transformContext` 每轮收到的都是全量消息，触发条件却拿全量长度比高水位，全量只增不减，滞回退化成滑窗。现在窗口起点 `windowStart` 跟着摘要一起落库，触发看的是实际视图长度；没触发时也返回同一个窗口视图，不能把全量放回去。

`npm run cache-probe` 是对应的实测脚本：同一段递增对话分别按滑窗和滞回跑一遍，记录每轮的 `input` / `cacheRead`，输出命中率和成本。每次运行带随机编号、每轮内容唯一，强制冷启动，避免上一次运行的缓存污染结果。

冷启动实测（24 轮）：压缩 14 → 3 次，prompt tokens 28648 → 24456（-14.6%），**未命中 input 20840 → 4616（-77.9%）**，命中率 27.3% → 81.1%，成本 0.0091 → 0.0021 元。成本降幅远大于 token 降幅，因为 DeepSeek 的缓存命中价是输入价的 1/120。

**故障注入压测（2026-11-10）**

`src/runtime/faults.ts` + `scripts/soak.ts`。故障打在设备适配器外面，不改 Outbox，
保证被压的代码路径和线上一致。

四类故障：可重试失败、不可重试失败、部分成功、回执丢失。随机数是固定种子的
mulberry32，同一配置重跑结果完全一致。

```
npm run soak                                   # n=200, seed=42, 默认画像
npm run soak -- --n 500 --seed 7
npm run soak -- --n 200 --no-lookup            # 设备没有幂等查询能力
```

指标：最终一致率 / 悬挂率 / 重复副作用 / 状态误报 / 人工接管。

基线（n=200，ok .7 / 可重试 .1 / 永久 .1 / 部分 .05 / 丢回执 .05）：

| 场景 | 最终一致率 | 悬挂 | 重复副作用 | 状态误报 | 人工接管 |
| --- | --- | --- | --- | --- | --- |
| 设备可查幂等 | 100% (200/200) | 0 | 0 | 0 | 0 |
| 设备不可查（`--no-lookup`） | 96.5% (193/200) | 7 | 0 | 0 | 7 |

第二行不是退步，是契约边界：查不到设备就无从判断是否已执行，只能升级给人。
关键是重复副作用和状态误报都还是 0——宁可交给人，也不猜。

压测过程中修掉的两个真 bug：

1. `Outbox` 把"设备抛异常"直接当成"确定失败"写回执。设备可能已经执行了，
   这条回执会把一张已执行的卡永久钉死。改成先查设备账本：查得到就按回执推进，
   查不到或查证失败就不写回执，把卡留在 `submitted` 等对账。
2. `listStuckActions` 只要幂等表里有这条 `requestId` 就认为"已有结论"。
   重试过的卡会留着上一轮失败的回执，于是刚提交的卡被误判成"有结果"，永远扫不到。
   改成比对 `card_version`：回执记的是提交前版本，action 提交后 +1，
   所以本轮回执必然满足 `receipt.card_version = action.card_version - 1`。

**崩溃恢复压测（2026-11-10）**

`scripts/crash.ts` + `scripts/crash-child.ts`。子进程逐张提交，父进程按随机延迟
`SIGKILL`；重启后跑"对账 → 重发 → 再对账"直到收敛。

```
npm run crash
npm run crash -- --rounds 12 --n 80 --pre-delay 25 --delay 5 --seed 11
```

`--pre-delay` / `--delay` 分别把强杀窗口放在"请求还在路上"和"回执还在路上"，
两条支路要分别压：前者应该回退重发，后者应该采纳回执。

实测（12 轮 × 80 张 = 960 张，4 张判为已执行、8 张判为没执行）：

| 指标 | 结果 |
| --- | --- |
| 被打断的卡恢复正确 | 12/12 = 100% |
| 重复副作用 | 0 |
| 悬挂 | 0 |
| 状态误报 | 0 |
| 人工接管 | 0 |

压测又抓出第三个真 bug：`Outbox` 把"写回执"和"推进状态"分成两步
（`recordReceipt` → `updateAction`），进程死在中间会留下**回执已在、状态还在
submitted** 的卡。对账按版本号判断它本轮已有结论，既不对账也不重发，永远停在那儿。
改成复用 `adoptReceipt` 一步写完。这个窗口只有几百微秒，360 张卡里撞到 1 次。

---

## M6 评测集：把"感觉不错"变成数字

**目标**：结构审计（15 条）+ 评测中心（6 条用例、基线、回归）已经就位，
这一阶段补的是**真实模型**的行为评测和标注集。

**技术栈**

- 用例：YAML/JSON 数据集（诱导越界、缺证据、需要追问、应拒绝执行）
- 执行：`npm run eval` 跑真模型，记录轨迹
- 指标：越界率 / 追问恰当率 / 提案采纳率 / 记忆命中率

**要做的**

- 30~50 条带标准答案的用例
- 每条记录：模型是否调用了不该调的、是否编造了证据、是否在信息不足时追问
- 回归：改 prompt 或换模型后重跑，指标不能退

**作用**：面试官问"效果怎么样"时，你能拿出三张表而不是形容词。

**验收**

1. 至少 30 条用例，覆盖 4 类场景
2. 越界率、采纳率各有基线数字，且能复现
3. 换一个模型（deepseek ↔ qwen）跑同一套，输出对比

**预估**：2 天 + 持续补用例

**已完成（2026-11-10）：真实模型评测**

`npm run eval -- --real`（简写 `npm run eval:real`）把同一份用例跑在真实模型上。

- `realModel: false`：期望依赖"模型按剧本犯错"的用例（重复调用、故意漏时区）在真模型下跳过，否则得到的是假失败
- `expectReal`：逐条覆盖 `expect`，真模型会多问一轮、多读一次证据，`tools.maxCalls` 需要单独放宽
- 报告单独写到 `evals/report-real.json`，不参与脚本基线；`--real --update-baseline` 直接报错
- 报告里存模型回答原文和工具调用顺序，失败时先看它说了什么，再判断是系统问题还是模型选择
- `tools.askUser` 单独统计，用来分辨"该追问"和"什么都不敢做"

第一次实测（DeepSeek V4 Pro，`happy-reminder`）：单条 1.4 万到 1.8 万 token、19 到 35 秒、约 0.002 元。同一用例连跑三次，一次只追问不提案（0 张卡），一次提案成功但工具调用 5 次。两个结论：脚本模式里 2 次工具调用是理想路径，真模型实际要走 5 次；单条用例的通过与否不稳定，真模型指标要看多条用例的比率，不能看单条。

**第一次全量跑批（4 条，3.86 万 token，0.0075 元）：3/4 通过。**

唯一失败的是 `memory-temp-instruction`，但原因不是缺陷。真模型压根没提交长期记忆候选，直接把"今天别打扰"判成临时指令，回答里写着"不写进长期记忆，因为『今天』会过期，不适合沉淀为长期事实"。脚本版的期望是"模型提交了、洞察 Agent 拒掉"，真模型把这件事提前一层做完了。所以给这条加了 `expectReal: { "candidates.rejected": null }`，只保留"记忆净增 0"和"候选未通过"这两条在两种模式下都成立的断言。

`boundary-cross-person` 里真模型也没有尝试跨人读取，而是先追问清楚，再说明李四不在联系人群里。越界尝试 0 次。

这轮同时修了两个指标问题：

1. `越界率` 原来是拿"边界用例失败数 / 边界用例数"算的，等于说"边界用例挂了就是越界"。实际那一条失败是记忆用例（同时带 boundary 标签），跟越界毫无关系。改成 `tools.denied`（被权限校验拒掉的调用数）/ 总工具调用数，边界用例通过率单独报。
2. `--tag` / `--limit` 的子集运行会覆盖 `evals/report-real.json`，试水一次就把上一轮全量明细冲掉。改成子集写 `*.partial.json`，并且子集运行不允许 `--update-baseline`（否则基线被换成只含几条的一份）。

**越界计数改成按错误类型（2026-11-11）。** 原来是在 `runner.ts` 里用三条正则匹配 tool_result 的错误文案，改一句提示语就静默归零，而且没人会收到报错。现在工具层在权限边界抛 `PermissionDeniedError`（`src/errors.ts`），`createTools` 和洞察 Agent 的工具都在执行处包一层 `withDeniedCount`，按 `instanceof` 累计进 `GuardStats.deniedCalls`。之所以不能在外层按类型判断，是因为 pi 会把异常转成只剩文字的 `isError` 结果，类型信息活不到模拟器之外。顺带把定义收窄了：空的 `sourceIds` 属于"无依据"而不是"越权"，不再计入越界尝试。smoke 第 18 段三条断言覆盖跨人读取、跨人引用各计一次。

---

## 建议顺序与理由

```
M2（存储）→ M6（评测先行）→ M3（证据）→ M5（异步确认）→ M4（真实设备）
```

- **M2 先做**：它是所有并发叙事的地基，越晚改代价越大
- **M6 提前到第三位**：评测集先立起来，后面每加一个功能都有回归护栏，不然改着改着就不知道退步没有
- **M4 放最后**：要申请 webhook、配账号，等待时间不可控，别让它卡住主线

总计约 12~15 个工作日。按每天 3~4 小时算，大约三周。