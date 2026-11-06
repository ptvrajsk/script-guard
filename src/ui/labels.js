// Plain-language labels for events shown in the popup. Keep in sync with the event kinds in src/content/hooks.js.
export const KIND_LABEL = {
  'clipboard.risky': 'A command was copied to your clipboard',
  'clipboard.write': 'The page wrote to your clipboard',
  'download.auto': 'A download started without a click',
  'eval': 'Page ran code from a string (eval)',
  'function-ctor': 'Page built code from a string (Function)',
  'timer-string': 'Page scheduled code from a string',
  'document.write': 'Page wrote markup with document.write',
  'websocket': 'Page opened a WebSocket',
  'wasm': 'Page compiled WebAssembly',
  'file-picker': 'Page asked to access files',
  'notification-request': 'Page asked to show notifications',
  'window.open': 'Page opened a pop-up',
  'script-insert': 'Page added a script',
  'worker': 'Page started a background worker',
  'protocol-handler': 'Page registered a link handler',
  'script.scored': 'Script checked',
  'script.patched': 'Script rewritten by your rule',
  'script.stale': 'A rule no longer matches its script',
};
export const ACTION_LABEL = { blocked: 'Blocked', allowed: 'Allowed', logged: 'Noted', warned: 'Warned' };
export const kindLabel = (k) => KIND_LABEL[k] || k;
export const actionLabel = (a) => ACTION_LABEL[a] || 'Noted';

export const PROFILE_INFO = {
  trusted: { state: 'Off for this site', short: 'Off', help: 'No guards run here. Use this for a site you depend on that breaks otherwise.' },
  default: { state: 'Guarded', short: 'Default', help: 'Blocks commands copied to your clipboard and flags automatic downloads. Denies risky browser features such as USB, serial and screen capture.' },
  strict: { state: 'Strict', short: 'Strict', help: 'Everything in Default, and blocks automatic downloads. Also reports scripts that break a stricter policy. Some sites will not work.' },
};
