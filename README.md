# relationship-agent

人际关系助手 Agent 的后端骨架。用 [pi](https://github.com/earendil-works/pi) 的工具循环做"模型会说"，
外面的宿主代码负责"能不能做"：只读查询、结构化追问、行动提案、用户确认、设备回执、记忆审核与写入。

## 快速开始

需要 **Node ≥ 22.5**（用内置 `node:sqlite`，不装任何数据库）。

```bash
cd D:\relationship-agent
npm install

# 不需要任何 API key，用 faux provider 跑完整条链路
npm run demo

# 边界用例
npm run smoke

# 边界审计：15 个攻击用例，输出拦截率
npm run audit

# 轨迹回放（评测第 2 层）
npm run trace -- --request req_xxx
npm run trace -- --session sess_xxx
npm run trace -- --person p_001

# 评测第 3 层：规则 Judge（零成本） / LLM Judge（语义评分，会花钱）
npm run judge -- --session sess_xxx
npm run judge -- --report                       # 规则 Judge 扫最近一次真模型报告
npm run judge -- --report --llm --limit 3       # 语义 Judge，先试三条
npm run judge -- --report --llm --out evals/judge-scores.json   # 导出分数
npm run calibrate -- --init                     # 按分数生成人工打分模板
npm run calibrate                               # 算 judge 分和人分的相关性

# 证据入库（哈希去重 + 按类型 TTL + 自动摘要）
npm run ingest -- --file data/inbox/evidence.json
npm run ingest -- --ics data/inbox/calendar.ics --person p_001
# 截图：不加 --ocr 就落待确认；加 --ocr 才会真的调视觉模型
npm run ingest -- --image data/inbox/chat.png --person p_001 --ocr

# 人工审核待确认材料
npm run review
npm run review -- --accept ev_xxx --content "补上的正文"

# 截图 OCR 单独验收（只调模型，不写库）
npm run ocr-check -- --image D:\path\to\chat.png

# 评测中心：按「结果 / 轨迹 / 代价」三轴出报告，和基线比
npm run eval
npm run eval -- --tag boundary
npm run eval -- --update-baseline
npm run eval:real                      # 真模型跑批，报告写 evals/report-real.json

# 把一次真实会话回收成用例草稿（数据闭环入口）
npm run collect -- --session sess_xxx

# 崩溃对账：找出 submitted 且无回执的卡
npm run reconcile

# 把旧的 state.json 迁到 SQLite（一次性）
npm run migrate-json -- --from data/state.json --to data/state.db

# 用 PostgreSQL（先 docker compose up -d）
# export DATABASE_URL=postgresql://relation:relation@localhost:5432/relation
npm run pg-check

# 跨进程并发：两个独立 node 进程抢同一条记忆
npm run concurrency

# SQLite → PostgreSQL 数据迁移（保留 ID，逐表核对条数）
npm run migrate-pg -- --from data/state.db --to postgresql://relation:relation@localhost:5432/relation

# 接真实模型
export DEEPSEEK_API_KEY=sk-xxx
npm run dev -- --person p_001 --goal "下周和张三评审，帮我准备会前提醒"
```

也可以接任何 OpenAI 兼容端点：

```bash
export RELATIONSHIP_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export RELATIONSHIP_MODEL_API_KEY=sk-xxx
export RELATIONSHIP_MODEL_ID=qwen-plus
```

截图 OCR 单独一套配置，走百炼 compatible-mode 的视觉模型（默认 `qwen3-vl-plus`）。
不配也能跑，截图会落 `pending_review` 等人工确认。各账号能看到的模型不一样，
先查一次：`curl -H "Authorization: Bearer $DASHSCOPE_API_KEY" https://dashscope.aliyuncs.com/compatible-mode/v1/models`。

```bash
export DASHSCOPE_API_KEY=sk-xxx
npm run ocr-check -- --image D:\path\to\chat.png
```

其他可选：`RELATIONSHIP_OCR_API_KEY`（单独一把 key）、`RELATIONSHIP_OCR_MODEL`、`RELATIONSHIP_OCR_BASE_URL`。

真实设备第一版是文件日历：确认后的日程和提醒写成 `.ics`，用户再导入系统日历。

```bash
npm run execute -- --device ics-file
npm run reconcile -- --device ics-file
npm run device-check                    # 50 张卡 + 30% 失败，验收设备侧和系统状态是否一致
```

默认输出到 `data/device-calendar/`，可用 `--calendar-dir` 或 `RELATIONSHIP_CALENDAR_DIR` 改。
不传 `--device` 时仍然用 mock 设备（写 jsonl 账本），也支持 `RELATIONSHIP_DEVICE=ics-file`。

CalDAV 版把事件直接 PUT 到日历服务，手机客户端会自动同步。密码只从环境变量读，
不接受命令行参数（会留在 shell 历史里）：

```bash
export RELATIONSHIP_DEVICE=caldav
export RELATIONSHIP_CALDAV_URL=https://host/remote.php/dav/calendars/user/personal/
export RELATIONSHIP_CALDAV_USER=user
export RELATIONSHIP_CALDAV_PASSWORD='应用专用密码'
npm run execute
npm run reconcile

# 也可以只给某一次命令：
npm run execute -- --device caldav --caldav-url http://127.0.0.1:5232/me/personal/ --caldav-user me
```

## 目录

```
src/
  domain/types.ts        领域模型：Person / Evidence / MemoryDoc / ActionCard / SurveyRecord / FactConflict
  store/schema.sql       12 张表（SQLite / PostgreSQL 共用一份 DDL）
  store/port.ts          StorePort 接口 + GenerationConflictError / NotFoundError
  store/db.ts            驱动抽象：all / one / run / transaction
  store/sqlite-db.ts     SQLite 适配器（node:sqlite，进程内事务串行）
  store/pg-db.ts         PostgreSQL 适配器（连接池，? → ）
  store/sql-store.ts     通用 SQL 实现：48 个方法只写一份
  store/store.ts         入口：有 DATABASE_URL 用 PG，否则用 SQLite
  agent/snapshot.ts      按 personID 装配 MemorySnapshot（含时间、时区、冲突、关系目标）
  agent/tools.ts         5 个工具：2 只读、1 追问、2 提案
  agent/insight.ts       独立洞察 Agent：审核候选、登记冲突
  agent/guard.ts         轮次 / 单轮次数 / 连续失败 / 重复调用 / 墙钟护栏
  agent/prompt.ts        系统提示词
  session/run.ts         宿主编排：快照 → 模型循环 → 确认 → 提交 → 回执 → 洞察 → 记忆
  session/resume.ts      配对修复、问卷答案注回、上下文压缩
  runtime/outbox.ts      出站队列：confirmed → submitted → executed/failed，幂等 + 可重试失败
  runtime/reconcile.ts   崩溃对账：处理"设备可能执行了、系统不知道"的卡
  runtime/device.ts      设备适配层（mock 支持 partial / 冲突类失败 / 幂等查询）
  runtime/ics-render.ts  日程和提醒的 VEVENT 渲染（两个日历设备共用）
  runtime/ics-file-device.ts  文件日历设备：把日程和提醒写成可导入的 .ics
  runtime/caldav-device.ts    CalDAV 设备：条件 PUT 到日历服务，GET 做幂等查询
  runtime/create-device.ts    按 --device / RELATIONSHIP_DEVICE 选设备
  runtime/survey.ts      问卷 / 确认 / 审核的 CLI 与脚本实现
  ingest/evidence.ts     证据入库：哈希去重、按类型 TTL、入库即生成摘要
  ingest/calendar.ts     ICS 解析：折行 / 转义 / 时区 / 全天 / 取消，一条事件一条证据
  ingest/screenshot.ts   截图入库：字节哈希去重，抽不出正文就落 pending_review
  ingest/ocr.ts          截图 OCR：视觉模型 + JSON 字段抽取，注入给 screenshot.ts
  eval/judge.ts          规则 Judge + LLM Judge（rubric v1）
  eval/stats.ts          校准用的相关系数 / 平均绝对误差
  eval/case.ts           评测用例的数据格式
  eval/runner.ts         用例执行器：独立存储、独立设备、多会话、独立模型队列
  cli.ts                 真实模型入口
evals/
  cases/*.json           评测用例（数据，不是代码）
  baseline.json          基线（谁通过了，改坏了会报回归）
  report.md             最近一次评测报告
scripts/demo.ts          faux provider 端到端演示（带断言）
scripts/smoke.ts         边界用例：配对修复、TTL、问卷恢复、回执重试、入库、接管
scripts/audit.ts         边界审计：15 个攻击用例
scripts/trace.ts         轨迹回放（第 2 层评测）：消息 / 访问 / 问卷 / 压缩 / 用量 / 接管
scripts/judge.ts         第 3 层评测入口：单会话 / 扫报告 / 语义评分 / 导出分数
scripts/calibrate.ts     Judge 校准：人工打分模板 + 相关性统计
scripts/ingest.ts        批量导入证据（JSON / ICS / 截图，`--ocr` 才调视觉模型）
scripts/review.ts        人工审核待确认证据（列出 / 接受 / 拒绝）
scripts/ocr-check.ts     截图 OCR 验收：只调模型不写库，打印抽取结果和耗时
scripts/eval.ts          评测入口：跑用例、算指标、比基线
scripts/collect.ts       会话 → 用例草稿
scripts/reconcile.ts     崩溃对账命令
scripts/device-check.ts  文件日历设备验收：50 张卡 + 故障注入，核对设备侧和系统状态
scripts/migrate-json.ts  旧 JSON → SQLite 迁移
scripts/migrate-sqlite-to-pg.ts  SQLite → PostgreSQL 迁移
scripts/concurrency.ts   跨进程并发验证（fork 两个子进程）
data/seed.ts             演示种子数据
docs/ARCHITECTURE.md     设计与约束说明
docs/ALIGNMENT.md        与推荐博主架构的逐项对照和取舍
docs/INFERRED.md         原文档没给的部分：推断过程、补了什么、哪些不确定
docs/EVAL.md             评测中心：闭环、指标定义、用例格式
docs/ROADMAP.md          阶段计划
docs/LEARNING-PLAN.md    能力缺口与学习路径
```

## 当前完成度（M1 + 对齐推荐架构）

- [x] MemorySnapshot 装配（记忆 + 证据索引 + 未结束行动 + 时间/时区/关系目标/事实冲突）
- [x] 只读工具（读证据正文、证据检索），工具层拿不到写入 API
- [x] 结构化追问 `ask_user`，**问卷持久化 + 断点恢复**（答案注回原 toolCall）
- [x] 行动卡提案 `propose_action` → 用户确认 → Outbox 提交 → 设备回执（ok / partial / failed）
- [x] 记忆候选 `propose_memory` → **洞察 Agent 审核** → 用户审核 → generation CAS 写入
- [x] 独立洞察 Agent：过滤临时指令、登记事实冲突
- [x] requestId 幂等（行动卡级 + 请求级重放）、卡片版本校验、sourceIds 跨人校验
- [x] 存储换成 SQLite：CAS 与幂等由数据库保证，两连接并发写入恰好一个成功
- [x] 会话持久化（每条消息落盘）+ toolCall/toolResult 配对修复
- [x] 证据 TTL：截图过期后只留摘要，正文不再进上下文
- [x] 证据入库管线：哈希去重、按类型 TTL、入库即生成摘要
- [x] 三个导入通道：JSON / ICS（时区、折行、转义、取消、`RRULE` 展开）/ 截图 OCR（视觉模型 + JSON 字段抽取）
- [x] 重复日程展开：`DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`，支持 `INTERVAL` / `COUNT` / `UNTIL` / `BYDAY` / `BYMONTHDAY` / `EXDATE`，窗口 90 天、单事件上限 120 个实例
- [x] 待人工确认状态 `pending_review`：快照、检索、工具读取三层过滤，`npm run review` 接受或拒绝
- [x] 证据访问审计：谁在哪个会话读过哪条证据
- [x] 人工接管：护栏中断 / 设备失败时把会话交回人手里
- [x] 崩溃对账：`submitted` 且无回执的卡，按设备幂等查询给出采纳 / 回退 / 升级三种结局
- [x] 真实设备第一版：文件日历，日程和提醒写成 `.ics`，幂等查询靠文件是否存在，`npm run device-check` 验收
- [x] 真实设备第二版：CalDAV，条件 PUT（`If-None-Match: *`）保证同一 requestId 不重复写入，GET 做幂等查询
- [x] 会话用量统计（token / 成本）
- [x] 运行护栏：轮次 / 单轮次数 / 连续失败 / 重复调用 / 墙钟
- [x] 上下文压缩接进主链路，压缩记录带 generation CAS
- [x] 评测第 1 层：边界审计 15 个用例，拦截率 15/15
- [x] 评测中心：用例是数据、分维度指标、基线 + 回归判定（36 条用例，可扩展）
- [x] 数据闭环：`collect` 把真实会话回收成用例草稿
- [x] 评测第 2 层：轨迹回放（request / session / person）
- [x] 评测第 3 层：规则 Judge（零成本、可复现）+ LLM Judge（rubric v1，解析失败直接报错不静默给分）+ 人工校准脚本
- [x] 用例层支持多会话（跨会话记忆）和保留期边界，断言可以直接看工具返回（`tools.outputContains`）
- [x] 追问回答落成证据：`sourceIds` 可以引用用户口述内容，"问完再做"不再被拒

## 未做（M2 以后）

- CalDAV 在 Radicale 上实测通过，Nextcloud / iCloud 没测（差异在 URL 发现和认证方式）
- 截图 OCR 没有标注集，准确率只在手工跑过的几张图上确认；`confidence` 只打印，不参与判定
- 复杂重复规则（`BYSETPOS` / `BYMONTH` / `BYWEEKNO` 等）不展开，只导入首个实例并在正文写明原因
- 记忆文档的旧版本历史（现在只存当前版本）
- LLM Judge 和校准脚本都齐了，缺人工打分数据；没跑过全量语义评分，稳定性未验证
- `sourceIds` 只校验存在和归属，不校验证据内容是否支撑卡片上那句话；口述证据也没有清理策略
- 多设备、多端回执聚合；失败后的补偿动作

> 2026-11-12 决定：IM 通道（企业微信 / 钉钉）不做。机器人发消息用的是机器人身份，和"以用户名义草拟"冲突；
> webhook 也没有幂等查询能力，`lookup` 只能抛异常，系统会退化到"状态未知就交给人"。取舍见 `docs/INTERVIEW-QA.md` Q57。

细节和设计取舍见 `D:\relationship-agent\docs\ARCHITECTURE.md`。