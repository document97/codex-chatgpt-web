# codex-chatgpt-web 重写指导文档

状态：草案 v1（2026-09-22）。本文档是后续重构的唯一依据；代码改动必须在本文档登记后才允许动手。
范围：`src/adapters/chatgpt-web/`（传输、会话生命周期、补救回路）与 `src/responses/state.ts`（持久化）。
不在范围：Codex 桌面端自身的存储（`~/.codex` 的 sqlite 族，不属于本仓库）；浏览器 DOM 自动化的具体选择器与等待逻辑（`browser-worker.ts` 的 DOM 层维持现状）。

---

## 1. 故障复盘（为什么要重写）

2026-09-22 上午，线程 `01a0c4c9`（原始任务："接下来该编译安装包了"）中，用户连续 5 轮发出新指令
（"查询仓库中写明的支持上传的附件的文件种类" 等），模型全部无视，持续执行旧构建任务
（`where bun` → `irm bun.sh/install.ps1` → `bun install` → `./bun-baseline-1.4.0.exe run --cwd launcher package:win` → `winget install Oven-sh.Bun`）。

证据链（均已在实机核验）：

1. **Codex 桌面端无责**：rollout jsonl（`~/.codex/sessions/2026/09/22/rollout-…-01a0c4c9….jsonl` L592/600/651/673/700）
   与桥接状态文件 `responses-state.json` 条目 #9–#21 中，每轮输入末尾都有用户新消息原文。
2. **桥接进入了"全量附件"传输**：守护进程日志，查询时段四轮浏览器请求全部是
   `opened (transport=inline, maxMessageChars=6926, files=1, estimatedInputTokens=143050→147244)`，
   且每轮都执行了 `temporary_chat_preparation`（全新临时会话）。
3. **附件模式下输入框正文不含任何用户文本**：`prompt.ts:1019-1031`，正文只有传输契约加一句
   "The complete Codex task context is attached as codex-context.json. Read the entire file before acting."
   用户的新指令是 ~143k token JSON 附件里的**最后一条记录**。
4. **网页模型读不完 143k token 的附件**：其有效上下文被文件开头的老任务主导，
   模型推理摘要自证（"检查 Bun 环境以继续构建安装程序"）。
5. **放大器 A——打断即释放**：用户每轮打断 → interrupt hook → browser turn aborted → 保留会话被释放 →
   下一轮只能重新播种全量历史，附件从 143k 涨到 147k，新指令埋得更深。
6. **放大器 B——无限续跑**：每轮浏览器回复未调 `codex_turn_complete`，桥接自动发"续跑提示"
   （`requesting retained continuation 1..6`，无轮次上限，`index.ts:1002-1003` 注释自认"never a round count"），
   持续催促模型"继续当前任务"。

**根因一句话：传输设计违反了新近性原则——最新人类指令永远不应只存在于模型可能读不到的地方。**

对照：08:40 的那轮（`c98d51a62649`，22k token、内联、无附件）模型行为正常（成功写文档、改文件）。
故障只在"历史超过内联预算 → 附件模式"后出现。

---

## 2. 现有机制全清单与去留判定

按层归类。**"真实约束"一栏是保留该机制的充分理由**——重写不是删掉兜底，而是把兜底放进正确的不变量之下。
出处均为本仓库源码行号（2026-09-22 版本）。

### A. 传输限制层（实测物理边界 → 全部保留）

