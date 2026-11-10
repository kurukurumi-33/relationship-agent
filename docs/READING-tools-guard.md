# 导读：工具层与护栏

对应文件：

- `src/agent/tools.ts`：模型能调什么
- `src/agent/guard.ts`：调太多次怎么办
- `src/agent/rules.ts`：调了但参数不对怎么办

这三份代码回答同一个问题：**模型能做什么，和模型做多了、做错了怎么办。**

读完之后你应该能回答四个问题：

1. 为什么模型拿不到写数据库的能力，却仍然能"写"记忆？
2. 预算上限为什么分五种，而不是一个总次数？
3. `beforeToolCall` 返回 `block: true` 之后，模型看到的是什么？
4. 参数规则为什么不能全写进 JSON Schema 或 `store`？

---

## 一、tools.ts：权限靠类型，不靠提示词

### 1.1 上下文里的 personId 是固定的

```ts
export interface ToolContext {
  store: Store;
  personId: string;      // 会话绑定的联系人
  sessionId: string;
  survey: SurveyHandler;
  onProposedAction: (card: ActionCard) => void;
  onProposedMemory: (candidate: MemoryCandidate) => void;
}
```

注意工具的**参数 schema**里没有任何 `personId`。模型就算想读别人，也没有这个字段可填。跨人读取在类型层面就不可能，不需要靠"系统提示词里写了不许跨人"来防。

这和一个常见做法相反：很多项目把所有参数都开放给模型，然后在 prompt 里写"不要读其他用户的数据"。那样一旦 prompt 被诱导，防线就没了。

### 1.2 五个工具分三类

| 工具 | 类别 | 能写 store 吗 |
|---|---|---|
| `get_evidence_text` | 只读 | 不能 |
| `search_evidence` | 只读 | 不能 |
| `ask_user` | 追问 | 只写问卷记录 |
| `propose_action` | 提案 | 只写 `proposed` 状态 |
| `propose_memory` | 提案 | 只写 `pending` 候选 |

关键在最后一列。"提案"和"执行"是分开的：

- `propose_action` 调 `store.createAction()`，落库的状态是 `proposed`；
- 用户确认发生在 `run.ts` 的 for 循环里，不在工具里；
- 真正推给设备的是 `Outbox.submit()`，工具层根本 import 不到它。

看 `createTools` 的返回（第 216 行）：

```ts
return [getEvidenceText, searchEvidence, askUser, proposeAction, proposeMemory];
```

整个工具数组里没有 `commitMemory`、没有 `updateAction`、没有 `outbox`。模型的行动能力上限由**传入的依赖**决定，不是由提示词决定。

### 1.3 只读工具也要留痕

```ts
execute: async (_toolCallId, params) => {
  const ev = await ctx.store.getEvidence(params.evidenceId);
  if (ev.personId !== ctx.personId) { throw ... }
  await ctx.store.logAccess({ sessionId, personId, kind: "read", evidenceId, actor: "agent" });
  ...
}
```

先查归属，再记审计，最后才返回内容。顺序不能反：先记日志再查归属的话，一次被拒绝的读取也会留下"读过"的记录，审计表会脏。

`search_evidence` 记的是 `kind: "search"` 加原始 query。这条比读正文更值得记，因为检索词本身就暴露意图（搜"工资""分手""医院"含义完全不同）。

### 1.4 追问前先落库

```ts
const survey = await ctx.store.createSurvey({ sessionId, toolCallId, personId, questions });
const answers = await ctx.survey(params.questions);
await ctx.store.answerSurvey(survey.surveyId, answers);
```

三行的顺序是有原因的。用户回答问题可能要几分钟，进程在这期间可能被杀。问卷先落库，`toolCallId` 就是和会话消息里那个 toolCall 对的锚点。

恢复时 `resume.ts` 会按 `toolCallId` 把答案注回历史消息里，再跑配对修复。如果问卷没先落库，模型那边有个 toolCall 永远等不到 toolResult，会话就废了。

### 1.5 工具返回文本里带"别乱说"的提示

```ts
note: "行动卡已生成，等待用户确认。用户确认前不要声称已执行。"
```

这句是给模型看的，属于软约束。它有用但不是防线：`audit.ts` 里的 B3 用例专门测"模型谎称已执行"，验证的是**库里没有真实副作用**，而不是模型一定不说谎。

软约束和硬约束要分清。提示词让模型倾向于按规矩走，代码保证即使它不按规矩走，系统也不会真的执行。

---

## 二、guard.ts：五种预算，各管一种失控方式

### 2.1 为什么不是"总共允许 30 次工具调用"

因为失控的形态不止一种。一个总次数管不住下面四种情况中的三种：

