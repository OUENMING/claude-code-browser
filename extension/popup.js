const el = (id) => document.getElementById(id);

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function refresh() {
  const stored = await chrome.storage.local.get(['wsPort']);
  if (stored.wsPort) el('port-input').value = stored.wsPort;

  const tabId = await getActiveTabId();
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      el('tab-info').textContent = tab.title ? tab.title.slice(0, 40) : tab.url?.slice(0, 40) || `Tab #${tabId}`;
    } catch {
      el('tab-info').textContent = `Tab #${tabId}`;
    }
  }
}

async function checkStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'POPUP_GET_STATUS' });
    if (resp?.relayConnected) {
      el('ws-status').textContent = 'Connected';
      el('ws-status').className = 'status connected';
    } else {
      el('ws-status').textContent = 'Disconnected';
      el('ws-status').className = 'status disconnected';
    }
  } catch {
    el('ws-status').textContent = 'Disconnected';
    el('ws-status').className = 'status disconnected';
  }
}

el('save-port-btn').addEventListener('click', async () => {
  const port = parseInt(el('port-input').value, 10);
  if (!port || port < 1024 || port > 65535) return;
  await chrome.storage.local.set({ wsPort: port });
  await chrome.runtime.sendMessage({ type: 'RECONNECT', port });
  checkStatus();
});

el('disconnect-tab-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT_TAB' });
  el('tab-info').textContent = 'Disconnected';
});

refresh();
checkStatus();