| 机制 | 出处 | 真实约束（实测） |
|---|---|---|
| 单条可见消息 40,000 token 上限 | `chatgpt-web-models.ts:48` | Plus 账号实测：46,410 token 被接受，48,141/81,958 被拒；估算器对 CJK 偏高 |
| 会话累计 inline 90,000 token 上限 | `chatgpt-web-models.ts:57` | 实测边界在 (93k, 158k)：新会话收下 93,482，同会话累计 ~158k 被拒 |
| Composer 字符上限（Instant 211,256 / Medium-High 1,048,572 / Pro 至 1,635,000） | `chatgpt-web-models.ts:38-39, 89-91` | 网页输入框硬边界 |
| 上下文窗口与自动压缩阈值（Instant 41k/32k，Medium-High 90k/80k，Pro ~95k/111k，Luna 1.05M，Bigger Context ×3） | `chatgpt-web-models.ts:27-37, 71-98` | 报给 Codex 的可用窗口，驱动 Codex 侧 /compact |
| 平台保留 8,192 token | `chatgpt-web-models.ts:59` | ChatGPT 产品提示词 + 工具 schema 的隐藏占用 |
| 每附件 1,024 token 预留、最多 8 个 | `chatgpt-web-models.ts:67`，`prompt.ts:184` | 实测每张压缩图占 ~1,024 composer token |
| 单个生成附件可携带 ~82k token | `chatgpt-web-models.ts:55` | 实测：附件不受 inline 会话累计边界约束 |

**判定：全部保留，数值不动。这些是测出来的物理学，不是补丁。**

### B. 传输编排层（结构重做）

| 机制 | 出处 | 触发条件 | 判定 |
|---|---|---|---|
| inline → 全量上下文附件切换 | `prompt.ts:1073-1086` | 编译后正文 >120,000 字符（`CHATGPT_INLINE_CONTEXT_ATTACHMENT_CHARS`，prompt.ts:192）或超 token 预算 | **保留切换，修内容**：附件模式下正文必须内联最新人类指令（见 R1） |
| 附件指针正文（无用户文本） | `prompt.ts:1019-1031` | 同上 | **重写**：故障点。改为"指针 + 最新指令原文" |
| 长文本段 >80,000 字符 → codex-long-text.txt | `prompt.ts:185, 887-898` | 单条消息超长 | 保留 |
| 附件配额（历史附件保留 2–4 个、8 图上限、模型自选重传 retention 协议） | `prompt.ts:184, 193-194, 912-920` | ChatGPT 每消息附件上限 | 保留（本阶段不动） |
| Bigger Context multipart（2–3 段 staging + commit，预算收敛 4 轮） | `prompt.ts:924-1007` | 显式开启 `experimentalBiggerContext` | 保留，但 commit 消息同样受 R1 约束 |
| compaction 110,000 byte 裁剪循环 | `prompt.ts:386, 1096-1118` | 压缩请求超预算 | 保留（压缩轮不注入 R1 段，见 §4.3） |

### C. 会话生命周期层（升级为核心）

| 机制 | 出处 | 作用 | 判定 |
|---|---|---|---|
| conversationKey（namespace+threadId+modelId+reasoning+compaction 纪元 的哈希） | `conversation-key.ts:29-43` | 一个 Codex 线程 ↔ 一个浏览器保留会话 | 保留 |
| resume 后缀（最后一条 assistant 之后的消息） | `conversation-key.ts:46-58` | 保留会话只接收增量 | 保留，成为默认路径 |
| resume nudge（无后缀时的"继续干活"提示） | `index.ts:386-397` | Codex resume 重放完整历史、无新内容 | 保留，但 nudge 正文也要带 R1 段 |
| instruction ledger（已送达指令版本台账；判定 resume vs edited-resubmit） | `instruction-ledger.ts`，`index.ts:560-575` | 区分"继续保留会话"与"释放后全量重播种" | 保留 |
| inline budget ledger（会话累计花费） | `inline-budget.ts` | 90k 会话边界的记账 | 保留 |
| **interrupt → 释放保留会话** | `config.toml hooks.Interrupt` → `codex-interrupt-hook.ts` → 失败路径 release | 打断后下一轮重播种 | **修改：打断不再释放**（见 §4.5，事故放大器 A） |
| healOverspentConversation（超花销 → 记满 + 释放 → 附件传输重试） | `index.ts:490-498` | 90k 边界被拒的自愈 | 保留 |

