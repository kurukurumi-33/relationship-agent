# 架构说明

## 1. 这个项目在解决什么

联系人资料、聊天截图、日历散在三个地方，每次要见一个人，都得重新拼一遍上下文。
这个 Agent 的目标不是"聊得好听"，而是把一次关系跟进拆成可追溯的链路：

```
证据输入 → 信息补全 → 行动确认 → 设备执行 → 洞察与记忆更新
```

核心取舍：**模型只负责判断和表达，不负责执行**。
模型能读的东西、能提的东西、能改的东西，三层权限在代码里是分开的，不靠提示词自律。

## 2. 五条链路与代码映射

| 链路 | 实现位置 | 关键设计 |
|---|---|---|
| 工具循环 / Tool Calling | `src/agent/tools.ts`、`src/session/run.ts` | 基于 pi-agent-core 的 `Agent`，工具 5 个，读写分离 |
| 问卷补全 | `runtime/survey.ts` + `ask_user` 工具 | 追问是同步阻塞的，答案进 toolResult，不靠模型猜 |
| 行动提案与确认 | `agent/tools.ts` `propose_action` + `runtime/outbox.ts` | 提案 ≠ 执行；确认是宿主行为，模型无法自签 |
| 设备回执 | `runtime/device.ts`、`runtime/outbox.ts` | 回执用 requestId 对账，失败可区分于"没提交" |
| 记忆与上下文 | `agent/snapshot.ts`、`store/store.ts`、`session/resume.ts` | 快照只放索引；候选审核 + generation CAS；配对修复 |

## 3. 权限边界

```
         读                         写
模型 ──► Evidence / MemoryItem    ✗
  │
  ├─► ActionCard(proposed)   ← 提案，不是执行
  └─► MemoryCandidate(pending) ← 提案，不是记忆

宿主 ──► confirm → Outbox → Device → Receipt    （唯一真实写入路径）
      ──► review → commitMemory(generation CAS)
```

具体到代码：

- 工具 `execute` 能拿到的只有 `Store` 的读方法、`createAction`、`createCandidate`。
  `commitMemory`、`updateAction`、`recordReceipt` 没有暴露给工具层。
- `requestId` 由宿主生成（`src/domain/ids.ts`），模型只能"申请一张卡"，不能指定 ID。
  模型给的 ID 不可信，也无法在重试时保持稳定。
- 工具不接受 `personId` 参数，会话绑定谁就只能读写谁 —— 跨人读取在类型层面就不可能发生。

## 4. 数据模型

```
Person ──< Evidence            （只读，永不修改）
   │
   ├── MemoryDoc (generation, version, items[])   ← 每人一份，CAS 写入
   ├── MemoryCandidate (pending/approved/rejected) ← 模型提出，宿主审核
   └── ActionCard (requestId, cardVersion, status, receipt?) ← 幂等键
```

### 新增实体（对齐推荐架构后）

| 实体 | 作用 | 关键约束 |
|---|---|---|
| `SurveyRecord` | 可恢复暂停点：问题、答案、绑定哪条 toolCall | 靠 `toolCallId` 把答案注回原上下文 |
| `FactConflict` | 证据互相矛盾时登记 | 未解决前不进长期记忆 |
| `CompactionRecord` | 每次会话压缩的账 | 带 generation，并发压缩只认一个 |
| `AccessLogEntry` | 谁在哪个会话读过哪条证据 | 追加式，只写不改 |
| `HandoffRecord` | 卡住时交回人手里 | 护栏中断 / 设备失败 / 洞察拿不准 |

### ActionCard 状态机

```
proposed ──用户确认──► confirmed ──提交──► submitted ──回执──► executed
    │                                          │
    └──用户拒绝──► rejected                     └──回执失败──► failed
```

两条容易被忽略的规则：

1. **只有 `confirmed` 能提交。** `propose_action` 出来的卡一定是 `proposed`，
   宿主没确认就提交会直接抛错（`outbox.ts`）。
