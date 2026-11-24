'use strict';

/*
 * DANI WAY ARCHIVE — shared helpers for the Vercel serverless functions.
 * Pure Node.js (Node 18+ / 20): global fetch, FormData, Blob. No npm packages.
 *
 * The Notion integration token and the parent page id never reach the browser:
 * they live only in the Vercel environment variables NOTION_TOKEN / NOTION_PAGE_ID.
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DB_TITLE = 'DANI WAY ARCHIVE DB';

// NOTION_PAGE_ID 가 비어 있거나 UUID 형식이 아닐 때(예: ntn_ 토큰이 잘못 들어간 경우)
// 사용하는 기본 부모 페이지.
const DEFAULT_PARENT_PAGE_ID = '1ba770d2-ab63-4c15-ae7e-9b85cb87a76d';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status || 500;
    this.code = code || 'error';
    this.extra = extra || null;
  }
}

function applyCors(res) {
  Object.keys(CORS_HEADERS).forEach(function (key) {
    res.setHeader(key, CORS_HEADERS[key]);
  });
}

function send(res, status, body) {
  applyCors(res);
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function ok(res, data) {
  const body = Object.assign({ ok: true }, data || {});
  send(res, 200, body);
}

function fail(res, err) {
  const status = err && err.status ? err.status : 500;
  const code = err && err.code ? err.code : 'server_error';
  const message = err && err.message ? err.message : '알 수 없는 오류가 발생했어요.';
  const body = { ok: false, code: code, message: message };
  if (err && err.extra) body.detail = err.extra;
  if (status >= 500) console.error('[daniway]', code, message, (err && err.extra) || '');
  send(res, status, body);
}

function handle(methods, fn) {
  return async function (req, res) {
    try {
      if (req.method === 'OPTIONS') {
        applyCors(res);
        res.statusCode = 204;
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }
      if (methods.indexOf(req.method) < 0) {
        res.setHeader('Allow', methods.concat('OPTIONS').join(', '));
        throw new ApiError(405, 'method_not_allowed', req.method + ' 는 지원하지 않아요.');
      }
      const result = await fn(req, res);
      if (res.writableEnded) return;
      if (result === undefined) return ok(res, {});
      if (result && result.__status) {
        send(res, result.__status, result.body);
        return;
      }
      ok(res, result);
    } catch (err) {
      if (res.writableEnded) return;
      fail(res, err);
    }
  };
}

/* ---------- environment ---------- */

function envValue(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new ApiError(
      500,
      'missing_env',
      name + ' 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정에서 추가해 주세요.'
    );
  }
  return value;
}

function notionToken() {
  return envValue('NOTION_TOKEN');
}

function isUuidLike(value) {
  const id = String(value || '').replace(/-/g, '');
  return /^[0-9a-fA-F]{32}$/.test(id);
}

function parentPageId() {
  const value = String(process.env.NOTION_PAGE_ID || '').replace(/[\s\u200b]/g, '');
  if (isUuidLike(value)) return value;
  // 잘못된 값이 들어 있어도 앱이 멈추지 않도록 기본 부모 페이지로 동작한다.
  if (value) {
    console.warn('[daniway] NOTION_PAGE_ID is not a valid page UUID — using the default parent page');
  }
  return DEFAULT_PARENT_PAGE_ID;
}

function usesDefaultParentPage() {
  return !isUuidLike(String(process.env.NOTION_PAGE_ID || '').replace(/[\s\u200b]/g, ''));
}

function normalizeId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isUuidLike(raw)) {
    const id = raw.replace(/-/g, '').toLowerCase();
    return id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' +
      id.slice(16, 20) + '-' + id.slice(20);
  }
  return raw;
}