### D. 补救回路层（加上限）

| 机制 | 出处 | 现状 | 判定 |
|---|---|---|---|
| completion recovery（未调 codex_turn_complete → 自动续跑提示） | `index.ts:987-1036` | **无轮次上限**，直到 terminal / 空转 / 预算 / abort | **加轮次上限（3）**；每轮 recovery 消息带 R1 段（事故放大器 B） |
| 空转判定 isRepeatedStatus（token 重叠 ≥85% 视为原地踏步） | `index.ts:418-431` | 终止续跑的条件之一 | 保留 |
| contextBudgetExhausted → 请求可交接摘要收尾 | `index.ts:404-416` | 历史逼近窗口时停止扩展轮次 | 保留 |
| 浏览器轮重试（3 次 / 30min 预算） | `retry-policy.ts` | 可重试失败的去抖 | 保留 |

### E. 状态持久化层（替换）

| 机制 | 出处 | 现状 | 判定 |
|---|---|---|---|
| responses-state.json（previous_response_id 展开缓存） | `state.ts:5-15` | 每轮存**全量展开输入**，自注释"~quadratic bytes per chain"；1,000 条/1h TTL/64MB 内存/2s 去抖整体重写；实测已 10.7MB | **替换**：以 rollout jsonl 为唯一史源（见 R3、§4.6） |
| 四个小状态文件（ledger / budget / luna-checkpoint / thread-environment） | 各自文件 | 语义重叠，都在回答"这个会话到哪了" | **合并**为单一 per-conversation 状态文件 |
| portable-session-checkpoints（`.before-portable-*.bak` + `ocxr1:` reasoning 迁移） | `portable-session-checkpoints.ts` | 本地/桥接加密 reasoning 的往返迁移 | 保留 |
| 诊断快照（每轮 ~20 个 DOM JSON，保留最近 10 个 trace） | `browser-worker.ts:1774` | 排障用 | 保留 |

### F. 浏览器 DOM 层（维持现状）

stall 宽限 60s/180s/10s（`browser-worker.ts:115-124`）、内部观察故障上限 8（:1606）、页面重绑 2 次（:1139）、
connector 触发 3 次（:127）、UI settle 250ms（:136）、外部进度停滞上限 10min（:1616）。
这些是网页 UI 的物理特性（异步渲染、流中改块、目录刷新），**全部保留，本轮不动**。

### G. 模型路由层（本轮不动）

Luna 滚动检查点协议（marker + 五段式摘要 + 精确父答案哈希绑定，`rolling-checkpoint.ts`）、
Zero Risk 手动模式、subagent compatibility v1/v2：**本轮不动**，但 R1 对 Luna 同样生效
（Luna 每轮本来就是小载荷 + 检查点，新近性天然满足；实现时验证即可）。

---

## 3. 新架构：五条不变量

所有后续改动必须逐条对照。违反任何一条即为 bug。

- **R1 新近性（核心修复）**：当前轮最新人类指令的**原文**，必须出现在实际打进输入框的正文里，
  位于消息末尾区域，**与传输模式无关**（inline / 附件 / multipart commit / resume nudge / recovery 续跑，全部适用）。
  禁止让"模型自己去附件里找最新指令"。压缩轮（`_compactionRequest`）例外：其最终指令是 Codex 生成的压缩指令，非人类请求。
- **R2 增量优先**：一个 Codex 线程对应一个存活的保留会话；常规轮次只发送"该会话最后一条 assistant 之后的新增后缀"。
  全量历史重放仅发生在：首次播种、edited-resubmit、超花销自愈、保留会话确已丢失。
- **R3 单一史源**：对话历史的唯一权威是 Codex 自己的 rollout jsonl。桥接**不再**保存全量展开副本
  （现有 responses-state.json 的职责收缩为：response id → rollout 定位/展开结果的短期缓存，可丢、可重建）。
