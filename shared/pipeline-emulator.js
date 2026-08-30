/**
 * Sandbox-only: connect Firebase Functions client to the local emulator.
 *
 * Active when URL has ?emulator=1 (or ?emulator=true) or page is served from
 * localhost / 127.0.0.1. Production deploy is never required for sandbox E2E
 * when the functions emulator is running — see SANDBOX_BACKEND_HANDOFF.md.
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5001;

/** @returns {boolean} */
export function shouldUseFunctionsEmulator() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const flag = params.get('emulator');
  if (flag === '1' || flag === 'true') return true;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

/**
 * @param {import('firebase/functions').Functions} functions
 * @param {typeof import('firebase/functions').connectFunctionsEmulator} connectFunctionsEmulator
 * @param {{host?:string, port?:number}} [opts]
 * @returns {boolean} true when emulator was connected
 */
export function connectPipelineFunctionsEmulator(functions, connectFunctionsEmulator, opts = {}) {
  if (!shouldUseFunctionsEmulator()) return false;
  const host = opts.host || DEFAULT_HOST;
  const port = opts.port || DEFAULT_PORT;
  connectFunctionsEmulator(functions, host, port, { disableWarnings: true });
  return true;
}

/** Small fixed banner so it is obvious sandbox is hitting the emulator. */
export function mountEmulatorBanner() {
  if (!shouldUseFunctionsEmulator() || typeof document === 'undefined') return;
  if (document.getElementById('pipeline-emulator-banner')) return;
  const el = document.createElement('div');
  el.id = 'pipeline-emulator-banner';
  el.textContent = 'Sandbox · Functions emulator (127.0.0.1:5001) — not deployed';
  el.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;padding:6px 12px;' +
    'background:#1a3a5c;color:#fff;font:600 12px/1.4 system-ui,sans-serif;text-align:center;' +
    'pointer-events:none;';
  document.body.prepend(el);
}

export { DEFAULT_HOST, DEFAULT_PORT };

/** Emulator uses export names; deployed uses `{codebase}-{exportName}`. */
export function pipelineCallableName(exportName, codebaseId = 'pipeline') {
  if (shouldUseFunctionsEmulator()) return exportName;
  return `${codebaseId}-${exportName}`;
}
