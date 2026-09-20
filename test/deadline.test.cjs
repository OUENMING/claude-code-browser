#!/usr/bin/env node
// deadline 纯函数的回归测试。零依赖。
// 跑法：node test/deadline.test.cjs   （退出码 0 = 全过）
//
// 为什么值得留着：这里锁住的三条不变式各自对应一次真实故障——
//   1. 用户代码在 payload 里只出现一次（旧实现的 r1/r2 回退链让**每次失败**都跑两遍，
//      长滚动循环因此翻倍并跨过 30s 预算）
//   2. 超时走 Promise 的 resolve 分支（用 reject 会被 CDP 的 awaitPromise 吞掉，
//      调用方只看到字符串 "undefined" —— 实测）
//   3. 数据 / 错误 / 超时三态能被区分出来，且形态探测失败时保守退化（旧实现失败只返回 "undefined"）

const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0;
const failures = [];

function t(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`✗ ${name}`); }
}

(async () => {
  const { buildEvaluateExpression, budgetForJavaScript, classifyJsResult, formFromProbe, JS_EXEC_CAP_MS, DEADLINE_MARGIN_MS } =
    await import(pathToFileURL(path.join(__dirname, '..', 'extension', 'deadline.js')).href);

  // --- buildEvaluateExpression ----------------------------------------------
  const expr = buildEvaluateExpression('document.title', 5000);
  const stmts = buildEvaluateExpression('const a = 1; return a', 5000, 'statements');

  t('拼出来的是合法 JS 表达式（不用浏览器就能验语法）', (() => {
    try { new Function(`return ${expr}`); return true; } catch (e) { return false; }
  })());

  t('语句形态也是合法 JS 表达式', (() => {
    try { new Function(`return ${stmts}`); return true; } catch (e) { return false; }
  })());

  t('表达式形态：用户代码只出现一次（旧实现每次失败都跑两遍）',
    (expr.split('document.title').length - 1) === 1,
    `出现 ${expr.split('document.title').length - 1} 次`);

  t('语句形态：用户代码也只出现一次 (旧实现这条路径必跑两遍)',
    (stmts.split('const a = 1; return a').length - 1) === 1,
    `出现 ${stmts.split('const a = 1; return a').length - 1} 次`);

  t('表达式形态按表达式跑', expr.includes('await (document.title)'));
  t('语句形态包进 async IIFE，所以 return 与顶层 await 都能用',
    stmts.includes('await (async () => { const a = 1; return a })()'));

  t('超时走 resolve 分支——reject 会被 awaitPromise 吞成 undefined',
    /new Promise\(r => setTimeout\(\(\) => r\(\{ ok: false, deadline: true/.test(expr));

  t('超时分支报出实际跑掉的毫秒数', expr.includes('ran_ms: 5000'));

  t('预算被写进 race 的定时器', expr.includes('}), 5000))'));

  t('表达式里没有 eval（不依赖站点 CSP）', !expr.includes('eval('));

  t('同步 throw 与 async rejection 都变成 {ok:false, err} 返回值（而非依赖 exceptionDetails）',
    expr.includes('ok: false, err: String((e && e.stack) || e)'));

  // --- formFromProbe ------------------------------------------------------
  t('compileScript 把编译失败报在结果里 → 语句序列（真机上踩过：只判 reject 会误判）',
    formFromProbe({ result: { exceptionDetails: { text: "Uncaught SyntaxError: Unexpected token 'const'" } } }) === 'statements');
  t('编译成功 → 表达式', formFromProbe({ result: { scriptId: '42' } }) === 'expression');
  t('结果为空也不崩', formFromProbe({ result: undefined }) === 'expression');
  t('compileScript 不可用（reject）→ 退回表达式形态', formFromProbe({ error: "'Runtime.compileScript' wasn't found" }) === 'expression');
  t('reject 里是语法错误 → 语句序列', formFromProbe({ error: "Uncaught SyntaxError: Unexpected token 'const'" }) === 'statements');
  t('认出其它的 reject 也不崩', formFromProbe({ error: 'Target closed' }) === 'expression');
  t('无参数也不崩', formFromProbe() === 'expression');

  // --- budgetForJavaScript --------------------------------------------------
  t('页面内预算被硬顶压住', budgetForJavaScript(42000) === JS_EXEC_CAP_MS);
  t('预算不够时跟着剩余预算走', budgetForJavaScript(10000) === 9000);
  t('剩余预算几乎为零时不返回负数', budgetForJavaScript(800) === 500);
  t('没有信封（Infinity）时按硬顶算', budgetForJavaScript(Infinity) === JS_EXEC_CAP_MS);
  t('硬顶低于 server 预算，留出往返余量', JS_EXEC_CAP_MS < 45000 - DEADLINE_MARGIN_MS);

  // --- classifyJsResult ----------------------------------------------------
  const okR = classifyJsResult({ ok: true, val: 'hello' });
  t('成功：取出值', okR.kind === 'ok' && okR.value === 'hello');

  const okUndef = classifyJsResult({ ok: true, val: undefined });
  t('成功但值是 undefined：仍是 ok（保持旧的 "undefined" 输出，不当错误）',
    okUndef.kind === 'ok' && okUndef.value === undefined);

  const errR = classifyJsResult({ ok: false, err: 'boom' });
  t('失败：报出原因', errR.kind === 'error' && errR.message === 'boom');

  const dlR = classifyJsResult({ ok: false, deadline: true, ran_ms: 25000 });
  t('超时：报出跑掉的时间', dlR.kind === 'deadline' && dlR.ranMs === 25000);

  t('恰好是 ok:false 但没有 err 也不会崩', classifyJsResult({ ok: false }).kind === 'error');
  t('裸 deadline 标记（缺 ran_ms）不会被误判成超时',
    classifyJsResult({ deadline: true }).kind === 'opaque');
  t('用户自己返回 {deadline:true} 不会被误判（它在 val 里，不在顶层）',
    classifyJsResult({ ok: true, val: { deadline: true, ran_ms: 1 } }).kind === 'ok');
  t('没走包装的值原样输出', classifyJsResult('plain').kind === 'opaque');
  t('undefined 原样输出', classifyJsResult(undefined).kind === 'opaque');

  // --- 汇总 ---------------------------------------------------------------
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\n失败详情：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