- **R4 契约极简且静态**：写给模型的规则行数有硬上限（目标：正文契约 ≤ 25 行），内容与轮次无关，
  不随模式膨胀。任何"解释 JSON 字段含义"的契约行，在转录式传输落地后删除。
- **R5 显式失败**：任何传输降级（inline→附件→multipart）发生时，若无法确定 R1 所需的最新人类指令，
  该轮**报错失败**，不允许静默发出一个"模型可能看不见新指令"的提示词。同理，附件模式估算超限时
  返回要求 `/compact` 的明确错误，而不是寄希望于模型读大文件。

---

## 4. 目标逻辑详设

### 4.1 每轮数据流（目标态）

```
Codex 请求到达 (/v1/responses)
  1. 解析 → parsed（含 client_metadata 的 thread_id/turn_id）
  2. 身份与预算：conversationKey = hash(namespace, threadId, modelId, reasoning, compaction 纪元)
  3. 指令分类：latestRevision = 输入中最新用户指令（复用 environment.ts 的
     latestChatGptTurnUserRevision 语义：跳过 <turn_aborted>、环境块、压缩摘要）
  4. 会话路由（查 per-conversation 状态 + instruction ledger）：
       a. 保留会话存活 且 revision 已送达过 或 revision 属于当前 turn → 续用（R2 默认路径）
       b. 保留会话存活 但 revision 是旧 turn 的未送达版本 → edited-resubmit：释放 + 全量重播种
       c. 无保留会话（首轮 / 被释放 / launcher 重启）→ 全量重播种
  5. 编译正文（§4.3）：契约(静态) + [全量转录 | 增量后缀转录] + R1 段（消息末尾）
  6. 预算与传输选择（§4.4）：估算 → inline？→ 附件？→ 超限报错要求 /compact（R5）
  7. 浏览器执行：播种新临时会话 or 复用保留会话 → 打字 → 附件 → 发送
  8. 工具回路：broker 分发 exec 调用 → 结果作为下一轮输入回填（同样走 R1：回填轮的
     R1 段 = 触发本轮工具调用的那条人类指令原文，工具结果不是人类指令）
  9. 完成判定：codex_turn_complete → 结束；
     未完成 → recovery 续跑（≤3 轮，正文带 R1 段）；空转/预算尽 → 终止
 10. 状态更新：per-conversation 记录（§4.6）+ responses 短期缓存
```

### 4.2 打断语义（修改点：事故放大器 A）

现状：用户打断 → interrupt hook → browser turn aborted → **释放保留会话** → 下一轮全量重播种。
目标：

- 打断只终止**本轮 Codex 回合**，保留会话标记 `lastGenerationAbortedAt`，**不释放**。
- 下一轮到达时：若保留会话仍在（launcher 存活），走 §4.1.4.a 续用路径，只发新后缀——
  新指令直接出现在保留会话里，天然满足 R1 且载荷最小。
- 释放仅发生于：edited-resubmit、超花销自愈、launcher 报告会话已消失、压缩纪元变更。
- 风险与对策：被打断的网页生成可能仍在后台跑。现有 `waitForNewAssistantTurn` 已按
  baseline 区分新旧回合；新增约束：续用时若检测到上一生成仍在 running，等待其完成或
  超时后才发送（复用现有 60s stall 宽限，不新增机制）。

### 4.3 传输格式

**保留 JSON 信封（本阶段）**，但正文结构统一为四段、顺序固定：