/* ---------- notion request ---------- */

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function notionRequest(path, options) {
  options = options || {};
  const attempt = options.attempt || 1;
  const headers = {
    Authorization: 'Bearer ' + notionToken(),
    'Notion-Version': NOTION_VERSION
  };
  let body;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    body = options.body; // FormData — let fetch set the boundary
  }

  let response;
  try {
    response = await fetch(NOTION_API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: body
    });
  } catch (err) {
    throw new ApiError(502, 'notion_unreachable', '노션 API에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  }

  if (response.status === 429 && attempt < 3) {
    const retry = Number(response.headers.get('retry-after') || 1);
    await sleep(Math.min(3, Math.max(1, retry)) * 1000);
    return notionRequest(path, Object.assign({}, options, { attempt: attempt + 1 }));
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 400) }; }
  }

  if (!response.ok) {
    const notionCode = data && data.code ? data.code : '';
    let message = (data && data.message) || '노션 API 오류가 발생했어요.';
    if (response.status === 401) {
      message = '노션 토큰이 올바르지 않아요. NOTION_TOKEN 값을 확인해 주세요.';
    } else if (response.status === 404) {
      message = '노션 페이지나 데이터베이스를 찾지 못했어요. 페이지에 통합(DANI WAY)이 연결되어 있는지 확인해 주세요.';
    } else if (notionCode === 'validation_error') {
      message = '노션 요청 형식이 맞지 않아요. (' + message + ')';
    }
    throw new ApiError(
      response.status === 401 ? 401 : response.status === 404 ? 404 : 502,
      notionCode || 'notion_error',
      message,
      { status: response.status }
    );
  }
  return data || {};
}

/* ---------- database discovery ---------- */

async function listBlockChildren(blockId) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const qs = '?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    const data = await notionRequest('/blocks/' + blockId + '/children' + qs);
    (data.results || []).forEach(function (block) { out.push(block); });
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
}

function databaseTitleOf(block) {
  if (!block || block.type !== 'child_database') return '';
  const title = block.child_database && block.child_database.title;
  return typeof title === 'string' ? title.trim() : '';
}

function pickExistingDatabase(blocks) {
  const databases = blocks.filter(function (block) { return block.type === 'child_database'; });
  if (!databases.length) return null;

  const exact = databases.find(function (block) {
    return databaseTitleOf(block) === DB_TITLE;
  });
  if (exact) return exact.id;

  const named = databases.find(function (block) {
    const title = databaseTitleOf(block).toUpperCase();
    return title.indexOf('DANI WAY') >= 0 || title.indexOf('ARCHIVE') >= 0;
  });
  if (named) return named.id;

  if (databases.length === 1) return databases[0].id;
  return null;
}

async function findDatabaseId() {
  const blocks = await listBlockChildren(normalizeId(parentPageId()));
  return pickExistingDatabase(blocks);
}

async function createDatabase() {
  const data = await notionRequest('/databases', {
    method: 'POST',
    json: {
      parent: { type: 'page_id', page_id: normalizeId(parentPageId()) },
      title: [{ type: 'text', text: { content: DB_TITLE } }],
      properties: {
        Title: { title: {} },
        '태그': { multi_select: {} },
        '작성일': { date: {} },
        '링크': { url: {} },
        '사진수': { number: {} }
      }
    }
  });
  return data.id;
}

let cachedDatabaseId = '';

async function ensureDatabase(options) {
  options = options || {};
  if (cachedDatabaseId) return { id: cachedDatabaseId, created: false, cached: true };
  let id = await findDatabaseId();
  if (id) {
    cachedDatabaseId = id;
    return { id: id, created: false, cached: false };
  }
  if (options.create === false) {
    throw new ApiError(404, 'database_missing', 'DANI WAY ARCHIVE DB 를 찾지 못했어요. 새로 만들려면 /api/health 를 먼저 불러 주세요.');
  }
  id = await createDatabase();
  cachedDatabaseId = id;
  return { id: id, created: true, cached: false };
}

/* ---------- page <-> entry mapping ---------- */

function plainText(richText) {
  if (!Array.isArray(richText)) return '';
  return richText.map(function (item) {
    if (!item) return '';
    if (item.plain_text) return item.plain_text;
    if (item.text && item.text.content) return item.text.content;
    return '';
  }).join('');
}

function propertyTitle(properties, name) {
  const prop = properties && (properties[name] || properties.Title);
  if (!prop || !Array.isArray(prop.title)) return '';
  return plainText(prop.title).trim();
}

