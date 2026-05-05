chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CAPTURE') return;

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
});