```
[1] 静态契约（≤25 行：身份、角色语义、工具规则、完成规则——从现 sharedContract+transportContract 收敛）
[2] 任务上下文：三选一
    - inline: <codex_context_json>{version,system,messages}</codex_context_json>（现状格式）
    - 附件:   <codex_context_attachment>…指针说明…</codex_context_attachment> + codex-context.json
    - 增量:   <codex_context_json> 只含后缀消息（R2 路径，格式同 inline）
[3] R1 段（除压缩轮外必出现）：
    <codex_latest_user_request>
    The verbatim latest human request of the active Codex turn. It is authoritative
    even if the task context above is truncated or attached:
    {原文，>8,000 字符时截断并注明完整版在上下文中}
    </codex_latest_user_request>
[4] 行动指令（1–3 行，现有的 codex_transport_resume 收敛）
```

要点：
- R1 段位于正文**最末**（新近性最大化），行动指令紧邻其上。
- R1 段取值逻辑：`parsed.context.messages` 中最后一条 role=user、非空、不以
  `<turn_aborted>`/`<environment_context>`/`<recommended_plugins>` 开头、非压缩摘要的文本
  （复用 `environment.ts` 的判定语义，压缩轮跳过）。
- multipart commit 消息同样以 R1 段收尾（staging 段不需要）。
- 后续阶段（Phase 3）将 [2] 的 JSON 信封替换为对话转录（`### User/…/### Assistant/…`），
  届时删除角色解释类契约行——该阶段单独立项、默认关闭、A/B 验证后再默认开启。

### 4.4 传输选择决策树

```
估算本轮正文（含 R1 段与附件预留）:
  ├─ ≤ 内联预算(40k token/会话余量，字符上限取小) → inline 单消息
  ├─ 超内联 but ≤ 附件可承载（全量 ≤ ~82k token 附件 + 指针正文）→ 附件模式（R1 段仍内联）
  ├─ 超附件承载:
  │    ├─ Bigger Context 开启 → multipart（R1 段进 commit）
  │    └─ 否则 → 报错："context_length_exceeded，请 /compact"（R5，禁止静默截断）
  └─ 任何模式下 R1 段本身超 8,000 字符 → 截断 R1 段（原文仍在上下文里），不报错
```

### 4.5 补救回路的边界（修改点：事故放大器 B）

- recovery 续跑：同一 browser turn 最多 **3** 轮（现状无上限）。到顶仍未 terminal →
  以最后一轮文本收尾并在结果里标注未显式完成。
- 每轮 recovery 正文 = 静态契约（短）+ R1 段 + 一行"continue the unfinished work"。
  禁止无 R1 段的裸 nudge。
- 空转判定（85% 重叠）与 contextBudgetExhausted 交接维持现状。

### 4.6 状态模型（替换 responses-state.json）

单一文件 `conversations.jsonl`（追加写、损坏即重建，Cline 式），每行一条 per-conversation 记录：

```json
{"key":"<conversationKey>","threadId":"…","modelId":"…","reasoning":"high","compactionEpoch":null,
 "state":"retained","lastDeliveredRevisionId":"<sha256>","lastAssistantAnswerHash":"<sha256>",
 "inlineSpendTokens":52310,"updatedAt":1790040578799}
```

- 该记录合并现 instruction-ledger、inline-budget、（Sol 路径下的）thread-environment 的职责。
  Luna 检查点存储本阶段独立保留。
- `responses-state.json` 职责收缩：仅存 response id → 已展开 input 的映射（previous_response_id
  展开），条目 TTL 缩短到单回合生命周期；**丢失后的回退路径 = 从 rollout jsonl 重放重建**
  （`codex-rollout-environment.ts` 已具备按 threadId 定位与解析 rollout 的能力，扩展其复用）。
  尺寸上限随之从 64MB 降到 8MB 量级；quadratic 增长随"不再存全量展开"消失。
- 迁移：启动时读旧 responses-state.json 一次，仅提取可映射到 conversation 记录的字段后不再写旧格式。

---

## 5. 分阶段实施计划

每阶段独立可回滚（git 一次 revert），改动前在本文档登记，改完后跑 §6 验证。

