#!/usr/bin/env node
// server 侧预算表的边界测试。零依赖。
// 跑法：node test/budget.test.cjs   （退出码 0 = 全过）
//
// 为什么值得留着：budgetFor 的两处边界只有「客户端不守 schema」时才踩到，人工审不出来，
// 而踩到的后果是 server 秒弃 + 扩展留下孤儿占着 FIFO —— 正是这次改造要消灭的形态。
// 这里既锁边界行为，也锁两条跨工具的不变式（见文件末尾）。

const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0;
const failures = [];

function t(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`✗ ${name}`); }
}

(async () => {
  const { budgetFor, TOOL_BUDGET_MS, DEFAULT_TOOL_BUDGET_MS, DEADLINE_MARGIN_MS, QUEUE_ALLOWANCE_MS } =
    await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'budget.js')).href);

  // --- 基本查表 -------------------------------------------------------------
  t('表里的工具取表值', budgetFor('javascript_tool') === 45000 && budgetFor('tabs_context') === 10000);
  t('表外的工具取默认值', budgetFor('no_such_tool') === DEFAULT_TOOL_BUDGET_MS);
  t('health_check 是 15s（不再被调用点写死成 8s）', budgetFor('health_check') === 15000);

  // --- 原型链边界 -----------------------------------------------------------
  t("'constructor' 不会命中原型上的函数", budgetFor('constructor') === DEFAULT_TOOL_BUDGET_MS);
  t("'toString' / 'hasOwnProperty' 同理",
    budgetFor('toString') === DEFAULT_TOOL_BUDGET_MS && budgetFor('hasOwnProperty') === DEFAULT_TOOL_BUDGET_MS);
  t("'__proto__' 同理", budgetFor('__proto__') === DEFAULT_TOOL_BUDGET_MS);

  // --- wait_for 的数值边界 --------------------------------------------------
  t('wait_for：正常值 = 参数 + 5s 余量', budgetFor('wait_for', { timeout: 3000 }) === 8000);
  t('wait_for：schema 上限 30000 → 35000', budgetFor('wait_for', { timeout: 30000 }) === 35000);
  t('wait_for：不给参数 → 默认 10s + 5s', budgetFor('wait_for', {}) === 15000);
  t('wait_for：非数值字符串不再变成 NaN', budgetFor('wait_for', { timeout: 'abc' }) === 15000);
  t('wait_for：数字字符串按数字算', budgetFor('wait_for', { timeout: '3000' }) === 8000);
  t('wait_for：小于下限被抬到 500', budgetFor('wait_for', { timeout: -5 }) === 5500);
  t('wait_for：超过上限被压到 30000', budgetFor('wait_for', { timeout: 999999 }) === 35000);
  t('wait_for：Infinity / NaN 都退回默认', budgetFor('wait_for', { timeout: Infinity }) === 15000 &&
    budgetFor('wait_for', { timeout: NaN }) === 15000);

  // --- 扫一遍脏输入：任何组合都必须得到有限正数 ------------------------------
  const junk = [undefined, null, NaN, Infinity, -Infinity, {}, [], true, 'abc', 0, -1, 1e18];
  const bad = [];
  for (const j of junk) {
    const v = budgetFor('wait_for', { timeout: j });
    if (!Number.isFinite(v) || v <= 0) bad.push(String(j) + '→' + v);
  }
  t('wait_for 对任意脏输入都返回有限正数（NaN 会让 setTimeout 立刻触发）',
    bad.length === 0, bad.join(', '));

  // --- 跨工具不变式 ---------------------------------------------------------
  const budgets = Object.values(TOOL_BUDGET_MS);
  t('每个工具的 deadline 都还是正数（预算 > DEADLINE_MARGIN_MS）',
    budgets.every(b => b > DEADLINE_MARGIN_MS));
  t('每个工具都在 Claude Code 转后台的门槛以内（预算 < 60s）',
    budgets.every(b => b < 60000));
  t('wait_for 的最大预算也在 60s 以内', budgetFor('wait_for', { timeout: 30000 }) < 60000);
  t('排队余量是正数', QUEUE_ALLOWANCE_MS > 0);

  // --- 汇总 ---------------------------------------------------------------
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\n失败详情：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
