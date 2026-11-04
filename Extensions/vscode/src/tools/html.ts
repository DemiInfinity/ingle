// HTML → text and the private-host check, ported from WebTools.swift (HTMLText, WebTools.isPrivate). Pure.

const ENTITIES: [string, string][] = [
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&#x27;', "'"],
  ['&apos;', "'"], ['&nbsp;', ' '], ['&ndash;', '–'], ['&mdash;', '—'], ['&hellip;', '…'], ['&rsquo;', '’'], ['&lsquo;', '‘'],
  ['&ldquo;', '“'], ['&rdquo;', '”'], ['&pound;', '£'], ['&copy;', '©'],
];

export function plain(html: string, keepLines = false): string {
  let s = html.replace(/<[^>]+>/g, '');
  for (const [k, v] of ENTITIES) s = s.split(k).join(v);
  s = s.replace(/&#(\d+);/g, (m, d: string) => {
    const code = Number(d);
    try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m; } catch { return m; }
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (m, h: string) => {
    const code = parseInt(h, 16);
    try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m; } catch { return m; }
  });
  if (!keepLines) s = s.replace(/\s+/g, ' ');
  return s.trim();
}

export function title(html: string): string | null {
  const m = /<title[^>]*>.*?<\/title>/i.exec(html);
  if (!m) return null;
  const t = plain(m[0]);
  return t || null;
}

export function readable(html: string): string {
  let s = html;
  for (const tag of ['script', 'style', 'noscript', 'svg', 'head', 'nav', 'footer', 'form', 'iframe']) {
    s = s.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<h[1-6][^>]*>/gi, '\n\n## ');
  s = plain(s, true);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.trim();
}

/** localhost, .local, .lan, .internal, .home, .ts.net, single-label names, private/CGNAT IPv4 and raw IPv6. */
export function isPrivateHost(hostIn: string): boolean {
  let host = hostIn.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) return true; // raw IPv6
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')
    || host.endsWith('.home') || host.endsWith('.ts.net') || !host.includes('.')) return true;
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) return isPrivateIPv4(parts.map(Number));
  return host.includes(':');
}

export function isPrivateIPv4(p: number[]): boolean {
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT / Tailscale
  return false;
}

/** For resolved addresses (DNS answers): private IPv4, loopback/link-local/unique-local IPv6, mapped IPv4. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const v4 = mapped ? mapped[1] : a;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return isPrivateIPv4(v4.split('.').map(Number));
  return a === '::' || a === '::1' || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')
    || a.startsWith('fc') || a.startsWith('fd');
}