| 阶段 | 内容 | 涉及文件 | 落实的不变量 |
|---|---|---|---|
| **P1** | R1 段落地：inline/附件/multipart-commit/nudge/recovery 五处正文统一追加 `<codex_latest_user_request>`；静态截断 8,000 字符 | `prompt.ts`、`index.ts`（nudge/recovery 编译点）、`tests/prompt-contract.test.ts` 新增用例 | R1 |
| **P2** | 打断不释放保留会话；recovery 轮次上限 3；续用前等待残留生成 | `index.ts`、`codex-interrupt-hook.ts`、`tests/instruction-ledger.test.ts` 等 | R1、R2 |
| **P3** | 转录式上下文格式（flag `transcriptTransport`，默认关）+ 契约收敛 ≤25 行 | `prompt.ts`、`tests/prompt-contract.test.ts` | R4 |
| **P4** | `conversations.jsonl` 合并四状态；responses-state 收缩为短期缓存 + rollout 重放回退 | `state.ts`、`instruction-ledger.ts`、`inline-budget.ts`、`thread-environment.ts`、`index.ts` | R3 |
| **P5** | 超限显式报错路径（附件估算超载 → context_length_exceeded 而非静默） | `prompt.ts`、`browser-worker.ts` 预检 | R5 |

顺序有依赖：P1 立即止血（对应本次故障）；P2 消除两个放大器；P3/P4 是结构性简化；P5 收尾。
**P1 与 P2 完成后即可发一个补丁版本**（5.0.9），P3–P5 作为 5.1.0。

---

## 6. 验证计划

1. **单元/契约**：`bun test ./tests`（57 个测试文件全绿）；P1 新增用例至少覆盖：
   - 附件模式正文含最新用户请求原文且以 R1 段结尾；
   - inline 模式同样含 R1 段；
   - `<turn_aborted>`/环境块/压缩摘要不被误选为"最新人类指令"；
   - 超长指令截断到 8,000 字符且带注明；
   - 压缩轮不出现 R1 段。
2. **故障复现（手工）**：构造 >120k 字符历史的线程，发出与旧任务无关的新指令，
   断言（i）日志中该轮 `opened` 行的 maxMessageChars 包含新指令增量；
   （ii）浏览器输入框正文（诊断快照 17-send-ready 的 composer textChars）反映 R1 段存在；
   （iii）模型行为转向新指令。
3. **冒烟**：`bun run smoke:codex`、`smoke:cancel`、`smoke:interrupt`、`smoke:subagents`。
4. **类型**：`bun run typecheck`。

## 7. 非目标（明确不做）

- 不改 Codex 桌面端的 sqlite/WAL 存储（不属于本仓库）。
- 不动 §A 的任何实测常数。
- 不重写 `browser-worker.ts` 的 DOM 自动化与等待策略（§F）。
- 不动 Luna 检查点协议与 Zero Risk 模式的内部实现（仅验证 R1 对其成立）。
- 本轮不引入新的配置项（P3 的 flag 除外）。


---

## 8. 实施登记（2026-09-22 执行）

执行分支：`feat/measured-context-budgets`（基线 v5.0.8 + 工作区已有的 P1/P2 部分改动）。

