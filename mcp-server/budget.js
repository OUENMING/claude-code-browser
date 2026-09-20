// server 侧的调用预算。
//
// 单独成文件是为了能测（test/budget.test.cjs）：这里的两处边界都只在「客户端不守 schema」
// 时才踩到（timeout 传个非数值、或拿 'constructor' 当工具名），人工审不出来，而后果很脏——
// server 秒弃、扩展留下孤儿继续占着 FIFO，正是 2026-09-20 那次改造要消灭的形态。
//
// 它和扩展侧是一对：这里的预算减 DEADLINE_MARGIN_MS 才是随信封发出去的 `deadline`，
// 而 server 自己的计时器还要再加 QUEUE_ALLOWANCE_MS。两侧一起改才成立。

export const DEADLINE_MARGIN_MS = 3000;

// server 的计时器多等的时间。它是「扩展还活着吗」的存活界，**不是**调度策略：扩展要等
// 前一个工具跑完才能开口报 queued，而排队时间不计入它自己的执行预算。给短预算的工具
// （tabs_context 10s）留出这一段，否则它排在长工具后面会死在传输层。
// 残留风险：队列里叠了两个长工具时仍可能传输层超时——那要等 job/队列协议才能根治。
export const QUEUE_ALLOWANCE_MS = 20000;

// 上限：Claude Code 会把超过 2 分钟的调用转到后台，再长就不该指望一次调用跑完。
export const DEFAULT_TOOL_BUDGET_MS = 30000;

export const TOOL_BUDGET_MS = {
  navigate: 20000,
  read_page: 45000,
  get_page_text: 45000,
  get_page_markdown: 45000,
  computer: 45000,
  javascript_tool: 45000,
  // 逐跳探链路：注入探针自身上限 8s，加上可能的注入再 8s，15s 的预算（deadline 12s）
  // 刚好容得下；以前这里被调用点写死的 8000 短路，deadline 只剩 5s，比扩展自己的探针
  // 上限还短——诊断工具反而先报超时。
  health_check: 15000,
  tabs_context: 10000,
  tabs_create: 10000,
};

// wait_for 的 timeout 在 schema 里声明为 [500, 30000]，这里按同一区间归一化。
const WAIT_FOR_MIN_MS = 500;
const WAIT_FOR_MAX_MS = 30000;
const WAIT_FOR_DEFAULT_MS = 10000;
const WAIT_FOR_MARGIN_MS = 5000;

export function budgetFor(tool, args) {
  // wait_for 自带 timeout 参数：预算必须比它大，否则它必然先撞上传送超时。
  // args 来自客户端，不能假定它守那份 schema（CallToolRequestSchema 只校验 name/arguments）：
  // 传 "abc" 会让 `+ 5000` 退化成字符串拼接 → Math.min 得到 NaN → setTimeout(fn, NaN)
  // 立刻触发。上限 35000，仍在 60000 以内。
  if (tool === 'wait_for') {
    const n = Number(args?.timeout);
    const ms = Number.isFinite(n)
      ? Math.min(Math.max(n, WAIT_FOR_MIN_MS), WAIT_FOR_MAX_MS)
      : WAIT_FOR_DEFAULT_MS;
    return ms + WAIT_FOR_MARGIN_MS;
  }
  // 自身属性判定：`TOOL_BUDGET_MS[tool]` 对 'constructor'/'toString' 会命中原型上的函数，
  // 预算于是变成函数对象、`+ QUEUE_ALLOWANCE_MS` 退化成字符串拼接。
  return Object.prototype.hasOwnProperty.call(TOOL_BUDGET_MS, tool)
    ? TOOL_BUDGET_MS[tool]
    : DEFAULT_TOOL_BUDGET_MS;
}
