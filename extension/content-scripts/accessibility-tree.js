(function() {
  if (globalThis.__ccAccessibilityTree) return;
  const elementMap = new Map(), reverseMap = new WeakMap();
  let nextRefId = 1;

  // Refs handed to the caller may still be in use, so only entries whose WeakRef
  // has already been collected are dropped — those can never resolve again.
  // Without this the map grows for the whole life of the content script.
  function pruneDeadRefs() {
    for (const [ref, wr] of elementMap) if (!wr.deref()) elementMap.delete(ref);
  }

  function getElementByRef(ref) {
    return elementMap.get(ref)?.deref() || null;
  }

  function getRefForElement(el) {
    const ex = reverseMap.get(el);
    if (ex && elementMap.get(ex)?.deref() === el) return ex;
    const ref = `ref_${nextRefId++}`;
    elementMap.set(ref, new WeakRef(el));
    reverseMap.set(el, ref);
    return ref;
  }

  function getElementCoordinates(ref, opts = {}) {
    const el = getElementByRef(ref);
    if (!el) return null;
    if (opts.scrollIntoView)
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  }

  function getRole(el) {
    const ar = el.getAttribute('role');
    if (ar) return ar;
    switch (el.tagName.toLowerCase()) {
      case 'a': return 'link';
      case 'button': return 'button';
      case 'input':
        return {
          text: 'textbox', email: 'textbox', password: 'textbox', search: 'searchbox',
          tel: 'textbox', url: 'textbox', checkbox: 'checkbox', radio: 'radio',
          range: 'slider', number: 'spinbutton', file: 'button',
          submit: 'button', reset: 'button'
        }[el.type?.toLowerCase()] || 'textbox';
      case 'select': return 'combobox';
      case 'textarea': return 'textbox';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'img': return 'image';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': case 'th': return 'cell';
      case 'form': return 'form';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'article': return 'article';
      case 'header': return 'header';
      case 'footer': return 'footer';
      default: return (el.onclick || el.onmousedown || el.onmouseup) ? 'button' : '';
    }
  }

  function getAccessibleName(el) {
    const al = el.getAttribute('aria-label');
    if (al) return al.trim().slice(0, 100);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const lbl = document.getElementById(lb); if (lbl) return lbl.textContent.trim().slice(0, 100); }
    if (el.getAttribute('title')) return el.getAttribute('title').trim().slice(0, 100);
    if (el.placeholder) return el.placeholder.trim().slice(0, 100);
    if (['BUTTON','A','H1','H2','H3','H4','H5','H6'].includes(el.tagName) || (el.tagName === 'LABEL' && el.control))
      return el.textContent.trim().slice(0, 100);
    if (el.tagName === 'IMG') return (el.alt || '').trim().slice(0, 100);
    if (['heading','listitem','article','status','alert','tooltip'].includes(el.getAttribute('role') || ''))
      return el.textContent.trim().slice(0, 100);
    return '';
  }

  function isVisible(el) {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
      && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function isInteractive(el) {
    return ['button','link','textbox','searchbox','combobox','checkbox','radio',
            'slider','spinbutton','menuitem','menuitemcheckbox','menuitemradio',
            'option','tab','switch'].includes(getRole(el));
  }

  function generate(mode = 'interactive', maxDepth = 15, maxChars = 50000, focusRef = null, keywords = null) {
    pruneDeadRefs();
    // Two different limits, deliberately. Non-interactive modes honour the
    // caller's depth (capped at 30) to keep the output readable. Interactive mode
    // is NOT capped at 30 — wrapper elements on real pages nest far deeper and
    // cutting there would drop live controls — so it gets a generous structural
    // ceiling instead: enough to stop a pathological or self-referential DOM from
    // blowing the stack, without changing what a normal page yields.
    const depthLimit = Math.min(maxDepth, 30);
    const interactiveDepthCeiling = 200;
    const kwList = keywords ? String(keywords).toLowerCase().split(/\s+/).filter(Boolean) : null;
    let focusEl = null;
    if (focusRef) {
      focusEl = getElementByRef(focusRef);
      if (!focusEl) return { tree: `[Error] Element not found: ${focusRef}`, elementCount: 0 };
    }
    const lines = [];
    let chars = 0, truncated = false, lastRef = null, emitted = 0;

    // Recursion helper: pierces iframe (same-origin) and shadow DOM so refs
    // cover embedded widgets, not just top-level document.body children.
    function recurseChildren(el, depth) {
      for (const c of el.children) walk(c, depth + 1);
      if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, depth + 1);
      if (el.tagName === 'IFRAME' && el.contentDocument?.body)
        for (const c of el.contentDocument.body.children) walk(c, depth + 1);
    }

    function walk(el, depth) {
      if (truncated || !isVisible(el)) return;
      if (depth > (mode === 'interactive' ? interactiveDepthCeiling : depthLimit)) return;
      const role = getRole(el);
      if (mode === 'interactive' && !isInteractive(el) && !role) {
        recurseChildren(el, depth);
        return;
      }
      const ref = getRefForElement(el), name = getAccessibleName(el);
      // Keyword mode: only emit matching elements, but keep descending so
      // deeper matches aren't missed. Cuts output to what the task needs.
      if (kwList) {
        const hay = `${name} ${role} ${(el.textContent || '').slice(0, 300)}`.toLowerCase();
        if (!kwList.some(k => hay.includes(k))) { recurseChildren(el, depth); return; }
      }
      const indent = '  '.repeat(Math.min(depth, 10));
      let line = `${indent}[${ref}] ${role}`;
      if (name) line += ` "${name}"`;
      // Show link destination
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (href && !href.startsWith('javascript:') && href !== '#') {
          line += ` → ${href.slice(0, 80)}`;
        }
      }
      const states = [];
      if (el.disabled) states.push('disabled');
      if (el.checked !== undefined && el.type !== 'radio') states.push(el.checked ? 'checked' : 'unchecked');
      if (el.readOnly) states.push('readonly');
      if (el.required) states.push('required');
      if (el.tagName === 'SELECT') states.push(`options=${el.options.length}`);
      if (states.length) line += ` (${states.join(', ')})`;
      // Show current value for inputs (skip password, escape quotes and newlines)
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value && el.type !== 'password') {
        // Fields that declare themselves secret. Everything else is echoed,
        // because seeing a filled value is the point of this tool. (Hidden inputs
        // never reach here — they have no box, so isVisible rejects them.)
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        const secret = /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac);
        line += secret ? ' = <masked>' : ` = "${el.value.slice(0, 50).replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
      }
      if (chars + line.length > maxChars) {
        truncated = true;
        lines.push(lastRef
          ? `\n[TRUNCATED at ${ref}. Use ref_id="${lastRef}" or increase max_chars.]`
          : `\n[TRUNCATED at ${ref}. Increase max_chars.]`);
        return;
      }
      lines.push(line);
      emitted++;
      chars += line.length + 1;
      lastRef = ref;
      recurseChildren(el, depth);
    }

    if (focusEl) walk(focusEl, 0);
    else if (document.body) walk(document.body, 0);

    return {
      tree: (truncated ? '[Warning: truncated]\n' : '') + lines.join('\n'),
      // Nodes emitted by THIS call — not elementMap.size, which also counts refs
      // handed out by earlier calls and entries whose element has been collected.
      elementCount: emitted,
      truncated
    };
  }

  // Cheap page fingerprint — used to detect whether an action changed anything.
  // Deliberately avoids generate(): no string building, no ref assignment, and a
  // layout-only visibility proxy instead of per-element getComputedStyle.
  function signature() {
    const parts = [];
    let count = 0, interactive = 0, nonInteractiveText = 0;
    const MAX_NODES = 20000, MAX_PARTS = 4000;

    function visibleish(el) {
      if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
      return !!el.getClientRects?.().length;
    }

    function walk(el) {
      if (count >= MAX_NODES) return;
      if (!visibleish(el)) return;
      count++;
      const role = getRole(el);
      if (role && isInteractive(el)) {
        interactive++;
        if (parts.length < MAX_PARTS) {
          parts.push(`${role}|${getAccessibleName(el)}|${el.value ?? ''}|${el.checked ?? ''}|${el.disabled ? 1 : 0}`);
        }
      } else if (!role) {
        // Text nodes carry the bulk of "did something appear" signal.
        const t = (el.children.length === 0 && el.textContent) ? el.textContent.trim() : '';
        if (t) nonInteractiveText += t.length;
      }
      for (const c of el.children) walk(c);
      if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c);
    }

    if (document.body) walk(document.body);

    // Include text volume in the hash so expansion of a collapsed panel registers
    // even when no new interactive element appears.
    const s = parts.join(';') + `#${count}#${nonInteractiveText}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;

    return {
      sig: String(h >>> 0),
      title: document.title,
      url: location.href,
      count, interactive, textChars: nonInteractiveText,
      // True once the caps above stopped the walk. A change confined to the part
      // that was never walked leaves `sig` identical, so callers must not read an
      // unchanged sig as proof that nothing happened.
      truncated: count >= MAX_NODES || parts.length >= MAX_PARTS
    };
  }

  globalThis.__ccAccessibilityTree = {
    generate, getElementCoordinates, getElementByRef, getRefForElement, signature,
    getRole, getAccessibleName, isVisible, isInteractive,
    elementMap, get elementCount() { return elementMap.size; }
  };
})();