| 阶段 | 登记内容 | 状态 |
|---|---|---|
| P1 | `prompt.ts`：R1 选择器跳过压缩摘要（`isReadableCompactionSummaryText`）；导出 `chatGptLatestUserRequestText`/`chatGptLatestUserRequestLines`；新增编译选项 `latestUserRequest`（override/suppress）；附件降级时 R1 缺失 -> 报错（R5 前半）。`index.ts`：resume nudge 与 recovery 续跑正文携带 R1 段（取全量历史的最新人类指令）。`tests/prompt-contract.test.ts` 新增 6 个用例。 | 已完成 |
| P2 | `browser-worker.ts`：aborted 且 `retainConversation` 时 end 通知带 retain；续用时若 lease 标记 `lastGenerationAbortedAt` 则先等残留生成收尾（60s 宽限）。`launcher/electron/browser-host.cjs`：endTurn 支持 aborted+retain（标记 lastGenerationAbortedAt），beginTurn 租约返回该标记。`launcher-browser-host.ts`：租约类型扩展。`index.ts`：recovery 上限注释与日志。 | 已完成（合入 023b3eb） |
| P3 | `types.ts`/`config.ts`/`prompt.ts`/`index.ts`：`transcriptTransport` flag（默认关）；转录式 `<codex_context_transcript>` 渲染 + 契约收敛 <=25 行。 | 已完成（合入 023b3eb） |
| P4 | 新增 `conversation-state.ts`（conversations.jsonl，追加写、损坏即重建，合并 instruction-ledger/inline-budget/thread-environment，启动迁移旧文件）；`state.ts` 收缩（链式存储去平方增长、8MB 上限、rollout 重放回退）；`codex-rollout-environment.ts` 导出 rollout 重放。 | 已完成（合入 93b0a57） |
| P5 | `prompt.ts`：附件载荷估算超 ~82k token 容量 -> context_length_exceeded 明确要求 /compact（R5 后半）。 | 已完成（合入 93b0a57） |

**验证结果（§6）**：`bun test ./tests` 全套件 775 测试 / 773 通过（2 个失败为 Windows 符号链接 EPERM 环境问题，预存、与本改动无关）；`bun run typecheck` 通过；launcher 侧 `bun test` 103 通过。`smoke:*` 脚本需实机 Codex 桌面端 + 已登录 ChatGPT 会话，本执行环境不可跑，列为发布前手工步骤。