| 参数 | 防的是什么 |
|---|---|
| `maxTurns: 12` | 模型一直说话、一直调工具，每轮调一次，永远不结束 |
| `maxToolCalls: 24` | 总量失控 |
| `maxToolCallsPerTurn: 6` | 单轮爆发：一次性开几十张行动卡 |
| `maxConsecutiveToolFailures: 3` | 环境坏了还在重试，烧 token |
| `maxWallClockMs: 120_000` | 模型很慢，或者工具卡住 |
| `maxRepeats: 3` | 同名同参数反复调用，看起来在工作，其实原地打转 |

`maxRepeats` 是这里面最值得讲的。真实 agent 最常见的故障不是"答错"，而是**反复用同样的参数调同一个工具**。模型觉得结果不对，于是再调一次，还是一样，再调一次。总量上限能拦，但要浪费很多轮才拦到。

### 2.2 重复检测的 key 怎么算

```ts
const key = `${input.toolCall.name}:${JSON.stringify(input.args ?? input.toolCall.arguments ?? {})}`;
const count = (this.callCounts.get(key) ?? 0) + 1;
if (count > this.budget.maxRepeats) { block }
```

名字加序列化后的参数。`maxRepeats: 3` 意味着前 3 次放行，第 4 次拦。

为什么要放行前 3 次？因为重试本身是合理策略（网络抖动、偶发失败）。3 次还没成，说明参数或者环境有问题，再调下去大概率一样。

### 2.3 blocked 的调用不算进 toolCalls

```ts
this.stats.blockedCalls += 1;
return { block: true, reason: ... };
// 注意：下面三行在 return 之后，不会执行
this.stats.toolCalls += 1;
this.callsThisTurn += 1;
```

被拦下的调用只计入 `blockedCalls`，不计入 `toolCalls`。否则一个模型疯狂重复调用，会先把总量预算吃光，然后以"超过工具调用上限"为由中断，你从原因里看不出真正的问题是"它在死循环"。

这也是为什么 `GuardStats` 里四个计数分开：`turns` / `toolCalls` / `blockedCalls` / `failedToolCalls`。评测报告里的"护栏拦截 1 次"就是读的 `blockedCalls`。

### 2.4 三轮实现同一个事：超时中断

```ts
startClock(): void {
  this.timer = setTimeout(() => this.exceed(`超过墙钟上限 ...`), this.budget.maxWallClockMs);
  this.timer.unref?.();
}
```

`unref()` 的作用是别让这个定时器把 Node 进程吊住。如果脚本跑完但计时器还在，进程会多等 120 秒才退出。这是个容易漏的小坑。

`exceed()` 有三层保护：

```ts
private exceed(reason: string): void {
  if (this.stats.exceededReason) return;   // 只记第一次
  this.stats.exceededReason = reason;
  this.onExceeded(reason);
}
```

第一次超限的原因才是有信息量的。后面再超往往是被第一次引起的连锁反应（比如中断过程中工具报错，又触发"连续失败"）。

### 2.5 三轮之后 `beforeToolCall` 会一直拦

```ts
if (this.stats.exceededReason) {
  return { block: true, reason: `会话已中断: ${this.stats.exceededReason}` };
}
```

`exceed()` 调的是 `agent.abort()`。但 abort 不是立刻生效的，可能还有正在进行的工具调用或者下一轮要开始。所以护栏自己也要有"已中断"的闸门，保证中断后不会再放行任何新调用。

### 2.6 那个不存在的钩子

```ts
/**
 * 视频里提到用 pi 的 shouldStopAfterTurn 做这件事，但 Agent 类没有暴露这个钩子
 * （它只属于低层 agentLoop），所以这里用 afterToolCall + abort 做等价实现。
 */
```

这个注释是踩坑记录。pi 有两层 API：`Agent`（带工具循环的封装）和 `agentLoop`（低层）。`shouldStopAfterTurn` 在低层才有，`Agent` 不转出来。

等价实现是：`afterToolCall` 里统计失败，达到上限就 `exceed()` → `abort()`。行为上等价，但语义上有一点差别：`shouldStopAfterTurn` 是"这轮做完就停"，`abort` 是"立刻停"。当前实现会打断正在进行的轮次，对用户来说表现为回答被截断。

---

## 三、三份代码怎么接起来的

`run.ts` 的 Agent 构造：

```ts
agent = new Agent({
  initialState: { ..., tools },
  beforeToolCall: async (ctx) => {
    const blocked = guard.beforeToolCall({ toolCall: ctx.toolCall, args: ctx.args });
    if (blocked?.block) return blocked;
    const violation = checkToolRules(ctx.toolCall.name, ctx.args);
    if (!violation) return undefined;
    guard.recordBlock();
    return { block: true, reason: `${violation.reason}（规则 ${violation.rule}）` };
  },
  afterToolCall: async (ctx) => guard.afterToolCall({ isError: ctx.isError }),
});
```

工具数组交给 Agent，护栏和规则也交给 Agent。模型看不到它们，它们看不到模型，中间只有 pi 的回调约定。

顺序是**先预算、后参数**。反过来的话，一条坏参数会先被规则拦下，却不会计入 `toolCalls` 和重复计数，模型可以用同样的参数无限重试，直到撞上轮次上限。