function propertyTags(properties) {
  const prop = properties && properties['태그'];
  if (!prop || !Array.isArray(prop.multi_select)) return [];
  return prop.multi_select.map(function (item) { return String(item.name || '').trim(); })
    .filter(function (name) { return !!name; })
    .slice(0, 8);
}

function propertyDate(properties) {
  const prop = properties && properties['작성일'];
  const start = prop && prop.date && prop.date.start;
  if (!start) return '';
  const parsed = new Date(start);
  if (isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

function propertyUrl(properties) {
  const prop = properties && properties['링크'];
  return prop && typeof prop.url === 'string' ? prop.url : '';
}

function propertyNumber(properties, name) {
  const prop = properties && properties[name];
  const value = prop && typeof prop.number === 'number' ? prop.number : null;
  return value;
}

function pageTitleOf(page) {
  const properties = page.properties || {};
  const direct = propertyTitle(properties, 'Title');
  if (direct) return direct;
  const fallback = propertyTitle(properties, '이름') || propertyTitle(properties, 'Name');
  return fallback;
}

function fileUrlOf(block) {
  if (!block || block.type !== 'image') return '';
  const image = block.image || {};
  if (image.type === 'file' && image.file && image.file.url) return image.file.url;
  if (image.type === 'external' && image.external && image.external.url) return image.external.url;
  return '';
}

// 2열 column_list 안까지 문서 순서대로 훑는다 (사진 그리드 복원용)
function walkBlocks(blocks, visitor, depth) {
  (blocks || []).forEach(function (block) {
    if (!block) return;
    visitor(block);
    if (depth < 3 && Array.isArray(block.children) && block.children.length) {
      walkBlocks(block.children, visitor, depth + 1);
    }
  });
}

function entryFromPage(page, blocks) {
  const title = pageTitleOf(page);
  const tags = propertyTags(page.properties);
  const createdAt = propertyDate(page.properties) || page.created_time || new Date(0).toISOString();
  const link = propertyUrl(page.properties);
  const paragraphs = [];
  const photos = [];

  walkBlocks(blocks, function (block) {
    // 앱이 자동으로 넣은 상단 메타 callout / 구분선은 본문이 아니므로 건너뛴다
    if (isMetaBlock(block)) return;
    if (block.type === 'divider') return; // 구분선은 글자가 없으니 본문 복원에서 제외
    if (block.type === 'column_list' || block.type === 'column') return;
    if (block.type === 'paragraph') {
      const text = plainText(block.paragraph && block.paragraph.rich_text);
      if (text.trim()) {
        paragraphs.push(text);
      }
    } else if (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3') {
      const text = plainText(block[block.type] && block[block.type].rich_text);
      if (text.trim()) {
        paragraphs.push(text);
      }
    } else if (block.type === 'quote') {
      const text = plainText(block.quote && block.quote.rich_text);
      if (text.trim()) {
        paragraphs.push(text);
      }
    } else if (block.type === 'bookmark') {
      const url = block.bookmark && block.bookmark.url;
      if (url) {
        paragraphs.push(url);
      }
    } else if (block.type === 'image') {
      const url = fileUrlOf(block);
      if (url) {
        photos.push(url);
      }
    } else if (block.type === 'file') {
      const file = block.file || {};
      const url = (file.type === 'file' && file.file && file.file.url) ||
        (file.type === 'external' && file.external && file.external.url) || '';
      if (url) {
        photos.push(url);
      }
    }
  }, 0);

  let body = paragraphs.join('\n');
  if (link && body.indexOf(link) < 0) {
    body = body ? body + '\n' + link : link;
  }

  return {
    id: normalizeId(page.id),
    title: title,
    body: body,
    tags: tags,
    createdAt: createdAt,
    updatedAt: page.last_edited_time || null,
    link: link,
    photos: photos.slice(0, 10),
    photoCount: propertyNumber(page.properties, '사진수'),
    notionUrl: page.url || ''
  };
}

function hasColumnChildren(block) {
  return !!block && (block.type === 'column_list' || block.type === 'column');
}

// 페이지 블록을 읽으면서 column_list / column 안쪽 블록까지 children 에 채워 넣는다
async function loadBlockTree(blockId, depth) {
  const blocks = await listBlockChildren(blockId);
  if (depth >= 3) return blocks;
  await Promise.all(blocks.map(async function (block) {
    if (!hasColumnChildren(block)) return;
    try {
      block.children = await loadBlockTree(block.id, depth + 1);
    } catch (err) {
      block.children = [];
    }
  }));
  return blocks;
}

async function pageBlocks(pageId) {
  return loadBlockTree(normalizeId(pageId), 0);
}

/* ---------- write helpers ---------- */

function textChunks(text, size) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > size) {
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  if (rest) out.push(rest);
  return out;
}

function paragraphBlocks(text) {
  const blocks = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  lines.forEach(function (line) {
    if (!line.trim()) return;
    textChunks(line, 1900).forEach(function (chunk) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] }
      });
    });
  });
  return blocks;
}