| P1+P2+P3 | 提交 023b3eb（994 行）：R1 五处落地 + 打断不释放 + recovery 上限 + transcriptTransport flag（默认关）。全套件 767 测试零失败。 | 已完成 |
| P4 | `conversation-state.ts`（新建，conversations.jsonl 追加写/损坏即重建/限界压缩，路径 memo 化共享，启动时一次性迁移旧三文件）；`instruction-ledger.ts`/`inline-budget.ts` 删除，语义并入 `ChatGptConversationState`；`thread-environment.ts` 类 API 不变、存储改为 JSONL；`state.ts` 改为链式存储（线性字节）、8MB 上限、30min TTL 带链父保护、展开丢失时 rollout jsonl 重放回退（尾部匹配才生效）。 | 已完成 |
| P5 | `chatgpt-web-models.ts` 新增 `CHATGPT_WEB_CONTEXT_ATTACHMENT_TOKEN_LIMIT = 82_000`（实测 82,337 命名常数，未改动既有常数）；附件载荷估算超限 -> 413 `context_length_exceeded` 明确要求 /compact，非压缩轮生效。 | 已完成 |
| P6（补丁，2026-09-22） | 本地文件路径附件与上传拒绝降级。`prompt.ts`：用户消息中独立成行的本地绝对路径 -> 探测文件系统，存在且扩展名受支持则作为真实附件上传（`localPathLine`/`localFileAttachment`/`localPathKey`/`userTextLocalAttachmentRecords`；与结构化附件共用配额管线；同消息内同路径去重、跨消息以最新提及为准；`<environment_context>`/`<turn_aborted>`/`<recommended_plugins>` 脚手架消息不挖掘路径；multipart staging 信封保持精确故禁用，压缩/全量上下文传输仍携带）；不受支持或不可读 -> 正文 skip notice（不静默）。`ACCEPTED_FILE_EXTENSIONS` 扩展至音频/视频及更多文本类型并同步 MIME 表；契约新增 Workspace semantics 行（本地工具产物 = 用户机器上的本地绝对路径文件，非 ChatGPT 云端工件）。`browser-worker.ts`：`attachFiles` 改 `Promise.allSettled` 等待附件 chip，未出现者视为被 ChatGPT 拒收 -> 收集 `[role=alert]` 原因、保留已接受附件继续回合，经 `onRejected` 回调输出用户可见提示；全部拒收且消息始终不可发送 -> 显式抛 `chatGptAttachmentRejectedError`（R5）。`index.ts`：recovery 第 2 轮起（`priorCompletionAttempt`）提示 codex_turn_complete 可能被 OpenAI 安全审查拦截/不可用，禁止继续重试受阻工具，改以纯文本输出最终答案（桥接自动收尾）；预算耗尽轮维持交接摘要逻辑；auto-completion 拒绝错误消息补充拦截/工具不可用/回合已提交的可能原因。`mcp-server.ts`：`codex_turn_complete` broker 拒绝时包装为可操作建议（改用纯文本回答）。`tests/prompt-contract.test.ts` +9 用例（4 个 R5 recovery + 5 个 local file）。不变量对照：R1（recovery 每轮仍携带最新人类指令段）、R5（附件全拒/工具拦截均显式失败而非静默）。验证：全套件 784 测试 / 782 通过（2 个预存 Windows symlink EPERM 环境问题，与本改动无关），`tsc --noEmit` 通过。 | 已完成 |
| P7（补丁，2026-09-23） | 修复 Codex ≥0.155（openai/codex PR #22268）Interrupt hook payload 语义变更导致的"停止按钮 → 桥接中断"联动失效。根因：payload 的 `session_id` 改为 hooks 专属的根会话共享身份（不再等于 thread id），且 payload 不再携带 `thread_id`/`metadata`；桥接身份只可能来自请求元数据（`extractCodexTurnIdentityFromBody`），而 hook 侧永远拿不到它——因此原四处 `threadId ∧ turnId` 严格相等匹配自 0.155 起必然零命中，且成功/失败均无日志。修复：`turn_id`（Codex `turn_context.sub_id`，与请求元数据 `metadata.turn_id` 同源同值、全局唯一，已经 rollout jsonl 交叉校验）升级为唯一匹配主键，threadId 降级为诊断日志字段。落点：`turn-execution.ts` `cancelNativeTurn`（含 thread 身份不一致时的 info 日志）；`compaction-handoff.ts` `cancelStructuredCompactionNativeTurn` 匹配与中断竞态记忆键改为 turnId 单键；`server.ts` `HttpTurnCounter` 的 `beginCancelTurn` 匹配与 `rememberInterrupted` 迟到绑定键改为 turnId 单键（修复 hook 先行、请求后到的竞态在 0.155 下永不生效的问题）。P-OBS-2 观测性：`/admin/interrupt-turn` 打三路取消计数 info 日志，三路全零且仍有活跃 turn 时打 warning；`/admin/cancel-turns` 打取消计数 info 日志。向后兼容：旧版 Codex（payload `session_id == thread_id`）下 turnId 匹配行为不变。已知限制登记（P-DOC-4）：Stop 与轮次收尾竞速时 Codex 可能不派发 Interrupt hook（2026-09-23 实证），残余网页生成由 `waitForResidualGeneration` 60s 宽限吸收；hook 进程启动失败由 Codex 端 `NonBlockingHookFailed` 事件兜底，桥接无法感知。测试：hook 契约测试（`session_id ≠ thread_id` 仍同时取消 browser/http 两路）、HttpTurnCounter 在飞取消与迟到绑定记忆的 turnId 单键回归、结构化 compaction 活跃取消与中断记忆跨 thread 身份命中、不完整身份校验收敛为仅要求非空 turnId、共享 turn_id 视为同一轮（旧"同 turn 不同 thread 不取消"断言按新契约改写）。验证：全套件 788 测试 / 786 通过（2 个失败为预存 Windows symlink EPERM 环境问题，与本改动无关），`tsc --noEmit` 通过；`smoke:interrupt` 需实机 Codex + 已登录 ChatGPT，列为发布前手工步骤。 | 已完成 |