`run.ts` 的订阅回调：

```ts
agent.subscribe(async (event) => {
  guard.observe(event);      // 统计轮次
  opts.onEvent?.(event);     // 转给宿主
  if (event.type === "message_end") await store.appendSessionMessages(...);
});
```

所以护栏的数据来源有三个口子：`beforeToolCall`（事前）、`afterToolCall`（事后）、`subscribe`（轮次事件）。

### 3.1 guard 和 rules 的分界

两个文件都在拦，但拦的东西不一样：

- `guard.ts` 管**数量和节奏**。它不看你调了什么、参数对不对，只看"调了多少次、隔多久一次、同样的东西重复了几遍"。它不需要知道业务。
- `rules.ts` 管**参数语义**。JSON Schema 保证了字段存在、类型正确，管不了"标题全是空格""时间没带时区""追问只有一个选项"。

所以写进 `rules.ts` 的规则要满足两个条件：Schema 表达不了，且 `store` 也不会拒绝。能用 Schema 写的别写进规则，`store` 已经会校验的也别重复一遍，那只是把同一个错误检查三遍。

### 3.2 拦截理由的措辞是有功能的

规则返回的 `reason` 会被 pi 转成 `isError: true` 的 tool_result，原样回到模型上下文里。所以每句话都写成"怎么改"，不写"禁止"：

```
payload.at 必须是带时区偏移的 ISO 时间，例如 2026-11-20T09:00:00+08:00；
不带时区设备会按各自本地时间解释（规则 bad-at）
```

只写"参数非法"的话，模型下一轮大概率用同样的参数再试一次，白烧一轮。这不是风格问题，是错误回灌能不能起作用的前提。smoke 第 17 段最后四项验证的就是这个链路：第一次被拦、模型收到 isError、改对参数、提案落地。

---

## 四、面试会被问到的问题

**Q：你怎么保证模型不会删数据？**
A：工具层根本没有删除能力的引用。`createTools` 的入参里拿不到 `store` 之外的任何东西，而 `store` 上能调用的方法由工具自己写死。不是靠提示词说"不许删"，是 `deletePerson` 这样的方法根本没被传进来。

**Q：护栏拦截之后模型知道吗？**
A：知道。`block: true` 加 `reason` 字符串会作为工具结果回到模型上下文里。所以第 96 行的 reason 写得很具体："同名同参数已调用 N 次，请换策略或直接说明信息不足。"如果只写"blocked"，模型会继续尝试。

**Q：预算值怎么定的？**
A：12 轮 / 24 次工具 / 单轮 6 次，是按 demo 场景估的。正常会话（读证据 → 追问 → 提案 → 提案记忆）大约 3 到 5 轮、6 到 10 次工具。留了两倍余量。这些数字没有数据支撑，是拍的，面试被问到就直说"是保守估计，真实产品应该按 P95 用量定"。

**Q：`maxWallClockMs` 和 Node 的默认超时有什么区别？**
A：它管的是整个会话，不是单次 HTTP 请求。模型慢、工具慢、排队慢都算在里面。作用是给用户一个上限：再怎么卡，两分钟内一定给你一个明确结果（哪怕是"因超时中断"），不会一直转圈。

**Q：为什么 `blockedCalls` 要单独计数？**
A：因为它是诊断信号。`toolCalls` 高说明任务复杂，`blockedCalls` 高说明模型在死循环或者提示词有问题。两个数字放一起才能定位问题。混成一个数字，你就只知道"调用多"，不知道是正常的还是异常的。

**Q：参数规则为什么不直接写进 JSON Schema？**
A：Schema 只能表达"字段在不在、类型对不对"。标题是 81 个字符、时间没带时区、追问只给了一个选项，这些在 Schema 眼里全合法。也不能都推给 `store`，因为 `store` 拒绝的代价是一次数据库往返，而且它报的错是给开发者看的，不是给模型看的。规则的定位就是 Schema 和存储之间的那一层。判断标准很硬：Schema 写不出来的，才写进规则；`store` 已经会拒绝的，也不要重复。

**Q：拦下来之后模型真的会改吗？你怎么证明？**
A：规则返回的 reason 会作为 isError 的 tool_result 回到上下文，措辞里带具体改法和示例。证据有两处：smoke 第 17 段让模型第一次交不带时区的时间、第二次交带时区的，断言第一次收到 isError、第二次提案落地；评测集里 `rule-reject-then-correct` 是同一个场景的常驻用例，带 `tools.errors: 1` 和 `cards.executed: 1`，改了提示词或换了模型之后这条退步会立刻掉出来。

**Q：工具为什么是串行执行？**
A：`toolExecution: "sequential"`。行动卡和候选记忆都是写操作，并行只会让日志交错，没有性能收益。要真的并行，得先保证每个工具之间没有隐式依赖（比如 `ask_user` 和 `propose_action` 同时跑，提案可能基于还没答的问题）。串行是保守选择。