function imageBlock(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') {
    if (!/^[0-9a-fA-F-]{32,36}$/.test(spec)) return null;
    return {
      object: 'block',
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: normalizeId(spec) } }
    };
  }
  if (spec.fileUploadId) {
    return {
      object: 'block',
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: normalizeId(spec.fileUploadId) } }
    };
  }
  if (spec.url && /^https?:\/\//i.test(spec.url)) {
    return {
      object: 'block',
      type: 'image',
      image: { type: 'external', external: { url: spec.url } }
    };
  }
  return null;
}

function bookmarkBlock(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { object: 'block', type: 'bookmark', bookmark: { url: url } };
}

/* ---------- Korean time ---------- */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad2(value) {
  return (value < 10 ? '0' : '') + value;
}

// 어떤 시각이든 한국시간 기준의 Date(UTC 필드를 한국시간으로 읽는 값)로 옮긴다
function kstDate(date) {
  const parsed = date instanceof Date ? date : new Date(date);
  const ms = isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
  return new Date(ms + KST_OFFSET_MS);
}

// 노션 `작성일` 속성용: 한국시간 오프셋(+09:00)을 붙인 ISO 문자열
function kstIsoString(date) {
  return kstDate(date).toISOString().slice(0, 19) + '+09:00';
}

// 작성일시가 시간대 없이 들어오면 한국시간으로 해석한다
function parseCreatedAt(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? new Date() : value;
  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    return isNaN(fromNumber.getTime()) ? new Date() : fromNumber;
  }
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return new Date();
  let iso = raw.replace(/\s+/, 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso = iso + 'T00:00:00+09:00';
  else if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso = iso + '+09:00';
  const parsed = new Date(iso);
  if (!isNaN(parsed.getTime())) return parsed;
  const fallback = new Date(raw);
  return isNaN(fallback.getTime()) ? new Date() : fallback;
}

function metaStamp(date) {
  const shifted = kstDate(date);
  return shifted.getUTCFullYear() + '.' + pad2(shifted.getUTCMonth() + 1) + '.' + pad2(shifted.getUTCDate()) +
    ' · ' + pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes());
}

/* ---------- page layout ---------- */

const META_ICON = '🗒️';
const META_STAMP_RE = /^\d{4}\.\d{2}\.\d{2} · \d{2}:\d{2}$/;

// 페이지 맨 위 메타 헤더: 작성일시(굵게) + 태그(회색) 한 덩어리
function metaBlocks(opts) {
  opts = opts || {};
  const tags = Array.isArray(opts.tags) ? opts.tags : [];
  const rich = [{ type: 'text', text: { content: metaStamp(opts.createdAt) }, annotations: { bold: true } }];
  if (tags.length) {
    rich.push({ type: 'text', text: { content: '\n' } });
    rich.push({
      type: 'text',
      text: { content: tags.map(function (tag) { return '#' + String(tag || '').trim(); }).join(' ') },
      annotations: { color: 'gray' }
    });
  }
  return [
    {
      object: 'block',
      type: 'callout',
      callout: {
        rich_text: rich,
        icon: { type: 'emoji', emoji: META_ICON },
        color: 'gray_background'
      }
    },
    { object: 'block', type: 'divider', divider: {} }
  ];
}

