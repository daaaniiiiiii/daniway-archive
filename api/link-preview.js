'use strict';

/*
 * GET /api/link-preview?url=https://...
 * 서버에서 HTML을 받아 OG 태그(og:title, og:description, og:image)를 파싱한다.
 * - http/https만, 내부망/로컬 주소 차단
 * - 8초 제한, 900KB까지만 읽는다
 * - 외부 라이브러리 없이 정규식으로 메타 태그만 추출
 */

const lib = require('./_lib.js');

const MAX_BYTES = 900 * 1024;
const TIMEOUT_MS = 8000;

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal') return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.indexOf(':') >= 0) {
    // IPv6
    if (host === '::1' || host === '::' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
    return false;
  }
  if (!host.includes('.')) return true; // 단일 호스트명은 내부 주소로 본다
  return false;
}

async function readLimited(response) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    return text.slice(0, MAX_BYTES);
  }
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    total += chunk.length;
    chunks.push(chunk);
  }
  try { reader.cancel(); } catch (e) {}
  const merged = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(function (chunk) {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function (m, code) {
      const n = Number(code);
      return n > 0 && n < 0x10000 ? String.fromCharCode(n) : m;
    });
}

function metaTags(html) {
  const out = {};
  const re = /<meta\s+[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    const attrs = {};
    const attrRe = /([a-zA-Z:_-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;
    let attr;
    while ((attr = attrRe.exec(tag)) !== null) {
      const name = attr[1].toLowerCase();
      let value = attr[2] || '';
      if (value[0] === '"' || value[0] === "'") value = value.slice(1, -1);
      attrs[name] = value;
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (!key || attrs.content === undefined) continue;
    if (out[key] === undefined) out[key] = attrs.content;
  }
  return out;
}

function firstOf(meta, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = meta[keys[i]];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

module.exports = lib.handle(['GET'], async function (req, res) {
  const raw = String((req.query && req.query.url) || '').trim();
  if (!raw) throw new lib.ApiError(400, 'missing_url', 'url 파라미터가 필요해요.');
  if (raw.length > 2000) throw new lib.ApiError(400, 'bad_url', '주소가 너무 길어요.');

  let target;
  try { target = new URL(raw); } catch (e) { throw new lib.ApiError(400, 'bad_url', '올바른 주소가 아니에요.'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new lib.ApiError(400, 'bad_protocol', 'http/https 주소만 미리 볼 수 있어요.');
  }
  if (isPrivateHost(target.hostname)) {
    throw new lib.ApiError(400, 'private_host', '이 주소는 미리 볼 수 없어요.');
  }

  const controller = new AbortController();
  const timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, TIMEOUT_MS);
  let response;
  try {
    response = await fetch(target.href, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 DANIWAY-Preview',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.6'
      }
    });
  } catch (err) {
    clearTimeout(timer);
    throw new lib.ApiError(504, 'fetch_failed', '주소의 내용을 불러오지 못했어요.');
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new lib.ApiError(502, 'fetch_failed', '주소가 응답하지 않아요. (' + response.status + ')');
  }
  const finalUrl = response.url || target.href;
  try {
    const check = new URL(finalUrl);
    if (isPrivateHost(check.hostname)) throw new lib.ApiError(400, 'private_host', '이 주소는 미리 볼 수 없어요.');
  } catch (e) {
    if (e instanceof lib.ApiError) throw e;
  }

  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type && type.indexOf('text/html') < 0 && type.indexOf('text/xhtml') < 0 && type.indexOf('application/xml') < 0) {
    return { url: finalUrl, title: '', description: '', image: '', siteName: new URL(finalUrl).hostname, contentType: type, usable: false };
  }

  const html = await readLimited(response);
  const meta = metaTags(html);

  let title = firstOf(meta, ['og:title', 'twitter:title', 'title']);
  if (!title) {
    const m = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
    if (m) title = decodeEntities(m[1].replace(/\s+/g, ' ').trim());
  }
  const description = decodeEntities(firstOf(meta, ['og:description', 'twitter:description', 'description'])).slice(0, 300);
  let image = decodeEntities(firstOf(meta, ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']));
  if (image) {
    try { image = new URL(image, finalUrl).href; } catch (e) { image = ''; }
    if (!/^https?:\/\//i.test(image)) image = '';
  }
  const siteName = decodeEntities(firstOf(meta, ['og:site_name'])) || new URL(finalUrl).hostname.replace(/^www\./, '');

  return {
    url: finalUrl,
    title: decodeEntities(title).slice(0, 160),
    description: description,
    image: image.slice(0, 1200),
    siteName: siteName.slice(0, 80),
    usable: !!(title || description || image)
  };
});
