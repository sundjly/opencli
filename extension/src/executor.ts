/**
 * Stealth JS executor via chrome.scripting API.
 *
 * Replaces the old cdp.ts which used chrome.debugger (CDP).
 * chrome.scripting.executeScript runs in the page's MAIN world,
 * indistinguishable from a normal extension content script —
 * no debugger attach, no navigator.webdriver, no CDP fingerprint.
 */

/**
 * Normalize JS code for evaluation:
 * - Already an IIFE `(...)()` → send as-is
 * - Arrow/function literal → wrap as IIFE `(code)()`
 * - `new Promise(...)` or raw expression → send as-is
 */
function wrapForEval(js: string): string {
  const code = js.trim();
  if (!code) return 'undefined';

  // Already an IIFE: `(async () => { ... })()` or `(function() {...})()`
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;

  // Arrow function: `() => ...` or `async () => ...`
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) return `(${code})()`;

  // Function declaration: `function ...` or `async function ...`
  if (/^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;

  // Everything else: bare expression, `new Promise(...)`, etc. → evaluate directly
  return code;
}

/**
 * Evaluate a JS expression in the target tab's MAIN world.
 * Supports async expressions (await/Promise).
 */
export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  // Normalize the expression: auto-invoke bare function expressions
  const code = wrapForEval(expression.trim());

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (code: string) => {
        // Use indirect eval (0, eval) to ensure global scope execution
        return await (0, eval)(code);
      },
      args: [code],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`executeScript failed: ${msg}`);
  }

  if (!results || results.length === 0) {
    return undefined;
  }

  const frame = results[0];

  // Check for execution error
  if ('error' in frame) {
    throw new Error((frame as any).error?.message || 'Script execution error');
  }

  return frame.result;
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via chrome.tabs.captureVisibleTab().
 * Returns base64-encoded image data (without data URL prefix).
 *
 * Note: This only captures the visible viewport. Full-page screenshot
 * is not supported without CDP (would need scroll-and-stitch).
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean } = {},
): Promise<string> {
  // Ensure the target tab is active (captureVisibleTab captures the active tab)
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    // Small delay for tab to become visible
    await new Promise(r => setTimeout(r, 100));
  }

  const format = options.format ?? 'png';

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, {
    format,
    quality: format === 'jpeg' ? (options.quality ?? 80) : undefined,
  });

  // Strip the data URL prefix to return raw base64
  // "data:image/png;base64,iVBOR..." → "iVBOR..."
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return base64;
}

/**
 * Detach — no-op in scripting mode (no debugger to detach).
 * Kept for API compatibility with background.ts.
 */
export function detach(_tabId: number): void {
  // Nothing to do — chrome.scripting doesn't maintain persistent connections
}

/**
 * Register cleanup listeners — minimal in scripting mode.
 * Kept for API compatibility.
 */
export function registerListeners(): void {
  // No debugger attach/detach state to manage
}
