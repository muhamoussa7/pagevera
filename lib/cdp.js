// Thin promise wrapper around chrome.debugger for one tab.

const sessions = new Map(); // tabId -> CdpSession

chrome.debugger.onEvent.addListener((source, method, params) => {
  sessions.get(source.tabId)?._emit(method, params, source.sessionId || null);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  sessions.get(source.tabId)?._detached(reason);
});

export class CdpSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.target = { tabId };
    this.attached = false;
    this.detachReason = null;
    this.onDetach = null;
    this._listeners = new Map();
  }

  async attach() {
    try {
      await chrome.debugger.attach(this.target, '1.3');
    } catch (e) {
      throw friendlyAttachError(e);
    }
    this.attached = true;
    sessions.set(this.tabId, this);
  }

  // sessionId targets a child session (an out-of-process iframe) of this tab.
  send(method, params = {}, { timeoutMs = 30_000, sessionId = null } = {}) {
    if (!this.attached) {
      return Promise.reject(new Error(`Debugger is not attached (${this.detachReason || 'detached'})`));
    }
    const target = sessionId ? { tabId: this.tabId, sessionId } : this.target;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([chrome.debugger.sendCommand(target, method, params), timeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  on(method, cb) {
    if (!this._listeners.has(method)) this._listeners.set(method, new Set());
    this._listeners.get(method).add(cb);
    return () => this._listeners.get(method)?.delete(cb);
  }

  _emit(method, params, sessionId) {
    for (const cb of this._listeners.get(method) || []) {
      try {
        cb(params, sessionId);
      } catch (e) {
        console.error('CDP listener error', method, e);
      }
    }
  }

  _detached(reason) {
    this.attached = false;
    this.detachReason = reason;
    sessions.delete(this.tabId);
    this.onDetach?.(reason);
  }

  async detach() {
    if (!this.attached) return;
    this.attached = false;
    this.detachReason = 'done';
    sessions.delete(this.tabId);
    try {
      await chrome.debugger.detach(this.target);
    } catch {
      // Already gone.
    }
  }
}

export function isAttached(tabId) {
  return sessions.has(tabId);
}

function friendlyAttachError(e) {
  const msg = String(e?.message || e);
  let text = msg;
  if (/another debugger/i.test(msg)) {
    text = 'Another extension or tool is already debugging this tab. Close it and try again.';
  } else if (/chrome:\/\/|chrome-extension:\/\/|webstore|Cannot access/i.test(msg)) {
    text = "Chrome doesn't allow extensions to read this page.";
  } else if (/file:/i.test(msg)) {
    text = 'Turn on "Allow access to file URLs" for PageVera to save local files.';
  } else if (/policy/i.test(msg)) {
    text = 'Your organization blocks this extension on this page.';
  }
  const err = new Error(text);
  err.code = 'ATTACH_FAILED';
  err.detail = msg;
  return err;
}
