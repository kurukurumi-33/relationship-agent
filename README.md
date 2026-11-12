# relationship-agent

人际关系助手 Agent：把"见一个人之前重新拼一遍上下文"变成一条可追溯的链路。

[![CI](https://github.com/kurukurumi-33/relationship-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/kurukurumi-33/relationship-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)

模型只负责判断和表达。能不能读、能不能写、能不能执行，由宿主代码决定，不靠提示词自律。

## 30 秒看懂

输入是联系人、散落的证据（聊天截图、日历、手记）和一个关系目标。系统把它拆成五步：

```
证据输入 → 信息补全 → 行动确认 → 设备执行 → 记忆更新
```

- **工具层拿不到写 API**：模型只能读证据、提行动卡、提记忆候选。
- **提案不等于执行**：确认是宿主行为，模型无法自签。
- **每次执行都有幂等键**：requestId 由宿主生成，重试、崩溃、连点都只产生一次副作用。
- **记忆写入带 generation CAS**：两个会话同时改同一个人，后写的不覆盖先写的。
- **每条记忆和行动都挂 sourceIds**：跨人引用、编造证据在写入前被拒。

## 跑一遍

需要 Node ≥ 22.5，用内置 `node:sqlite`，不装任何数据库。

```bash
git clone https://github.com/kurukurumi-33/relationship-agent.git
cd relationship-agent
npm install

npm run demo     # 不需要任何 API key，跑完整条链路
npm run smoke    # 边界用例
npm run audit    # 15 个攻击用例
npm run eval     # 36 条评测用例 + 基线回归
```

`npm run demo` 的节选：

```text
① 装配快照（模型能看到的全部事实）
② 只读查询 → 追问 → 提案 → 确认 → 回执 → 记忆
③ 同一张卡重复提交：reused=true，设备账本仍然只有 1 行
⑥ 过期 generation 写入被拒：记忆文档版本冲突
⑦ 跨人引用被拒：证据 ev_101 属于 p_002，不属于 p_001
全部通过 ✅
```

## 架构

```mermaid
flowchart LR
  U[用户目标] --> A[Agent 工具循环]
  E[(Evidence 证据)] -->|只读| A
  M[(Memory 记忆)] -->|快照索引| A
  A -->|ask_user| S[问卷 / 追问]
  A -->|propose_action| C[ActionCard proposed]
  A -->|propose_memory| MC[MemoryCandidate pending]
  C -->|用户确认| CF[confirmed]
  CF --> O[Outbox 幂等提交]
  O --> D[设备：mock / ICS / CalDAV]
  D --> R[回执]
  R --> O
  MC -->|洞察审核 + 用户审核| W[commitMemory generation CAS]
```

模型能读 Evidence 和 MemoryItem，不能写；只能提 ActionCard 和 MemoryCandidate。
宿主确认后才走 Outbox，设备回执用 requestId 对账。更细的权限边界和崩溃对账见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 评测

| 层 | 命令 | 当前结果 | 能说明什么 |
|---|---|---|---|
| 边界审计 | `npm run audit` | 15/15 | 越权读取、跨人引用、伪造证据、自签确认都被拦 |
| 脚本用例 | `npm run eval` | 36/36，无回归 | 行为契约没退化，改 prompt 或换模型后可以直接比 |
| 真模型跑批 | `npm run eval:real` | 四轮 47/48，145 次调用 0 越界 | 真实模型下的任务完成率；越界率 95% 上界约 2.1%，是近似值 |
| 轨迹回放 | `npm run trace` | request / session / person 三种视角 | 能解释一次会话为什么这么答 |
| 语义评分 | `npm run judge -- --llm` | rubric v1 可跑 | 只能在同一个 rubric 内比较，还没人工校准 |

真模型跑批会产生费用，命令和判读口径写在 [docs/EVAL.md](docs/EVAL.md)。
145 次调用里 0 次越界，按三倍法则 95% 上界约 2.1%；调用之间存在相关性，
这个上界只能当近似，不能报"稳定低于 1%"。

## 命令

### 日常验收

| 命令 | 作用 |
|---|---|
| `npm run demo` | faux provider 端到端演示，零 key |
| `npm run smoke` | 边界用例：配对修复、TTL、问卷恢复、回执重试、入库、接管 |
| `npm run audit` | 15 个攻击用例，输出拦截率 |
| `npm run eval` | 脚本用例 + 基线回归 |
| `npm run eval:real` | 真模型跑批，报告写 `evals/report-real.json` |
| `npm run trace -- --session sess_xxx` | 轨迹回放，也支持 `--request` / `--person` |
| `npm run judge -- --report` | 规则 Judge，零成本 |
| `npm run judge -- --report --llm --limit 3` | 语义 Judge，先试三条 |
| `npm run judge -- --report --llm --out evals/judge-scores.json` | 导出语义分数 |
| `npm run calibrate -- --init` | 按分数生成人工打分模板 |
| `npm run calibrate` | 算 judge 分和人分的 Pearson / Spearman / MAE |
| `npm run collect -- --session sess_xxx` | 把真实会话回收成用例草稿 |

### 证据入库与审核

```bash
npm run ingest -- --file data/inbox/evidence.json
npm run ingest -- --ics data/inbox/calendar.ics --person p_001
npm run ingest -- --image data/inbox/chat.png --person p_001 --ocr

npm run review                                    # 列出待确认材料
npm run review -- --accept ev_xxx --content "补上的正文"
npm run review -- --reject ev_xxx
```

截图 OCR 有单独的验收入口，只调模型不写库：

```bash
npm run ocr-check -- --image D:\path\to\chat.png
npm run ocr-check -- --image D:\path\to\chat.png --show-raw
```

### 异步确认与执行

```bash
npm run pending
npm run confirm -- --request req_xxx --version 1
npm run confirm -- --request req_xxx --version 1 --reject
npm run confirm -- --candidate cand_xxx

npm run execute                                   # 提交所有已确认的卡
npm run reconcile                                 # 对账 submitted 且无回执的卡
```

### 真模型

```bash
export DEEPSEEK_API_KEY=sk-xxx
npm run dev -- --person p_001 --goal "下周和张三评审，帮我准备会前提醒"
```

也可以接任何 OpenAI 兼容端点：

```bash
export RELATIONSHIP_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export RELATIONSHIP_MODEL_API_KEY=sk-xxx
export RELATIONSHIP_MODEL_ID=qwen-plus
```

截图 OCR 走百炼 compatible-mode 的视觉模型（默认 `qwen3-vl-plus`），配置是另一套：

```bash
export DASHSCOPE_API_KEY=sk-xxx
# 或单独给 OCR 一把 key
export RELATIONSHIP_OCR_API_KEY=sk-xxx
export RELATIONSHIP_OCR_MODEL=qwen3-vl-plus
```

不配也能跑，截图会落 `pending_review` 等人工确认。

### 真实设备

第一版是文件日历：确认后的日程和提醒写成 `.ics`，用户再导入系统日历。

```bash
npm run execute -- --device ics-file
npm run reconcile -- --device ics-file
npm run device-check                    # 50 张卡 + 30% 失败，核对设备侧和系统状态
```

默认输出到 `data/device-calendar/`，可用 `--calendar-dir` 或 `RELATIONSHIP_CALENDAR_DIR` 改。

第二版是 CalDAV：事件直接 PUT 到日历服务，手机客户端自动同步。密码只从环境变量读，
不接受命令行参数，避免留在 shell 历史里。

```bash
export RELATIONSHIP_DEVICE=caldav
export RELATIONSHIP_CALDAV_URL=https://host/remote.php/dav/calendars/user/personal/
export RELATIONSHIP_CALDAV_USER=user
export RELATIONSHIP_CALDAV_PASSWORD='应用专用密码'
npm run execute
npm run reconcile
```

### 压测与存储

```bash
npm run soak          # 故障注入：可重试 / 永久 / 部分成功 / 回执丢失
npm run crash         # 随机 SIGKILL，验证崩溃恢复
npm run concurrency   # 两个独立进程抢同一条记忆
npm run pg-check      # PostgreSQL 适配器
npm run migrate-json -- --from data/state.json --to data/state.db
npm run migrate-pg -- --from data/state.db --to postgresql://relation:relation@localhost:5432/relation
```

PostgreSQL 用 `docker compose up -d` 起，然后 `export DATABASE_URL=postgresql://relation:relation@localhost:5432/relation`。

## 目录

```
src/
  domain/                领域模型
  store/                 存储层：SQLite / PostgreSQL 两个驱动，一份 SQL
  agent/                 快照、工具、提示词、洞察 Agent、护栏
  session/               会话编排、断点恢复、上下文压缩
  runtime/               问卷、Outbox、对账、设备适配层
  ingest/                证据入库：JSON / ICS / 截图 OCR
  eval/                  用例格式、执行器、规则 Judge、LLM Judge
scripts/                 demo / smoke / audit / eval / trace / judge / 压测 / 迁移
evals/cases/*.json       评测用例（数据，不是代码）
docs/                    设计、评测、路线图、面试问答
```

## 完成度

| 里程碑 | 状态 | 内容 | 可验证结果 |
|---|---|---|---|
| M1 | ✅ 2026-10 | 端到端最小闭环 | `npm run demo` 全绿 |
| M2 | ✅ 2026-11-06 | SQLite / PostgreSQL，CAS 与幂等下沉到数据库 | 两连接并发写同一人，恰好一个成功 |
| M3 | ✅ 2026-11-12 | 证据入库：JSON / ICS / 截图，哈希去重、TTL、RRULE 展开 | `npm run smoke` 第 21 段 |
| M4 | ✅ 2026-11-12 | 文件日历 + CalDAV，失败重试与崩溃对账 | `npm run device-check` 50 张卡，悬挂 0 |
| M5 | ✅ 2026-11-11 | 异步确认队列 + 会话摘要与召回 | `npm run pending` / `confirm` / `execute`；`npm run probe` |
| M6 | ✅ 2026-11-12 | 评测中心：36 条用例、基线、轨迹、规则 / LLM Judge | `npm run eval` 36/36，`npm run audit` 15/15 |

## 已知限制

- **OCR 没有标注集**：准确率只能手工跑 `npm run ocr-check` 看几张图，`confidence` 只打印，不参与判定。
- **语义评测没有人工校准**：LLM Judge 的 rubric v1 可跑，校准脚本也齐了，缺的是人打分数据。
- **sourceIds 只校验存在和归属**：不校验证据内容是否支撑卡片上那句话；口述证据能引用，也没有清理策略。
- **设备只覆盖日历**：文件日历和 CalDAV 之外，IM 明确不做，理由见 [docs/INTERVIEW-QA.md](docs/INTERVIEW-QA.md) Q57。
- **SQLite 是单机**：多机部署要换 PostgreSQL；PG 适配器和迁移脚本已有，但没在真实多实例下压过。
- **记忆只存当前版本**：没有历史版本；重复日程是入库时的 90 天快照，不会自动往后补。
- **统计效力有限**：145 次调用 0 越界，95% 上界约 2.1%，调用之间相关，只能当近似。
- **真实模型有抖动**：同一用例连跑结果不完全一致，指标要看多条用例的比率，不能看单条。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：权限边界、数据模型、幂等、CAS、崩溃对账
- [docs/EVAL.md](docs/EVAL.md)：评测闭环、指标定义、用例格式、真模型判读口径
- [docs/ROADMAP.md](docs/ROADMAP.md)：M2 到 M6 的逐阶段验收记录
- [docs/ALIGNMENT.md](docs/ALIGNMENT.md)：与推荐架构的逐项对照和取舍
- [docs/INTERVIEW-QA.md](docs/INTERVIEW-QA.md)：每个设计点会被怎么追问
- [docs/INFERRED.md](docs/INFERRED.md)：原文档没给的部分，推断过程和不确定项
- [docs/LEARNING-PLAN.md](docs/LEARNING-PLAN.md)：能力缺口与学习路径

## License

[MIT](LICENSE)