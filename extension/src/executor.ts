/**
 * Stealth JS executor via chrome.scripting API.
 *
 * Replaces the old cdp.ts which used chrome.debugger (CDP).
 * chrome.scripting.executeScript runs in the page's MAIN world,
 * indistinguishable from a normal extension content script —
 * no debugger attach, no navigator.webdriver, no CDP fingerprint.
 */

/**
 * Evaluate a JS expression in the target tab's MAIN world.
 * Supports async expressions (await/Promise).
 */
export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  // Wrap the expression so we can handle both sync and async results,
  // and catch errors with proper serialization.
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
      world: 'MAIN',
      func: (code: string) => {
        // biome-ignore: eval is intentional — we need to run arbitrary JS in page context
        return eval(code);
      },
      args: [wrappedCode],
    });
  } catch (err) {
    // chrome.scripting can fail if the tab is a chrome:// page, etc.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`executeScript failed: ${msg}`);
  }

  if (!results || results.length === 0) {
    throw new Error('executeScript returned no results');
  }

  const result = results[0].result as
    | { __ok: true; __value: unknown }
    | { __ok: false; __error: string; __stack?: string }
    | undefined;

  if (!result) {
    // Some expressions return undefined — that's fine
    return undefined;
  }

  if (!result.__ok) {
    throw new Error(result.__error || 'Eval error');
  }

  return result.__value;
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