2. **`submitted` 先落盘再执行。** 顺序反了就会出现"设备做了、系统不知道"，
   恢复时无法判断该不该重发。这也是重试策略只允许发生在"没有回执"时的原因：
   有回执（哪怕失败）说明设备已经动过，盲目重试可能造成重复副作用。

### 崩溃对账（in-doubt 事务）

落盘 `submitted` → 调设备 → 设备执行成功 → **在写回执之前进程崩了**。
重启后这张卡停在 `submitted`、幂等表里没有回执，`Outbox` 拒绝提交，也没有别的地方管它。

系统自己永远分不清两种情况：设备执行了但回执没落盘，还是设备根本没收到。
所以唯一的正确动作是**去问设备**，而不是猜。

`runtime/reconcile.ts` 对每张卡给出三种结局：

| 设备能查吗 | 查到什么 | 结局 |
|---|---|---|
| 能 | 有回执 | **采纳**：补写回执，推进到 executed / failed |
| 能 | 明确没有 | **回退**：改回 `confirmed`，可安全重发（受重试上限约束） |
| 不能 / 查询失败 / 超上限 | — | **升级**：生成 Handoff，交给人 |

`DeviceAdapter.lookup()` 的契约写在接口注释里：**查不到 ≠ 没执行过**，
所以"查询失败"必须抛异常，不能返回 `undefined` 冒充"没有"。

### 记忆写入

`commitMemory(personId, expectedGeneration, items)`：

- `expectedGeneration` 与当前文档不一致 → 抛 `GenerationConflictError`；
- 每个 item 的 `sourceIds` 重新校验（存在 + 属于同一人）；
- 成功后 `generation + 1`、`version + 1`，追加 items。

为什么要两套编号：`generation` 是并发控制用的内部版本，`version` 是对外展示/缓存失效用的。
两者解耦后，客户端缓存策略变化不会影响写入冲突语义。

## 5. 四条硬约束

### 5.1 requestId 幂等

同一张卡重复提交（用户连点、进程重启、客户端重试）只会真正执行一次：
进程内 `inFlight` 去重 + 持久化幂等表（`store.getReceipt`）。
demo 的第 ④ 段就是在验证这件事：再提交一次 `reused=true`，设备账本仍然只有 1 行。

### 5.2 generation CAS

两个会话同时改同一个人的记忆，后写的不许覆盖先写的。
**现在由数据库保证**（SQLite，`node:sqlite`）：受影响行数为 0 即冲突，不是应用层比较。

```sql
UPDATE memory_doc SET generation = generation + 1, ...
 WHERE person_id = ? AND generation = ?
```

### 5.3 sourceIds 校验

记忆和行动都必须挂证据，且证据必须属于同一个人。
这拦住两类最常见的脏数据：模型把 A 的信息安到 B 头上；模型引用一条不存在的证据编故事。
校验点在 `store.assertSourcesOwnedBy`，写入前和提案前各校一次。

### 5.4 toolCall / toolResult 配对

LLM 协议要求 assistant 的每个 toolCall 都有对应 toolResult。
进程在"工具已发起、结果未落盘"时崩掉，恢复出来的上下文就是残缺的，直接喂给模型会报错。

`session/resume.ts` 的处理：

- 有 toolCall 没结果 → 补一条 `isError` 的合成结果，写明中断；
- 孤儿 toolResult → 丢弃；
- 顺序不变，其余消息原样保留。

写入会话前也跑一次，保证落盘的永远是合法上下文。

## 5.5 存储层：一份 SQL，两个驱动

```
StorePort（接口，48 个方法）
      ↑
  SqlStore（业务 SQL 只写一份，占位符统一用 ?）
      ↑
   Db（驱动抽象：all / one / run / transaction）
   ├── SqliteDb   node:sqlite，BEGIN IMMEDIATE，进程内事务串行
   └── PgDb       pg 连接池，? → $1..$n，事务借独占 client
```

