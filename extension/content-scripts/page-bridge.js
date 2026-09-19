(function() {
  if (globalThis.__ccBridge) return;

  function getPageText(maxChars = 50000) {
    const selectors = ['article','main','[class*="article-body"]','[class*="articleBody"]',
      '[class*="post-content"]','[class*="entry-content"]','[class*="content-body"]',
      '[role="main"]','.content','#content'];
    let best = null, bestLen = 0;
    for (const s of selectors) {
      for (const el of document.querySelectorAll(s)) {
        const l = (el.textContent || '').length;
        if (l > bestLen) { bestLen = l; best = el; }
      }
    }
    const src = best || document.body;
    let text = (src?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + '... (truncated)';
    return { title: document.title, url: location.href, content: text, sourceElement: src?.tagName.toLowerCase() || 'body' };
  }

  function fillForm(ref, value) {
    const tree = globalThis.__ccAccessibilityTree;
    if (!tree) return { success: false, error: 'Accessibility tree not available' };
    const el = tree.getElementByRef(ref);
    if (!el) return { success: false, error: `Element not found: ${ref}` };
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const tag = el.tagName.toLowerCase();
      // Focus first so a later blur() fires the full focus→input→change→blur
      // chain that React/Vue controlled components expect on commit.
      if (!(tag === 'input' && (el.type || '').toLowerCase() === 'file')) {
        try { el.focus(); } catch {}
      }

      let applied = true;

      if (tag === 'select') {
        let found = false;
        for (const o of el.options) {
          if (o.value === String(value) || o.text === String(value)) { el.value = o.value; found = true; break; }
        }
        if (!found) return { success: false, error: 'No matching option found' };
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tag === 'input') {
        const t = (el.type || '').toLowerCase();
        if (t === 'checkbox' || t === 'radio') {
          // `!!value` treats the strings "false" and "0" as true. The MCP schema
          // types `value` as string|boolean|number, so compare explicitly.
          el.checked = value === true || value === 'true' || value === 1 || value === '1';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (t === 'file') {
          // Not a failure: a file input needs a real path, which is handled by
          // background.js through CDP DOM.setFileInputFiles. `status` says so
          // explicitly, since `success: false` on its own reads as a plain error.
          return { success: false, status: 'need_file_upload', fileInput: true, ref };
        } else {
          applied = setNativeValue(el, String(value));
        }
      } else if (tag === 'textarea') {
        applied = setNativeValue(el, String(value));
      } else if (el.isContentEditable) {
        setCE(el, String(value));
      } else {
        applied = setNativeValue(el, String(value));
      }
      // A plain element takes `el.value = …` as an ordinary JS property without
      // touching form state. Reporting success there would be a lie.
      if (!applied) return { success: false, error: `元素没有可写的原生 value，填写未生效: ${tag}` };

      if ((tag === 'textarea' || (tag === 'input' && ['text','password','search','tel','url'].includes((el.type||'').toLowerCase()))) && el.setSelectionRange) {
        const len = (el.value || '').length;
        el.setSelectionRange(len, len);
      }
      // Real blur (moves focus away, fires native focusout) commits controlled components.
      if (document.activeElement === el) el.blur();
      return { success: true, fieldName: el.name || el.id || ref };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fill form field' };
    }
  }

  // Returns false when the element has no usable native `value` setter, so the
  // caller can report a real failure instead of a silent no-op. Picking
  // HTMLInputElement's prototype for, say, a div makes the setter throw
  // TypeError, which the old catch swallowed while `fillForm` still returned
  // success — the field looked filled and was not.
  function setNativeValue(el, val) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement ? HTMLInputElement.prototype
        : null;
    let applied = false;
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) { try { desc.set.call(el, val); applied = true; } catch {} }
    }
    if (!applied) {
      // Checked BEFORE the assignment on purpose. Writing `el.value` on a plain
      // element creates an expando in this isolated world and nothing else, so a
      // check afterwards always passes and the caller is told a dead field was
      // filled — the very lie this function is here to prevent.
      const hadValue = 'value' in el;
      try { el.value = val; } catch {}
      applied = hadValue;
    }
    if (!applied) return false;
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Scoped to the element's own contents. `selectAll` is deprecated and acts on
  // whatever the document happens to have selected, so if the focus call failed
  // it would replace the selection for the whole page instead of this field.
  function selectContents(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  function setCE(el, val) {
    el.focus();
    selectContents(el);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, val); } catch {}
    if (!inserted || el.textContent !== val) {
      // The editor never took the insert, so write the DOM directly and replay
      // the sequence editors listen for — otherwise the visible text and the
      // editor's own model diverge and the next save drops the value.
      try {
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
      } catch {}
      el.textContent = val;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
    }
  }

  // Only this element's own text nodes — not `textContent`, which re-concatenates
  // the whole subtree at every level and made the search quadratic on nested pages.
  function directText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
    return s;
  }

  function searchElements(query, maxResults = 20) {
    const tree = globalThis.__ccAccessibilityTree;
    if (!tree) return [];
    // The script is injected at document_start on some paths, before body exists.
    if (!document.body) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length);
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while (node = walker.nextNode()) {
      try {
        const role = node.getAttribute('role') || node.tagName.toLowerCase();
        const own = (node.children.length === 0 ? node.textContent : directText(node)) || '';
        const label = (node.getAttribute('aria-label') || node.getAttribute('title') || own).trim().slice(0, 100) || '';
        let score = 0;
        const ll = label.toLowerCase(), tl = own.toLowerCase();
        for (const t of terms) {
          if (ll.includes(t)) score += 3;
          if (role.toLowerCase().includes(t)) score += 2;
          if (tl.includes(t)) score += 1;
        }
        if (score > 0) results.push({ ref: tree.getRefForElement(node), text: label || role, role, score });
      } catch { /* one bad node must not abort the whole search */ }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  globalThis.__ccBridge = { getPageText, fillForm, searchElements };
})();
