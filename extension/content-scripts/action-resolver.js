(function() {
  if (globalThis.__ccActionResolver) return;

  // A page exposes generic primitives (click / type / ref). Turning "点击下一个
  // 活动的最便宜票档" into `computer(left_click, ref)` then means guessing from a
  // flat element list. This module inverts that: the caller declares named
  // actions, resolution is deterministic, and a miss is reported as a miss
  // instead of an empty list the caller can mistake for "nothing to do".
  //
  // Read-only by design — it hands back refs, never acts on them.

  const MAX_SCAN = 4000;        // visible interactive elements examined per call
  const MAX_ALTERNATIVES = 4;   // refs allocated for non-chosen candidates
  const PICK_MODES = new Set(['first', 'last', 'top', 'min', 'max']);

  function norm(s) {
    return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function safeRe(pattern, flags) {
    try { return new RegExp(pattern, flags || 'i'); } catch { return null; }
  }

  function labelOf(e) {
    return (e.name || e.text || e.role || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  // One pass over the live DOM, keeping only visible interactive elements.
  // Deliberately narrower than __ccBridge.searchElements, which walks every
  // element in document.body — including collapsed menus and footer chrome that
  // the caller's spec was never meant to reach.
  function scan() {
    const T = globalThis.__ccAccessibilityTree;
    if (!T) return { els: [], truncated: false };
    const out = [];
    const seen = new Set();
    let truncated = false;

    function walk(el) {
      if (out.length >= MAX_SCAN) { truncated = true; return; }
      if (!T.isVisible(el)) return;
      const role = T.getRole(el);
      if (role && T.isInteractive(el) && !seen.has(el)) {
        seen.add(el);
        const rect = el.getBoundingClientRect();
        const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
        out.push({
          el,
          role,
          name: T.getAccessibleName(el),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          value: isField && (el.type || '').toLowerCase() !== 'password' ? String(el.value || '') : '',
          disabled: !!el.disabled,
          y: rect.top,
          x: rect.left,
        });
      }
      for (const c of el.children) walk(c);
      if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c);
      if (el.tagName === 'IFRAME' && el.contentDocument && el.contentDocument.body)
        for (const c of el.contentDocument.body.children) walk(c);
    }

    if (document.body) walk(document.body);
    return { els: out, truncated };
  }

  function match(spec, els) {
    const wantRoles = spec.role
      ? (Array.isArray(spec.role) ? spec.role : [spec.role]).map(norm)
      : null;
    const nameRe = spec.name_matches ? safeRe(spec.name_matches) : null;
    const nameSub = spec.name_contains ? norm(spec.name_contains) : null;
    const textRe = spec.text_matches ? safeRe(spec.text_matches) : null;
    const textSub = spec.text_contains ? norm(spec.text_contains) : null;
    const wantNotDisabled = spec.include_disabled !== true;

    return els.filter(e => {
      if (wantRoles && !wantRoles.includes(norm(e.role))) return false;
      if (wantNotDisabled && e.disabled) return false;
      if (nameSub && !norm(e.name).includes(nameSub)) return false;
      if (nameRe && !nameRe.test(e.name || '')) return false;
      if (textSub && !norm(e.text + ' ' + e.name).includes(textSub)) return false;
      if (textRe && !textRe.test(e.text + ' ' + e.name)) return false;
      return true;
    });
  }

  // Only reachable when the spec asked for a pick mode; a bare single match is
  // handled by the caller. Returns {chosen|null, note?} — null means the pick
  // mode could not be applied, which the caller reports as ambiguous rather
  // than quietly falling back to the first candidate.
  function pickBy(spec, cands) {
    const mode = spec.pick;
    if (mode === 'first') return { chosen: cands[0] };
    if (mode === 'last') return { chosen: cands[cands.length - 1] };
    if (mode === 'top') {
      return { chosen: cands.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x))[0] };
    }
    if (mode === 'min' || mode === 'max') {
      const re = safeRe(spec.pick_from || '(\\d[\\d.,]*)');
      if (!re) return { chosen: null, note: `pick_from 不是合法正则: ${spec.pick_from}` };
      const scored = [];
      for (const c of cands) {
        const m = (c.text + ' ' + c.name).match(re);
        if (!m) continue;
        const raw = m[1] !== undefined && m[1] !== null ? m[1] : m[0];
        // Only strip a comma that really is a thousands separator (1,234 /
        // 1,234,567). A blanket /,/g reads the European decimal "1,50" as 150 and
        // picks the wrong tier.
        const v = parseFloat(String(raw).replace(/,(?=\d{3}(\D|$))/g, ''));
        if (Number.isFinite(v)) scored.push({ c, v });
      }
      if (!scored.length) return { chosen: null, note: '没有候选能按 pick_from 解析出数字' };
      scored.sort((a, b) => (mode === 'min' ? a.v - b.v : b.v - a.v));
      return { chosen: scored[0].c, note: `${scored.length} 个候选按数值选出` };
    }
    return { chosen: null, note: `未知 pick 模式: ${mode}` };
  }

  function resolve(spec) {
    const T = globalThis.__ccAccessibilityTree;
    if (!T) return { error: 'accessibility tree not available' };

    const actions = Array.isArray(spec && spec.actions) ? spec.actions : [];
    const { els, truncated } = scan();
    const refFor = el => T.getRefForElement(el);
    // One builder for both paths, so which branch ran is not visible in the
    // alternatives a caller receives: same shape, same page order, same cap.
    const alternativesFor = cands => cands
      .slice()
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))
      .slice(0, MAX_ALTERNATIVES)
      .map(c => ({ ref: refFor(c.el), label: labelOf(c) }))
      .filter(a => a.ref);

    const results = actions.map(a => {
      // A malformed spec used to fail silently: safeRe returns null for a bad
      // pattern, and `if (nameRe && …)` then dropped the constraint altogether,
      // so a typo matched every element instead of reporting anything. Unknown
      // pick modes were likewise reported as `ambiguous`, indistinguishable from
      // a genuine tie. Both are caller mistakes and get their own status.
      const bad = [];
      if (a.name_matches && !safeRe(a.name_matches)) bad.push(`name_matches 不是合法正则: ${a.name_matches}`);
      if (a.text_matches && !safeRe(a.text_matches)) bad.push(`text_matches 不是合法正则: ${a.text_matches}`);
      if (a.pick_from && !safeRe(a.pick_from)) bad.push(`pick_from 不是合法正则: ${a.pick_from}`);
      if (a.pick && !PICK_MODES.has(a.pick)) bad.push(`未知 pick 模式: ${a.pick}`);
      if (bad.length) return { name: a.name, status: 'error', candidates: 0, error: bad.join('; ') };

      const cands = match(a, els);
      if (!cands.length) {
        return { name: a.name, status: 'missing', candidates: 0 };
      }

      let chosen = null;
      let status = 'resolved';
      let note;

      if (a.pick) {
        const p = pickBy(a, cands);
        chosen = p.chosen;
        note = p.note;
        if (!chosen) status = 'ambiguous';
      } else if (cands.length === 1) {
        chosen = cands[0];
      } else {
        status = 'ambiguous';
      }

      if (!chosen) {
        // Ambiguity is only actionable if the caller can see what it is ambiguous
        // between, so return the topmost few rather than the bare count.
        return { name: a.name, status, candidates: cands.length, note, alternatives: alternativesFor(cands) };
      }

      const alternatives = alternativesFor(cands.filter(c => c !== chosen));

      return {
        name: a.name,
        status,
        candidates: cands.length,
        ref: refFor(chosen.el),
        role: chosen.role,
        label: labelOf(chosen),
        value: chosen.value || undefined,
        note,
        alternatives: alternatives.length ? alternatives : undefined,
      };
    });

    // `truncated` tells the caller that a `missing` may be a budget casualty
    // rather than proof the action is absent from the page.
    return { url: location.href, title: document.title, scanned: els.length, truncated, results };
  }

  globalThis.__ccActionResolver = { resolve };
})();
