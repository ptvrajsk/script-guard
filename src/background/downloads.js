// Download classification (pure) and the onDeterminingFilename gate.
import { loadSettings, recordEvent, recentEvents, SESSION_TAB } from './events.js';
import { profileFor } from '../shared/schema.js';
import { hostnameOf } from '../shared/sites.js';

// Executable / script / installer types that can run code directly.
export const HIGH_RISK_EXTS = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'scr', 'lnk', 'iso', 'img', 'vhd', 'vhdx', 'hta', 'js', 'jse',
  'vbs', 'vbe', 'wsf', 'wsh', 'bat', 'cmd', 'ps1', 'psm1', 'com', 'pif', 'cpl', 'dll', 'jar', 'reg', 'msc', 'gadget',
  'application', 'appref-ms', 'sh', 'command', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'run', 'docm', 'xlsm', 'pptm', 'xll', 'chm'
]);
// Containers that may hide the above. Warned only.
export const LOW_RISK_EXTS = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'cab', 'arj', 'ace', 'bz2', 'xz', 'zst', 'one', 'url', 'iqy', 'slk']);
// Subset used for DNR navigation block rules. Excludes text-like types browsers display
// inline and `com` (it would collide with .com in URL hosts).
export const DNR_BLOCK_EXTS = ['exe', 'msi', 'msix', 'appx', 'scr', 'lnk', 'iso', 'hta', 'cpl', 'pif', 'dll', 'jar', 'msc', 'xll'];
const HIGH_RISK_MIMES = new Set([
  'application/x-msdownload', 'application/x-msdos-program', 'application/x-dosexec', 'application/vnd.microsoft.portable-executable',
  'application/x-msi', 'application/x-ms-installer', 'application/hta', 'application/x-ms-shortcut', 'application/x-iso9660-image',
  'application/x-sh', 'application/x-bat', 'application/x-msdos-batch', 'application/java-archive', 'application/vnd.android.package-archive',
  'application/x-apple-diskimage', 'application/x-executable', 'application/x-mach-binary', 'application/x-elf'
]);
const LOW_RISK_MIMES = new Set([
  'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed', 'application/vnd.rar', 'application/x-7z-compressed',
  'application/gzip', 'application/x-tar', 'application/vnd.ms-cab-compressed', 'application/octet-stream'
]);
const DECOY_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'jpg', 'jpeg', 'png', 'gif', 'mp3', 'mp4', 'rtf', 'csv']);

function extsOf(filename) {
  const base = String(filename || '').split(/[\\/]/).pop().trim().replace(/[. ]+$/, '').toLowerCase();
  const parts = base.split('.');
  return parts.length > 1 ? parts.slice(1) : [];
}

/**
 * Classify a download. Pure.
 * high: executable/script/installer by extension or MIME, or a decoy double extension (invoice.pdf.exe).
 * low: archives, generic binary MIME, or any download that was not triggered by a user gesture.
 */
export function classifyDownload({ filename, mime, url, hadGesture } = {}) {
  const exts = extsOf(filename);
  const last = exts[exts.length - 1] || '';
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  let urlExt = '';
  try { urlExt = extsOf(new URL(url).pathname.split('/').pop()).pop() || ''; } catch { /* ignore */ }

  if (exts.length >= 2 && DECOY_EXTS.has(exts[exts.length - 2]) && HIGH_RISK_EXTS.has(last)) {
    return { risk: 'high', reason: `double extension ".${exts[exts.length - 2]}.${last}"` };
  }
  if (HIGH_RISK_EXTS.has(last)) return { risk: 'high', reason: `risky extension ".${last}"` };
  if (!last && HIGH_RISK_EXTS.has(urlExt)) return { risk: 'high', reason: `risky extension ".${urlExt}" in URL` };
  if (HIGH_RISK_MIMES.has(m)) return { risk: 'high', reason: `risky MIME type ${m}` };
  if (LOW_RISK_EXTS.has(last)) {
    return hadGesture === false ? { risk: 'high', reason: `archive ".${last}" without user gesture` } : { risk: 'low', reason: `archive ".${last}"` };
  }
  if (LOW_RISK_MIMES.has(m) && (m !== 'application/octet-stream' || !last || !DECOY_EXTS.has(last))) {
    return hadGesture === false ? { risk: 'high', reason: `binary data (${m}) without user gesture` } : { risk: 'low', reason: `generic binary MIME ${m}` };
  }
  return { risk: 'none', reason: '' };
}

/** What to do for a classification under a profile. Pure. */
export function gateAction(profile, risk) {
  if (profile === 'trusted' || risk === 'none') return 'allow';
  if (profile === 'strict') return risk === 'high' ? 'block' : 'warn';
  return 'warn';
}

function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }

export async function handleDownload(item) {
  const settings = await loadSettings();
  const source = item.referrer || item.finalUrl || item.url;
  const profile = profileFor(settings, hostnameOf(source));
  // No gesture info exists on DownloadItem; use a recent hook-reported auto-download from the referrer's origin.
  const hadGesture = recentEvents('download.auto', 10000, originOf(item.referrer)).length ? false : undefined;
  const c = classifyDownload({ filename: item.filename, mime: item.mime, url: item.finalUrl || item.url, hadGesture });
  const action = gateAction(profile, c.risk);
  if (action === 'allow') return;
  if (action === 'block') { try { await chrome.downloads.cancel(item.id); } catch { /* already finished */ } }
  await recordEvent(SESSION_TAB, {
    kind: 'download.gate', action: action === 'block' ? 'blocked' : 'logged',
    detail: { risk: c.risk, reason: c.reason, profile, filename: item.filename, host: hostnameOf(item.finalUrl || item.url) }
  }, { frameUrl: item.referrer || '' });
}

/** Register listeners. Must be called synchronously at service-worker top level. */
export function init() {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // Never alter the filename; always answer so the download is not held up.
    handleDownload(item).catch(() => {}).finally(() => suggest());
    return true;
  });
}
