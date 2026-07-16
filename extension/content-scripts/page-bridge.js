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
          el.checked = !!value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (t === 'file') {
          return { success: false, error: 'File uploads require CDP commands' };
        } else {
          setNativeValue(el, String(value));
        }
      } else if (tag === 'textarea') {
        setNativeValue(el, String(value));
      } else if (el.isContentEditable) {
        setCE(el, String(value));
      } else {
        setNativeValue(el, String(value));
      }

      if ((tag === 'textarea' || (tag === 'input' && ['text','password','search','tel','url'].includes((el.type||'').toLowerCase()))) && el.setSelectionRange) {
        const len = (el.value || '').length;
        el.setSelectionRange(len, len);
      }
      return { success: true, fieldName: el.name || el.id || ref };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fill form field' };
    }
  }

  function setNativeValue(el, val) {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(el, val);
      else el.value = val;
    } catch { el.value = val; }
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setCE(el, val) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, val);
    if (el.textContent !== val) {
      el.textContent = val;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
    }
  }

  function searchElements(query, maxResults = 20) {
    const tree = globalThis.__ccAccessibilityTree;
    if (!tree) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length);
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while (node = walker.nextNode()) {
      const role = node.getAttribute('role') || node.tagName.toLowerCase();
      const label = node.getAttribute('aria-label') || node.getAttribute('title') || (node.textContent || '').trim().slice(0, 100) || '';
      let score = 0;
      const ll = label.toLowerCase();
      for (const t of terms) {
        if (ll.includes(t)) score += 3;
        if (role.toLowerCase().includes(t)) score += 2;
        if ((node.textContent || '').toLowerCase().includes(t)) score += 1;
      }
      if (score > 0) results.push({ ref: tree.getRefForElement(node), text: label || role, role, score });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  globalThis.__ccBridge = { getPageText, fillForm, searchElements };
})();
