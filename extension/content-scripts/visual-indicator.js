(function() {
  if (globalThis.__ccVisualIndicator) return;

  let highlightEl = null, statusEl = null, stopEl = null;
  let pulsingActive = false, pulsingBeforeHide = false, isMcp = false;

  function getShadow() {
    let container = document.getElementById('cc-shadow-container');
    if (container?.shadowRoot) return container.shadowRoot;
    container = document.createElement('div');
    container.id = 'cc-shadow-container';
    container.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; pointer-events: none;';
    const shadow = container.attachShadow({ mode: 'open' });
    document.body.appendChild(container);
    return shadow;
  }

  function highlightElement(ref) {
    const tree = globalThis.__ccAccessibilityTree;
    if (!tree) return;
    const el = tree.getElementByRef(ref);
    if (!el) return;
    clearHighlight();

    const r = el.getBoundingClientRect();
    const sx = window.scrollX || window.pageXOffset;
    const sy = window.scrollY || window.pageYOffset;
    const shadow = getShadow();

    highlightEl = document.createElement('div');
    highlightEl.id = 'cc-highlight-overlay';
    highlightEl.style.cssText = `
      position: absolute; left: ${r.left + sx - 4}px; top: ${r.top + sy - 4}px;
      width: ${r.width + 8}px; height: ${r.height + 8}px;
      border: 3px solid #4CAF50; border-radius: 4px;
      box-sizing: border-box;
      animation: cc-pulse 1s ease-in-out infinite;
    `;
    const style = document.createElement('style');
    style.textContent = `
      @keyframes cc-pulse {
        0%, 100% { border-color: #4CAF50; box-shadow: 0 0 5px rgba(76,175,80,0.5); }
        50% { border-color: #81C784; box-shadow: 0 0 20px rgba(76,175,80,0.8); }
      }
    `;
    shadow.appendChild(style);
    shadow.appendChild(highlightEl);
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }

  function clearHighlight() {
    const container = document.getElementById('cc-shadow-container');
    if (container?.shadowRoot) {
      const h = container.shadowRoot.getElementById('cc-highlight-overlay');
      if (h) h.remove();
    }
    highlightEl = null;
  }

  function showStatusBadge(status) {
    const shadow = getShadow();
    hideStatusBadge();
    const icons = { loading: '⏳', completed: '✅', error: '❌' };
    const colors = { loading: '#2196F3', completed: '#4CAF50', error: '#f44336' };

    statusEl = document.createElement('div');
    statusEl.style.cssText = `
      position: fixed; top: 20px; right: 20px; background: ${colors[status]};
      color: white; padding: 12px 20px; border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: flex; align-items: center; gap: 8px;
      transition: all 0.3s ease;
    `;
    statusEl.innerHTML = `${icons[status]} ${status.charAt(0).toUpperCase() + status.slice(1)}`;
    statusEl.onclick = () => { statusEl.style.opacity = '0'; setTimeout(() => statusEl?.remove(), 300); };
    shadow.appendChild(statusEl);
  }

  function hideStatusBadge() {
    if (statusEl) { statusEl.remove(); statusEl = null; }
  }

  function showAgentUI() {
    pulsingActive = true;
    const shadow = getShadow();

    // Pulsing border
    if (!document.getElementById('cc-pulse-styles')) {
      const s = document.createElement('style');
      s.id = 'cc-pulse-styles';
      s.textContent = `
        @keyframes cc-agent-pulse {
          0%, 100% { box-shadow: inset 0 0 4px rgba(74,222,128,0.5), inset 0 0 8px rgba(74,222,128,0.25); }
          50% { box-shadow: inset 0 0 6px rgba(74,222,128,0.7), inset 0 0 12px rgba(74,222,128,0.35); }
        }
      `;
      shadow.appendChild(s);
    }

    let border = shadow.getElementById('cc-agent-glow-border');
    if (!border) {
      border = document.createElement('div');
      border.id = 'cc-agent-glow-border';
      border.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        pointer-events: none; z-index: 2147483646;
        opacity: 0; transition: opacity 0.3s ease-in-out;
        animation: cc-agent-pulse 2s ease-in-out infinite;
        box-shadow: inset 0 0 4px rgba(74,222,128,0.5), inset 0 0 8px rgba(74,222,128,0.25);
      `;
      shadow.appendChild(border);
    }
    border.style.display = '';
    requestAnimationFrame(() => { border.style.opacity = '1'; });

    // Stop button
    if (!stopEl) {
      const container = document.createElement('div');
      container.id = 'cc-agent-stop-container';
      container.style.cssText = `
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        pointer-events: auto; z-index: 2147483647;
        opacity: 0; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      `;
      const btn = document.createElement('button');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="display:inline-block;vertical-align:middle;margin-right:8px;">
          <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
        </svg>
        <span style="vertical-align:middle">停止</span>
      `;
      btn.style.cssText = `
        padding: 12px 16px; background: #FAF9F5; color: #141413;
        border: 0.5px solid rgba(31,30,29,0.4); border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px; font-weight: 600; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        box-shadow: 0 40px 80px rgba(74,222,128,0.24), 0 4px 14px rgba(74,222,128,0.24);
        transition: all 0.2s ease;
      `;
      btn.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({ type: 'STOP_TOOL_EXECUTION' });
          btn.textContent = 'Stopping...';
          btn.disabled = true;
          btn.style.opacity = '0.7';
          setTimeout(() => hideAgentUI(), 500);
        } catch {}
      });
      container.appendChild(btn);
      shadow.appendChild(container);
      stopEl = container;
    }
    stopEl.style.display = '';
    requestAnimationFrame(() => { stopEl.style.opacity = '1'; });
  }

  function hideAgentUI() {
    pulsingActive = false;
    const shadow = document.getElementById('cc-shadow-container')?.shadowRoot;
    if (!shadow) return;
    const border = shadow.getElementById('cc-agent-glow-border');
    if (border) { border.style.opacity = '0'; setTimeout(() => { if (!pulsingActive) border.style.display = 'none'; }, 300); }
    if (stopEl) { stopEl.style.opacity = '0'; setTimeout(() => { if (!pulsingActive) { stopEl.remove(); stopEl = null; } }, 300); }
  }

  function hideAll() {
    clearHighlight();
    hideStatusBadge();
    hideAgentUI();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'SHOW_HIGHLIGHT': highlightElement(msg.ref); sendResponse({ success: true }); break;
      case 'HIDE_HIGHLIGHT': clearHighlight(); sendResponse({ success: true }); break;
      case 'SHOW_STATUS': showStatusBadge(msg.status); sendResponse({ success: true }); break;
      case 'HIDE_STATUS': hideStatusBadge(); sendResponse({ success: true }); break;
      case 'SHOW_AGENT_UI': showAgentUI(); sendResponse({ success: true }); break;
      case 'HIDE_AGENT_UI': hideAgentUI(); sendResponse({ success: true }); break;
      case 'HIDE_ALL': hideAll(); sendResponse({ success: true }); break;
    }
    return true;
  });

  globalThis.__ccVisualIndicator = { highlightElement, clearHighlight, showStatusBadge, hideStatusBadge, showAgentUI, hideAgentUI, hideAll };
})();
