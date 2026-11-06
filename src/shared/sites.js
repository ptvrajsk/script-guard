// Hostname helpers. Pure, no chrome.* usage.
//
// LIMITATION: etld1() does not ship the full Public Suffix List. It knows a
// built-in set of common multi-part public suffixes (co.uk, com.au, ...) and of
// shared-hosting suffixes (github.io, vercel.app, ...) so that each tenant is its
// own "site". For any suffix not listed it falls back to the last two labels,
// which may be too broad.

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  'com.sg', 'edu.sg', 'gov.sg', 'org.sg',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'gob.ar', 'com.co', 'com.pe', 'com.ve', 'com.uy',
  'co.za', 'org.za', 'gov.za', 'ac.za', 'net.za',
  'co.il', 'org.il', 'ac.il', 'gov.il',
  'com.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.ua', 'com.pl', 'com.ru', 'com.es', 'com.pt', 'com.gr',
  'co.id', 'or.id', 'go.id', 'ac.id',
  'co.th', 'in.th', 'ac.th', 'go.th',
  'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.bd', 'com.ng', 'com.eg', 'com.sa', 'com.ng',
  'co.ke', 'co.ug', 'co.tz', 'co.zw'
]);

// Shared hosting platforms: every tenant sub-label is a different, mutually untrusted site.
const SHARED_HOSTING_SUFFIXES = [
  'github.io', 'githubusercontent.com', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'appspot.com', 'blogspot.com', 'herokuapp.com', 'azurewebsites.net', 'azurestaticapps.net',
  'cloudfront.net', 'amazonaws.com', 'glitch.me', 'repl.co', 'replit.dev', 'replit.app', 'onrender.com', 'fly.dev',
  'surge.sh', 'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'trycloudflare.com', 'myshopify.com', 'wixsite.com',
  'weebly.com', 'wordpress.com', 'tumblr.com', 'medium.com', 'notion.site', 'framer.app', 'framer.website',
  'stackblitz.io', 'codesandbox.io', 'csb.app', 'bitbucket.io', 'railway.app',
  'up.railway.app', 'deno.dev', 'now.sh', 'github.dev',
  'githubpreview.dev', 'gitpod.io', 'cloudfunctions.net', 'run.app', 'ondigitalocean.app', 'carrd.co',
  'webflow.io', 'sites.google.com', 'pythonanywhere.com',
  'neocities.org', 'hashnode.dev', 'bubbleapps.io', 'typedream.app', 'super.site', 'readthedocs.io'
];
const SHARED_SUFFIXES = new Set([...SHARED_HOSTING_SUFFIXES, ...MULTI_PART_SUFFIXES]);

function isIp(host) {
  if (host.includes(':')) return true; // IPv6 (brackets stripped by caller)
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Normalize a hostname: trim, lowercase, strip brackets and trailing dot. */
export function normalizeHost(hostname) {
  if (typeof hostname !== 'string') return '';
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Registrable domain ("eTLD+1") of a hostname. IPs and single labels are returned unchanged. */
export function etld1(hostname) {
  const host = normalizeHost(hostname);
  if (!host || isIp(host)) return host;
  const labels = host.split('.');
  // Longest listed public suffix wins (up.railway.app before railway.app); the site is one label more.
  for (let n = Math.min(3, labels.length - 1); n >= 2; n--) {
    if (SHARED_SUFFIXES.has(labels.slice(-n).join('.'))) return labels.slice(-n - 1).join('.');
  }
  return labels.slice(-2).join('.');
}

/** True when the URL is a potentially trustworthy (secure) context origin. */
export function isSecureContextUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  switch (u.protocol) {
    case 'https:': case 'wss:': case 'file:': case 'chrome-extension:': return true;
    case 'http:': case 'ws:': {
      const h = normalizeHost(u.hostname);
      return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
    }
    default: return false;
  }
}

/** Hostname of a URL, or '' if unparseable. */
export function hostnameOf(url) {
  try { return normalizeHost(new URL(url).hostname); } catch { return ''; }
}
