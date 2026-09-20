// Deadline 与「执行形态」的纯函数部分。
//
// 单独一个文件是为了能测：这里不碰 chrome.*，所以 test/deadline.test.cjs 可以在
// node 里直接 import 它，不开浏览器就能断言「用户代码只被包一次」这类不变式。
//
// 为什么需要 deadline 这一层：seam 两侧各写死了一个数字——server 30000ms、扩展
// 60000ms——而 60 > 30，于是任何超过 30s 的工具必然先报 "Timeout calling X"，
// 扩展还在跑，排在后面的调用一起超时。不变式是：**扩展侧放弃永远早于 server 的预算**。

export const DEADLINE_MARGIN_MS = 3000;

// 单次 javascript_tool 在页面内的硬顶。留出 CDP 往返与序列化余量，
// 同时远超正常抓取（一次十几轮滚动都在 25s 内）。
export const JS_EXEC_CAP_MS = 25000;

// 用户代码在 payload 里**只出现一次**。这条是硬约束：旧实现的 r1/r2 回退链会让
// **每次失败**的调用跑两遍，长滚动循环因此翻倍并跨过预算 —— 那正是抓小红书第 4 篇
// 超时的直接原因。形态（表达式 / 语句序列）在发出去之前就定好，见 formFromProbeError。
//
// 另外两件事也靠这个 payload 保证：
//   · 错误必定上报 —— 同步 throw 与 async rejection 都变成 {ok:false, err} 的**返回值**，
//     不再依赖 CDP 的 exceptionDetails（实测：以 rejection 结尾的片段会被 awaitPromise
//     吞成字符串 "undefined"）；
//   · 预算内必定返回 —— Promise.race 的 **resolve** 分支报超时（用 reject 会被吞）。
// 页面里没干完的活**无法取消**，所以超时文案必须说清楚，见 background.js。
export function buildEvaluateExpression(code, budgetMs, form = 'expression') {
  // ${code} 后面那个换行不是排版：用户代码若以行注释结尾（`document.title // 标题`），
  // 收尾的 `)` 或 `})()` 会被注释吞掉，两种形态一起变成语法错误。实测报出来的是
  // "Unexpected token 'catch'"—— 我那层 payload 的结构，完全看不出跟那行注释有关。
  const run = form === 'statements'
    ? `await (async () => { ${code}\n })()`
    : `await (${code}\n)`;
  return `Promise.race([
  (async () => {
    try { return { ok: true, val: ${run} }; }
    catch (e) { return { ok: false, err: String((e && e.stack) || e) }; }
  })(),
  new Promise(r => setTimeout(() => r({ ok: false, deadline: true, ran_ms: ${budgetMs} }), ${budgetMs}))
])`;
}

// 探测的结果 → 用哪种形态。
// background.js 先用 `Runtime.compileScript` 只解析不执行地探一次（语法错误连执行都没发生，
// 所以这一步不会重复劳动），再决定形态。这样两种输入都恰好跑一次 —— 而如果反过来把
// 语句序列直接塞进 `await (...)`，**整个 payload 会解析失败**，页面内的 try/catch 救不了它
// （解析先于执行）。
//
// 两个都实测过的坑：
//   · `compileScript` 把编译失败报在**结果里**（`exceptionDetails`），不是靠 reject。
//     早先只判 reject 的写法把语句序列误判成表达式，真机上直接报 "Unexpected token 'const'"。
//   · 探测手段本身不可用时（方法不存在等），保守按表达式来 —— 那是最简形态，退化最轻。
export function formFromProbe({ result, error } = {}) {
  if (error !== undefined) {
    // 只认明确的语法信号。写成 /invalid|parse/ 会误命中 'Invalid parameters' 这类与语法
    // 无关的报错，于是合法表达式被当语句跑、静默返回 undefined —— 值丢了还报不出错。
    if (/syntax ?error|unexpected/i.test(String(error))) return 'statements';
    return 'expression';
  }
  return result && result.exceptionDetails ? 'statements' : 'expression';
}

// 页面内能用的预算：信封里的剩余预算减 1s（留给 CDP 往返），再被硬顶压住。
export function budgetForJavaScript(remainingMs) {
  const left = Number.isFinite(remainingMs) ? remainingMs : JS_EXEC_CAP_MS + 1000;
  return Math.max(500, Math.min(left - 1000, JS_EXEC_CAP_MS));
}

// 把 evaluate 拿到的东西分成四类。抽出来是因为这段分支逻辑最容易写错，
// 而它决定了「调用方到底看到数据、错误，还是超时」。
export function classifyJsResult(value) {
  if (value && typeof value === 'object') {
    if (value.deadline === true && typeof value.ran_ms === 'number') {
      return { kind: 'deadline', ranMs: value.ran_ms };
    }
    if (value.ok === false) return { kind: 'error', message: String(value.err) };
    if (value.ok === true) return { kind: 'ok', value: value.val };
  }
  // 没走我们那层包装（序列化降级、老版本扩展）：按原样输出，保持旧行为。
  return { kind: 'opaque', value };
}
