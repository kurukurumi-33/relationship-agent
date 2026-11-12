# relationship-agent

人际关系辅助 Agent：将联系人背景整理、证据检索、行动提案、用户确认、设备执行与记忆更新组织为一条可审计的处理链路。

[![CI](https://github.com/kurukurumi-33/relationship-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/kurukurumi-33/relationship-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)

## 项目简介

联系人资料、聊天记录与日程信息通常分散在多个应用中，每次会面前都需要重新整理上下文。本项目以 Agent 工具循环为核心，将这一过程拆分为五个可验证阶段：

```
证据输入 → 信息补全 → 行动确认 → 设备执行 → 记忆更新
```

系统的核心设计原则是：模型仅负责判断与表达，数据读取、写入与外部执行权限由宿主程序控制，不依赖提示词约束。

## 核心特性

- **权限隔离**：工具层仅提供证据读取、行动提案与记忆候选接口，不暴露任何写入方法。
- **提案与执行分离**：行动卡由模型提出，用户确认由宿主程序完成，模型无法自行确认或提交。
- **幂等执行**：requestId 由宿主程序生成，重试、进程崩溃与重复提交均只产生一次外部副作用。
- **并发控制**：记忆写入使用数据库层 generation CAS，两个会话同时修改同一联系人时，后写入者不会覆盖先写入者。
- **来源校验**：每条行动卡与记忆条目均需绑定 sourceIds，跨联系人引用与伪造证据在写入前即被拒绝。

## 系统架构

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

模型可以读取 Evidence 与 MemoryItem，但不能直接写入；只能提交 ActionCard 与 MemoryCandidate。用户确认后由 Outbox 提交至设备，设备回执通过 requestId 完成对账。权限边界与崩溃对账的详细说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

### 环境要求

- Node.js >= 22.5
- 使用 Node.js 内置 `node:sqlite`，无需安装数据库

### 安装与验证

```bash
git clone https://github.com/kurukurumi-33/relationship-agent.git
cd relationship-agent
npm install

npm run demo     # 端到端演示，无需配置 API 密钥
npm run smoke    # 边界场景测试
npm run audit    # 安全边界审计
npm run eval     # 评测套件与基线回归
```

`npm run demo` 输出节选：

```text
① 装配快照（模型可访问的完整上下文）
② 只读查询 → 追问 → 提案 → 确认 → 回执 → 记忆
③ 同一行动卡重复提交：reused=true，设备账本仍为 1 条
⑥ 过期 generation 写入被拒绝：记忆文档版本冲突
⑦ 跨联系人引用被拒绝：证据 ev_101 属于 p_002，不属于 p_001
全部通过 ✅
```

## 评测结果

| 评测层 | 命令 | 当前结果 | 说明 |
|---|---|---|---|
| 安全边界审计 | `npm run audit` | 15/15 | 越权读取、跨联系人引用、伪造证据与自行确认均被拦截 |
| 脚本用例 | `npm run eval` | 36/36，无回归 | 验证行为契约，修改提示词或切换模型后可直接对比 |
| 真实模型批量评测 | `npm run eval:real` | 四轮 47/48，145 次调用 0 次越界 | 越界率 95% 置信上界约 2.1%，为近似值 |
| 轨迹回放 | `npm run trace` | 支持 request / session / person 三种视角 | 用于分析单次会话的决策过程 |
| 语义评分 | `npm run judge -- --llm` | rubric v1 可运行 | 仅支持同一 rubric 内比较，尚未完成人工校准 |

真实模型评测会产生 API 调用费用，具体命令与判读方法见 [docs/EVAL.md](docs/EVAL.md)。

统计说明：145 次调用中未出现越界，按零事件三倍法则计算，95% 置信上界约为 2.1%。调用之间存在相关性，该上界仅为近似值，不宜表述为"稳定低于 1%"。

## 命令参考

### 基础验证

| 命令 | 作用 |
|---|---|
| `npm run demo` | 使用模拟模型完成端到端演示，无需配置 API 密钥 |
| `npm run smoke` | 边界场景测试：消息配对修复、TTL、问卷恢复、回执重试、证据入库、人工接管 |
| `npm run audit` | 安全边界审计，输出拦截率 |
| `npm run eval` | 运行评测用例并执行基线回归 |
| `npm run eval:real` | 使用真实模型批量评测，报告写入 `evals/report-real.json` |
| `npm run trace -- --session sess_xxx` | 轨迹回放，支持 `--request` 与 `--person` |
| `npm run judge -- --report` | 规则 Judge，无额外调用成本 |
| `npm run judge -- --report --llm --limit 3` | 语义 Judge，先运行三条样本 |
| `npm run judge -- --report --llm --out evals/judge-scores.json` | 导出语义评分结果 |
| `npm run calibrate -- --init` | 根据评分结果生成人工标注模板 |
| `npm run calibrate` | 计算 Judge 评分与人工评分的 Pearson / Spearman 相关系数及 MAE |
| `npm run collect -- --session sess_xxx` | 将真实会话回收为评测用例草稿 |

### 证据入库与审核

```bash
npm run ingest -- --file data/inbox/evidence.json
npm run ingest -- --ics data/inbox/calendar.ics --person p_001
npm run ingest -- --image data/inbox/chat.png --person p_001 --ocr

npm run review                                    # 列出待确认材料
npm run review -- --accept ev_xxx --content "补全的正文"
npm run review -- --reject ev_xxx
```

截图 OCR 提供独立验收入口，仅调用模型，不写入数据库：

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

npm run execute                                   # 提交所有已确认的行动卡
npm run reconcile                                 # 对账 submitted 且无回执的行动卡
```

### 真实模型接入

```bash
export DEEPSEEK_API_KEY=sk-xxx
npm run dev -- --person p_001 --goal "下周和张三评审，帮我准备会前提醒"
```

系统同时支持任意 OpenAI 兼容接口：

```bash
export RELATIONSHIP_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export RELATIONSHIP_MODEL_API_KEY=sk-xxx
export RELATIONSHIP_MODEL_ID=qwen-plus
```

截图 OCR 使用阿里云百炼 compatible-mode 视觉模型，默认模型为 `qwen3-vl-plus`，配置独立于主 Agent：

```bash
export DASHSCOPE_API_KEY=sk-xxx
# 或为 OCR 单独配置密钥
export RELATIONSHIP_OCR_API_KEY=sk-xxx
export RELATIONSHIP_OCR_MODEL=qwen3-vl-plus
```

未配置 OCR 密钥时系统仍可导入截图，材料将进入 `pending_review` 状态，等待人工确认。

### 设备接入

第一版设备为文件日历：用户确认后的日程与提醒写入 `.ics` 文件，再由用户导入系统日历。

```bash
npm run execute -- --device ics-file
npm run reconcile -- --device ics-file
npm run device-check                    # 50 张行动卡、30% 故障注入，校验设备与系统状态一致性
```

默认输出目录为 `data/device-calendar/`，可通过 `--calendar-dir` 或 `RELATIONSHIP_CALENDAR_DIR` 修改。

第二版设备为 CalDAV：事件直接写入日历服务，移动端日历客户端可自动同步。密码仅从环境变量读取，不支持命令行参数，以避免写入 shell 历史记录。

```bash
export RELATIONSHIP_DEVICE=caldav
export RELATIONSHIP_CALDAV_URL=https://host/remote.php/dav/calendars/user/personal/
export RELATIONSHIP_CALDAV_USER=user
export RELATIONSHIP_CALDAV_PASSWORD='应用专用密码'
npm run execute
npm run reconcile
```

### 压力测试与数据迁移

```bash
npm run soak          # 故障注入：可重试失败、永久失败、部分成功、回执丢失
npm run crash         # 随机 SIGKILL，验证崩溃恢复
npm run concurrency   # 两个独立进程并发写入同一联系人的记忆
npm run pg-check      # 验证 PostgreSQL 适配器
npm run migrate-json -- --from data/state.json --to data/state.db
npm run migrate-pg -- --from data/state.db --to postgresql://relation:relation@localhost:5432/relation
```

PostgreSQL 可通过 `docker compose up -d` 启动，随后设置：
`export DATABASE_URL=postgresql://relation:relation@localhost:5432/relation`。

## 项目结构

```
src/
  domain/                领域模型
  store/                 存储层：SQLite / PostgreSQL 双驱动，共用一份 SQL
  agent/                 快照、工具、提示词、洞察 Agent、运行护栏
  session/               会话编排、断点恢复、上下文压缩
  runtime/               问卷、Outbox、崩溃对账、设备适配层
  ingest/                证据入库：JSON / ICS / 截图 OCR
  eval/                  用例格式、执行器、规则 Judge、LLM Judge
scripts/                 demo / smoke / audit / eval / trace / judge / 压测 / 迁移
evals/cases/*.json       评测用例（数据文件）
docs/                    架构、评测、路线图、面试问答
```

## 实现进度

| 里程碑 | 状态 | 内容 | 验收方式 |
|---|---|---|---|
| M1 | 已完成（2026-10） | 端到端最小闭环 | `npm run demo` 全部通过 |
| M2 | 已完成（2026-11-06） | SQLite / PostgreSQL，CAS 与幂等下沉至数据库 | 两连接并发写同一联系人，恰好一个成功 |
| M3 | 已完成（2026-11-12） | 证据入库：JSON / ICS / 截图，哈希去重、TTL、RRULE 展开 | `npm run smoke` 第 21 段 |
| M4 | 已完成（2026-11-12） | 文件日历与 CalDAV 设备，失败重试与崩溃对账 | `npm run device-check` 50 张卡，悬挂 0 |
| M5 | 已完成（2026-11-11） | 异步确认队列，会话摘要与历史召回 | `npm run pending` / `confirm` / `execute`；`npm run probe` |
| M6 | 已完成（2026-11-12） | 评测中心：36 条用例、基线、轨迹、规则与 LLM Judge | `npm run eval` 36/36，`npm run audit` 15/15 |

## 已知限制

- **OCR 缺少标注集**：识别准确率目前仅能通过 `npm run ocr-check` 抽样人工检查；`confidence` 字段只输出，不参与接收判定。
- **语义评测缺少人工校准**：LLM Judge 的 rubric v1 已可运行，校准脚本已提供，尚缺人工评分数据。
- **sourceIds 仅校验存在性与归属**：不校验证据内容是否支持行动卡描述；口述证据可以引用，但尚无清理策略。
- **设备覆盖范围有限**：仅实现文件日历与 CalDAV；IM 通道经评估后不接入，原因见 [docs/INTERVIEW-QA.md](docs/INTERVIEW-QA.md) Q57。
- **SQLite 仅支持单机部署**：多机部署需切换至 PostgreSQL；适配器与迁移脚本已实现，但尚未在真实多实例环境中验证。
- **记忆仅保留当前版本**：暂无历史版本；重复日程为入库时生成的 90 天快照，不会随日期推移自动扩展。
- **统计效力有限**：145 次调用中 0 次越界，95% 置信上界约 2.1%，且调用之间存在相关性，仅可作为近似估计。
- **真实模型存在输出波动**：同一用例多次运行结果不完全一致，指标应基于多条用例的整体比率，不宜依据单条结果判断。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：权限边界、数据模型、幂等、CAS、崩溃对账
- [docs/EVAL.md](docs/EVAL.md)：评测闭环、指标定义、用例格式、真实模型判读方法
- [docs/ROADMAP.md](docs/ROADMAP.md)：M2 至 M6 的分阶段验收记录
- [docs/ALIGNMENT.md](docs/ALIGNMENT.md)：与参考架构的逐项对照与取舍
- [docs/INTERVIEW-QA.md](docs/INTERVIEW-QA.md)：各设计点的潜在追问与回答
- [docs/INFERRED.md](docs/INFERRED.md)：原始资料未覆盖部分的推断过程与不确定项
- [docs/LEARNING-PLAN.md](docs/LEARNING-PLAN.md)：能力缺口与学习路径

## 许可证

[MIT](LICENSE)