入口是 `openStore()`：**有 `DATABASE_URL` 就连 PostgreSQL，没有就用本地 SQLite**。
上层 `run.ts` / `tools.ts` / `outbox.ts` 一行都不用改。

两个适配器各有一处只有自己才需要处理的细节：

- **SQLite**：事务体是 `async` 的，`await` 会让出事件循环，另一个连接会撞上写锁拿到
  `SQLITE_BUSY`，而不是我们想要的 CAS 冲突。所以按库文件路径加了一个进程内串行闸门，
  让并发写入表现为"排队 → 后到的看到新版本 → 冲突"，和 PostgreSQL 语义一致。
- **PostgreSQL**：`BEGIN` 必须发在**从连接池借出的那个 client** 上，用 `pool.query("BEGIN")`
  会把 BEGIN 和后续语句分到不同连接，事务等于没开。

### 数据迁移

`npm run migrate-pg -- --from data/state.db --to postgresql://...`：

1. 源库 `exportState()` 把每张表读回领域对象（ID、时间戳原样保留）
2. 目标库 `importState()` 在一个事务里写回去
3. 逐表比对条数，不一致就报错退出

不做双写——两套真值来源必然漂移；切换期就是"一次性搬完，旧库留着当备份"。

### 跨进程验证

`npm run concurrency` 用 `child_process.fork` 起两个**独立进程**，各建一个连接池：

```
两个子进程各自 read generation → 报给父进程 → 父进程确认同版本 → 同时放行
                              ↓
              一个 commit 成功，另一个 UPDATE 影响 0 行 → 冲突
```

同步用 IPC 闸门而不是 sleep：**必须先让两边都读到同一个旧版本再放行**，
否则"A 先提交、B 后读、B 也成功"只是正常的先后关系，测了等于没测。

不用 `worker_threads` 的原因：线程共享进程，证明不了"多实例"。

### 三处约束从应用层移到了数据库

| 约束 | 以前 | 现在 |
|---|---|---|
| 记忆写入 CAS | 内存里比较 generation | `UPDATE ... WHERE generation = ?`，受影响 0 行即冲突 |
| 提交幂等 | 内存 Map 查重 | `request_id` 主键 + `ON CONFLICT DO NOTHING` |
| 引用完整性 | 应用层 `assertSourcesOwnedBy` | 同上，**外加**外键约束兜底 |

`assertSourcesOwnedBy` 仍然保留——外键只能保证"证据存在"，保证不了"证据属于这个人"。

### 事务边界（只有三处）

1. `commitMemory`：升级 generation + 插入记忆条目，必须一起成或一起败
2. `adoptReceipt`：补写回执 + 推进卡片状态（对账用）
3. `importState`：迁移/种子整体导入

`Outbox` 的"先写 submitted 再调设备"**故意不是事务**——那是跨进程的 write-ahead，
事务包不住远端副作用。

### 为什么不用 ORM / 不保留 JSON 双写

- ORM 会把"受影响行数"抽象掉，而 CAS 恰恰靠这个信号；手写 SQL 才能在面试里讲清锁行为。
- 双写意味着两套真值来源，必然漂移。切换期用 `npm run migrate-json` 一次性导入。

### 并发是怎么验证的

`smoke.ts` 第 13 段：两个 `Store` 实例指向同一个 `.db` 文件，各读到 `generation=1`，
同时写入 → **恰好一个成功，另一个抛 `GenerationConflictError`**，最终只有一条落库。
JSON 时代做不到这个测试——每个实例各持一份内存副本，两边都会"成功"。

## 6. 运行护栏

`agent/guard.ts`，四个上限：

| 护栏 | 默认 | 失控形态 |
|---|---|---|
| `maxTurns` | 12 | 模型反复思考不收敛 |
| `maxToolCalls` | 24 | 工具轰炸 |
| `maxToolCallsPerTurn` | 6 | 一口气开几十张工单 |
| `maxConsecutiveToolFailures` | 3 | 环境或参数有问题，继续跑只是烧 token |
| `maxRepeats` | 3 | 同参数重复调用（最典型：查不到就一直查） |
| `maxWallClockMs` | 120s | 单次会话挂住 |

