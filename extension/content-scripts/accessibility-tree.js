(function() {
  if (globalThis.__ccAccessibilityTree) return;
  const elementMap = new Map(), reverseMap = new WeakMap();
  let nextRefId = 1;

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

  function generate(mode = 'interactive', maxDepth = 15, maxChars = 50000, focusRef = null) {
    // Hard ceiling — even if caller passes a huge depth, cap it to prevent
    // unreadable truncated output on dense pages (e.g. Amazon/Taobao).
    const depthLimit = Math.min(maxDepth, 30);
    let focusEl = null;
    if (focusRef) {
      focusEl = getElementByRef(focusRef);
      if (!focusEl) return { tree: `[Error] Element not found: ${focusRef}`, elementCount: 0 };
    }
    const lines = [];
    let chars = 0, truncated = false, lastRef = null;

    function walk(el, depth) {
      if (truncated || !isVisible(el)) return;
      if (mode !== 'interactive' && depth > depthLimit) return;
      const role = getRole(el);
      if (mode === 'interactive' && !isInteractive(el) && !role) {
        for (const c of el.children) walk(c, depth);
        return;
      }
      const ref = getRefForElement(el), name = getAccessibleName(el);
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
        line += ` = "${el.value.slice(0, 50).replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
      }
      if (chars + line.length > maxChars) {
        truncated = true;
        lines.push(`\n[TRUNCATED at ${ref}. Use ref_id="${lastRef}" or increase max_chars.]`);
        return;
      }
      lines.push(line);
      chars += line.length + 1;
      lastRef = ref;
      for (const c of el.children) walk(c, depth + 1);
    }

    if (focusEl) walk(focusEl, 0);
    else if (document.body) walk(document.body, 0);

    return {
      tree: (truncated ? '[Warning: truncated]\n' : '') + lines.join('\n'),
      elementCount: elementMap.size,
      truncated
    };
  }

  globalThis.__ccAccessibilityTree = {
    generate, getElementCoordinates, getElementByRef, getRefForElement,
    elementMap, get elementCount() { return elementMap.size; }
  };
})();
