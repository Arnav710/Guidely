chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
        sendResponse({ error: 'Invalid capture data URL' });
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (typeof base64 !== 'string' || !base64.length) {
        sendResponse({ error: 'Empty capture payload' });
        return;
      }
      sendResponse({ screenshot: base64 });
    });
    return true; // keep message channel open for async sendResponse
  }

  if (message.type === 'NAVIGATE') {
    const url = message.url;
    // Only allow http/https to prevent navigation to privileged pages.
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      sendResponse({ error: 'Invalid URL' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      sendResponse({ error: 'Only http/https URLs are allowed' });
      return;
    }
    // chrome.tabs.update is allowed with the "tabs" permission already declared.
    chrome.tabs.update(sender.tab.id, { url: parsed.href }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true;
  }
});