超限不是静默截断，而是 `agent.abort()` 并把原因写进 `RunResult.stats.exceededReason`。

> 视频里提到的 `shouldStopAfterTurn` 属于 pi 的低层 `agentLoop`，`Agent` 类没有暴露。
> 连续失败这一项用 `afterToolCall` + `abort()` 做等价实现，行为一致。

## 7. 上下文与记忆

`buildMemorySnapshot` 的取舍：

- 已确认记忆**全文**放进快照（条数受审核机制控制，不会无限膨胀）；
- 证据只放索引 + 120 字预览，正文靠 `get_evidence_text` 按需拉。

如果一个联系人聊了两年，把所有聊天记录塞进系统提示词是最常见也最致命的错误。
快照里随证据条数线性增长的部分必须被截断，正文按需取，代价是多一次工具调用。

`makeContextPruner` 在消息数超限时保留首条用户消息 + 最近若干条，
切割点必须落在 user 消息前 —— 否则会把 assistant 和它的 toolResult 切开，
那正是 5.4 要修的病。

> 压缩已接进主链路（`transformContext`），每次压缩写一条带 generation CAS 的账（`CompactionRecord`）。
> 摘要本身由模型生成（`summarizeDropped`），失败时退回"已省略 N 条"的结构化裁剪。
> 仍未做：压缩只在每次模型调用前触发，没有后台任务；摘要质量也没有评测。

## 8. M1 明确没做的事

诚实列出，避免把骨架当成成品：

> 2026-11-12 更新：第 1 条（证据入库管线）、第 2 条（文件日历与 CalDAV 设备）、第 4 条（异步确认）已在后续阶段补上，下面的原文保留为 M1 当时的判断。第 5 条也补了评测中心（33 条脚本用例、基线、分维度指标、真模型跑批），但语义评测仍然没有，记忆命中率缺标注集。

1. **证据是预切好的文本。** 聊天截图的多模态理解、日历同步都没有。真实接入时
   `Evidence` 的 `content` 应由入库管线写入，而不是像 `data/seed.ts` 那样手写。
2. **设备是 mock。** `MockDevice` 只写 jsonl 账本。真实设备需要处理超时、部分成功、
   撤回/补偿，这些都会反过来要求 `ActionCard` 增加 `attempts` 和 `compensation` 字段。
3. **存储已是 SQLite，但仍是单机。** 换库解决了多进程并发（CAS 和幂等由数据库保证），
   但 SQLite 是文件级写锁，多机部署要换 PostgreSQL；换的时候只改 `store.ts` 一个文件。
4. **确认在宿主同步阻塞。** 真实产品里用户可能十分钟后才点，需要"待确认"的持久化队列，
   而不是 `await confirm(card)`。
5. **评测只到第 1 层。** 已有 15 条结构断言（`npm run audit`）和轨迹回放（`npm run trace`），
   但**没有语义评测**：`npm run judge` 跑的是规则 Judge，只核对引用是否存在、有没有谎称执行。
   记忆命中率、提案采纳率、真实模型的越界率都还没测。

## 9. 里程碑建议

| 里程碑 | 内容 | 可验证结果 |
|---|---|---|
| M1 ✅ | 端到端最小闭环 | `npm run demo` 全绿 |
| M2 | 存储替换（SQLite/Postgres）+ 真实 CAS | 并发两个会话写同一人，后者冲突 |
| M3 | 证据入库：截图 OCR + 日历同步 | 一条真实截图进入 Evidence 并被引用 |
| M4 | 真实设备接入 + 回执重试/补偿 | 失败回执后能正确补偿且不重复 |
| M5 | 异步确认队列 + 会话摘要记忆 | 用户延迟确认不丢提案；长会话不丢关键事实 |
| M6 | 评测集 | 命中率 / 采纳率 / 越界率三张表 |