#!/usr/bin/env node
// action-resolver 的回归测试。
//
// 无依赖：手搓一个最小 DOM 桩喂给内容脚本，断言 resolve() 的三种状态。
// 跑法：node test/action-resolver.test.cjs   （退出码 0 = 全过）
//
// 为什么值得留着：解析器的两个 bug（歧义时打印 undefined、歧义只给数字
// 不给候选）都是第一次真跑才暴露的，而这个文件能在不开浏览器的情况下
// 立刻告诉你有没有改坏。

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'extension', 'content-scripts', 'action-resolver.js');
const code = fs.readFileSync(SRC, 'utf8');

// --- 最小 DOM 桩 ------------------------------------------------------------
// 内容脚本只通过 __ccAccessibilityTree 这一组函数看页面，所以桩只需要
// 提供这几个函数 + 一棵 children 树。刻意不引入 jsdom。
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox',
  'radio', 'menuitem', 'tab',
]);

function el(o) {
  return {
    _role: o.role,
    _name: o.name || '',
    _visible: o.visible !== false,
    _ref: o.ref,
    tagName: o.tag || 'BUTTON',
    type: o.type,
    value: o.value,
    disabled: !!o.disabled,
    textContent: o.text != null ? o.text : (o.name || ''),
    children: o.children || [],
    shadowRoot: undefined,
    getBoundingClientRect: () => ({ top: o.y || 0, left: o.x || 0, width: 10, height: 10 }),
  };
}

let refSeq = 1;
globalThis.__ccAccessibilityTree = {
  isVisible: e => e._visible,
  getRole: e => e._role,
  isInteractive: e => INTERACTIVE.has(e._role),
  getAccessibleName: e => e._name,
  getRefForElement: e => {
    if (!e._ref) e._ref = 'ref_' + String(refSeq++).padStart(3, '0');
    return e._ref;
  },
};
globalThis.location = { href: 'https://example.com/x' };
globalThis.document = {
  title: 'T',
  body: el({
    role: '',
    children: [
      el({ role: 'link', name: '¥180 站票', ref: 'ref_A', y: 10 }),
      el({ role: 'link', name: '¥560 坐票', ref: 'ref_B', y: 20 }),
      el({ role: 'link', name: '¥320 站票', ref: 'ref_C', y: 30 }),
      el({ role: 'searchbox', name: '搜索', ref: 'ref_S' }),
      el({ role: 'button', name: '登录', ref: 'ref_L', disabled: true }),
      el({ role: 'button', name: '隐藏按钮', ref: 'ref_H', visible: false }),
    ],
  }),
};

new Function(code)();
const R = globalThis.__ccActionResolver;

// --- 断言 -------------------------------------------------------------------
let pass = 0;
const failures = [];

function t(name, spec, check) {
  let r;
  try {
    r = R.resolve({ actions: spec }).results[0];
  } catch (e) {
    failures.push(`${name} — 抛出异常: ${e.message}`);
    console.log(`FAIL  ${name}  →  threw ${e.message}`);
    return;
  }
  const ok = check(r);
  if (ok) pass++;
  else failures.push(`${name} — ${JSON.stringify({ status: r.status, ref: r.ref, label: r.label, note: r.note })}`);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}  →  ` +
    JSON.stringify({ status: r.status, ref: r.ref, label: r.label, note: r.note })
  );
}

t('唯一命中', [{ name: 's', role: 'searchbox' }],
  r => r.status === 'resolved' && r.ref === 'ref_S');

t('零命中 = missing（不是空表）', [{ name: 'x', role: 'textbox', name_contains: '不存在的' }],
  r => r.status === 'missing' && r.candidates === 0);

t('多候选无 pick = ambiguous', [{ name: 't', role: 'link' }],
  r => r.status === 'ambiguous' && r.candidates === 3);

t('pick=min 选最便宜', [{ name: 't', role: 'link', text_matches: '¥\\d+', pick: 'min' }],
  r => r.status === 'resolved' && r.ref === 'ref_A');

t('pick=max 选最贵', [{ name: 't', role: 'link', text_matches: '¥\\d+', pick: 'max' }],
  r => r.status === 'resolved' && r.ref === 'ref_B');

t('pick=top 按页面位置', [{ name: 't', role: 'link', pick: 'top' }],
  r => r.ref === 'ref_A');

t('pick=min 但解析不出数字 = ambiguous', [{ name: 't', role: 'link', pick: 'min', pick_from: 'ZZZ(\\d+)' }],
  r => r.status === 'ambiguous' && /没有候选/.test(r.note || ''));

t('disabled 默认排除', [{ name: 'b', role: 'button', name_contains: '登录' }],
  r => r.status === 'missing');

t('include_disabled 可见', [{ name: 'b', role: 'button', name_contains: '登录', include_disabled: true }],
  r => r.status === 'resolved' && r.ref === 'ref_L');

t('隐藏元素不扫', [{ name: 'h', role: 'button', name_contains: '隐藏' }],
  r => r.status === 'missing');

t('resolved 时带 alternatives', [{ name: 't', role: 'link', pick: 'min', text_matches: '¥\\d+' }],
  r => Array.isArray(r.alternatives) && r.alternatives.length === 2);

// 下面两条盯的是「歧义时打印 [undefined] undefined "undefined"」那个 bug：
// 歧义分支没有选中元素，所以调用方只能靠 status 判断，不能读 ref。
t('ambiguous 也返回候选样本（光给数字没法行动）', [{ name: 't', role: 'link' }],
  r => r.status === 'ambiguous' && Array.isArray(r.alternatives) && r.alternatives.length > 0);

t('ambiguous 的候选带 ref 和 label', [{ name: 't', role: 'link' }],
  r => r.alternatives.every(x => x.ref && x.label));

t('ambiguous 时不返回 ref/role/label', [{ name: 't', role: 'link' }],
  r => r.ref === undefined && r.role === undefined && r.label === undefined);

// --- 汇总 -------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failures.length ? 1 : 0);