// 앱이 자동으로 넣은 메타 헤더인지 — 본문 복원 때 중복되지 않도록 걸러 낸다
function isMetaBlock(block) {
  if (!block || block.type !== 'callout') return false;
  const text = plainText(block.callout && block.callout.rich_text).trim();
  if (!text) return false;
  const lines = text.split('\n');
  if (!META_STAMP_RE.test(lines[0].trim())) return false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && line.charAt(0) !== '#') return false;
  }
  return true;
}

function columnListBlock(children) {
  return {
    object: 'block',
    type: 'column_list',
    column_list: {
      children: children.map(function (child) {
        return { object: 'block', type: 'column', column: { children: [child] } };
      })
    }
  };
}

// 사진 1장은 단독 image, 2장 이상은 두 장씩 2열 그리드로 (홀수 마지막은 단독 image)
function photoBlocks(specs) {
  const images = (specs || []).map(imageBlock).filter(Boolean);
  if (images.length < 2) return images;
  const out = [];
  for (let i = 0; i < images.length; i += 2) {
    const pair = images.slice(i, i + 2);
    if (pair.length === 1) out.push(pair[0]);
    else out.push(columnListBlock(pair));
  }
  return out;
}

// 기록 한 건의 페이지 블록: 메타 헤더 → 본문 문단 → 북마크 → 사진 그리드
function noteBlocks(opts) {
  opts = opts || {};
  const blocks = metaBlocks({ createdAt: opts.createdAt, tags: opts.tags });
  paragraphBlocks(opts.body).forEach(function (block) { blocks.push(block); });
  const bookmark = bookmarkBlock(opts.link);
  if (bookmark) blocks.push(bookmark);
  photoBlocks(opts.photos).forEach(function (block) { blocks.push(block); });
  return blocks;
}

// 중첩 블록까지 센 개수 (요청당 100블록 한도 계산용)
function countBlocksDeep(blocks) {
  let total = 0;
  (blocks || []).forEach(function (block) {
    total += 1;
    const body = block && block[block.type];
    if (body && Array.isArray(body.children)) total += countBlocksDeep(body.children);
  });
  return total;
}

// 한 요청에 넣을 수 있는 블록 수(중첩 포함 100)에 맞춰 앞에서부터 잘라 낸다
function takeBlockBatch(blocks, limit) {
  const batch = [];
  let total = 0;
  for (let i = 0; i < blocks.length; i++) {
    const deep = countBlocksDeep([blocks[i]]);
    if (total + deep > limit) break;
    total += deep;
    batch.push(blocks[i]);
  }
  return batch;
}

async function appendBlocks(pageId, blocks) {
  const queue = blocks.slice();
  while (queue.length) {
    const batch = queue.splice(0, 100);
    await notionRequest('/blocks/' + normalizeId(pageId) + '/children', {
      method: 'PATCH',
      json: { children: batch }
    });
  }
}

/* ---------- misc helpers ---------- */

function readJsonBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    const limit = limitBytes || 4.4 * 1024 * 1024;
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, 'payload_too_large', '이미지가 너무 커요. 조금 작은 사진으로 다시 시도해 주세요.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new ApiError(400, 'bad_json', '요청 본문을 읽지 못했어요.'));
      }
    });
    req.on('error', function () { reject(new ApiError(400, 'bad_request', '요청을 읽지 못했어요.')); });
  });
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').slice(0, max);
}

module.exports = {
  ApiError,
  DB_TITLE,
  DEFAULT_PARENT_PAGE_ID,
  usesDefaultParentPage,
  applyCors,
  send,
  ok,
  fail,
  handle,
  envValue,
  notionToken,
  parentPageId,
  normalizeId,
  isUuidLike,
  notionRequest,
  listBlockChildren,
  findDatabaseId,
  ensureDatabase,
  pageBlocks,
  entryFromPage,
  paragraphBlocks,
  imageBlock,
  bookmarkBlock,
  noteBlocks,
  countBlocksDeep,
  takeBlockBatch,
  metaBlocks,
  photoBlocks,
  isMetaBlock,
  kstIsoString,
  metaStamp,
  parseCreatedAt,
  appendBlocks,
  readJsonBody,
  cleanText,
  plainText,
  sleep
};
