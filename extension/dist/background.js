const DAEMON_PORT = 19825;
const DAEMON_HOST = "localhost";
const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
const WS_RECONNECT_BASE_DELAY = 2e3;
const WS_RECONNECT_MAX_DELAY = 6e4;

async function evaluate(tabId, expression) {
  const wrappedCode = `
    (async () => {
      try {
        const __result = await (async () => { return (${expression}); })();
        return { __ok: true, __value: __result };
      } catch (e) {
        return { __ok: false, __error: e instanceof Error ? e.message : String(e), __stack: e instanceof Error ? e.stack : undefined };
      }
    })()
  `;
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (code) => {
        return eval(code);
      },
      args: [wrappedCode]
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`executeScript failed: ${msg}`);
  }
  if (!results || results.length === 0) {
    throw new Error("executeScript returned no results");
  }
  const result = results[0].result;
  if (!result) {
    return void 0;
  }
  if (!result.__ok) {
    throw new Error(result.__error || "Eval error");
  }
  return result.__value;
}
const evaluateAsync = evaluate;
async function screenshot(tabId2, options = {}) {
  const tab = await chrome.tabs.get(tabId2);
  if (!tab.active) {
    await chrome.tabs.update(tabId2, { active: true });
    await new Promise((r) => setTimeout(r, 100));
  }
  const format = options.format ?? "png";
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format,
    quality: format === "jpeg" ? options.quality ?? 80 : void 0
  });
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  return base64;
}
function detach(_tabId) {
}

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
function forwardLog(level, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    ws.send(JSON.stringify({ type: "log", level, msg, ts: Date.now() }));
  } catch {
  }
}
console.log = (...args) => {
  _origLog(...args);
  forwardLog("info", args);
};
console.warn = (...args) => {
  _origWarn(...args);
  forwardLog("warn", args);
};
console.error = (...args) => {
  _origError(...args);
  forwardLog("error", args);
};
function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  try {
    ws = new WebSocket(DAEMON_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    console.log("[opencli] Connected to daemon");
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  ws.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data);
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (err) {
      console.error("[opencli] Message handling error:", err);
    }
  };
  ws.onclose = () => {
    console.log("[opencli] Disconnected from daemon");
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    ws?.close();
  };
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}
let initialized = false;
function initialize() {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
  connect();
  console.log("[opencli] Browser Bridge extension initialized");
}
chrome.runtime.onInstalled.addListener(() => {
  initialize();
});
chrome.runtime.onStartup.addListener(() => {
  initialize();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") connect();
});
async function handleCommand(cmd) {
  try {
    switch (cmd.action) {
      case "exec":
        return await handleExec(cmd);
      case "navigate":
        return await handleNavigate(cmd);
      case "tabs":
        return await handleTabs(cmd);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        return await handleScreenshot(cmd);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
function isWebUrl(url) {
  if (!url) return false;
  return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://");
}
async function resolveTabId(tabId) {
  if (tabId !== void 0) return tabId;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && isWebUrl(activeTab.url)) {
    return activeTab.id;
  }
  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const webTab = allTabs.find((t) => t.id && isWebUrl(t.url));
  if (webTab?.id) {
    await chrome.tabs.update(webTab.id, { active: true });
    return webTab.id;
  }
  const newTab = await chrome.tabs.create({ url: "about:blank", active: true });
  if (!newTab.id) throw new Error("Failed to create new tab");
  return newTab.id;
}
async function handleExec(cmd) {
  if (!cmd.code) return { id: cmd.id, ok: false, error: "Missing code" };
  const tabId = await resolveTabId(cmd.tabId);
  try {
    const data = await evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleNavigate(cmd) {
  if (!cmd.url) return { id: cmd.id, ok: false, error: "Missing url" };
  const tabId = await resolveTabId(cmd.tabId);
  await chrome.tabs.update(tabId, { url: cmd.url });
  await new Promise((resolve) => {
    chrome.tabs.get(tabId).then((tab2) => {
      if (tab2.status === "complete") {
        resolve();
        return;
      }
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15e3);
    });
  });
  const tab = await chrome.tabs.get(tabId);
  return { id: cmd.id, ok: true, data: { title: tab.title, url: tab.url, tabId } };
}
async function handleTabs(cmd) {
  switch (cmd.op) {
    case "list": {
      const tabs = await chrome.tabs.query({});
      const data = tabs.filter((t) => isWebUrl(t.url)).map((t, i) => ({
        index: i,
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active
      }));
      return { id: cmd.id, ok: true, data };
    }
    case "new": {
      const tab = await chrome.tabs.create({ url: cmd.url, active: true });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case "close": {
      if (cmd.index !== void 0) {
        const tabs = await chrome.tabs.query({});
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        await chrome.tabs.remove(target.id);
        detach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId);
      await chrome.tabs.remove(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case "select": {
      if (cmd.index === void 0 && cmd.tabId === void 0)
        return { id: cmd.id, ok: false, error: "Missing index or tabId" };
      if (cmd.tabId !== void 0) {
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = await chrome.tabs.query({});
      const target = tabs[cmd.index];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}
async function handleCookies(cmd) {
  const details = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate
  }));
  return { id: cmd.id, ok: true, data };
}
async function handleScreenshot(cmd) {
  const tabId = await resolveTabId(cmd.tabId);
  try {
    const data = await screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
