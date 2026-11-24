'use strict';

/*
 * /api/notes
 *   GET            ?limit=30&nocache=1  — DANI WAY ARCHIVE DB의 최신 기록 + 본문 블록
 *   POST           { title, body, tags, link, images, imageUrls, createdAt }
 *   DELETE ?id=... — 페이지 보관(archived) 처리
 */

const lib = require('./_lib.js');

const MAX_NOTES = 50;
const DEFAULT_LIMIT = 30;
const BLOCK_CONCURRENCY = 3;

let listCache = { key: '', at: 0, notes: null };
const blockCache = new Map();
const BLOCK_CACHE_TTL = 10 * 60 * 1000;

function invalidateCache() {
  listCache = { key: '', at: 0, notes: null };
  blockCache.clear();
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let index = 0;
  const runners = [];
  const runnerCount = Math.min(limit, items.length);
  for (let i = 0; i < runnerCount; i++) {
    runners.push((async function () {
      while (index < items.length) {
        const current = index++;
        out[current] = await worker(items[current], current);
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

async function queryPages(databaseId, limit) {
  const base = { page_size: limit };
  try {
    const data = await lib.notionRequest('/databases/' + databaseId + '/query', {
      method: 'POST',
      json: Object.assign({}, base, { sorts: [{ property: '작성일', direction: 'descending' }] })
    });
    return data.results || [];
  } catch (err) {
    // 작성일 속성이 없거나 정렬할 수 없는 데이터베이스라면 정렬 없이 다시 조회한다
    if (err && (err.code === 'validation_error' || /sort/i.test(err.message || ''))) {
      const data = await lib.notionRequest('/databases/' + databaseId + '/query', {
        method: 'POST',
        json: base
      });
      return data.results || [];
    }
    throw err;
  }
}

async function loadNotes(databaseId, limit) {
  const pages = (await queryPages(databaseId, limit)).slice(0, limit);
  const notes = await mapLimit(pages, BLOCK_CONCURRENCY, async function (page) {
    let blocks = [];
    const cached = blockCache.get(page.id);
    if (cached && cached.edited === page.last_edited_time && (Date.now() - cached.at) < BLOCK_CACHE_TTL) {
      blocks = cached.blocks;
    } else {
      try {
        blocks = await lib.pageBlocks(page.id);
        blockCache.set(page.id, { edited: page.last_edited_time, at: Date.now(), blocks: blocks });
      } catch (err) {
        // 한 페이지의 블록을 못 읽어도 나머지 목록은 살린다
        blocks = [];
      }
    }
    const entry = lib.entryFromPage(page, blocks);
    entry.notionUrl = page.url || '';
    return entry;
  });
  return notes;
}

async function list(req, res) {
  const db = await lib.ensureDatabase({ create: true });
  const limitParam = Number(req.query && req.query.limit);
  const limit = Math.min(MAX_NOTES, Math.max(1, isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : DEFAULT_LIMIT));
  const nocache = !!(req.query && (req.query.nocache === '1' || req.query.nocache === 'true'));
  const key = db.id + ':' + limit;

  if (!nocache && listCache.notes && listCache.key === key && (Date.now() - listCache.at) < 20000) {
    return {
      databaseId: db.id,
      notes: listCache.notes,
      syncedAt: new Date(listCache.at).toISOString(),
      cached: true
    };
  }

  const notes = await loadNotes(db.id, limit);
  listCache = { key: key, at: Date.now(), notes: notes };
  return {
    databaseId: db.id,
    notes: notes,
    syncedAt: new Date(listCache.at).toISOString(),
    cached: false
  };
}

function buildProperties(input) {
  const title = lib.cleanText(input.title, 120).trim();
  const body = lib.cleanText(input.body, 8000);
  const firstLine = body.split('\n').map(function (line) { return line.trim(); })
    .filter(function (line) { return !!line; })[0] || '';
  const tags = [];
  if (Array.isArray(input.tags)) {
    input.tags.forEach(function (tag) {
      const name = lib.cleanText(String(tag || '').replace(/^#+/, ''), 24).trim();
      if (!name) return;
      if (tags.indexOf(name) >= 0 || tags.length >= 8) return;
      tags.push(name);
    });
  }

  const created = lib.parseCreatedAt(input.createdAt);
  const createdAt = created.toISOString();

  const properties = {
    Title: {
      title: [{ type: 'text', text: { content: (title || firstLine || '기록').slice(0, 2000) } }]
    },
    // 노션에서는 한국시간으로 보이도록 +09:00 오프셋을 붙여 저장한다
    '작성일': { date: { start: lib.kstIsoString(created) } }
  };
  if (tags.length) properties['태그'] = { multi_select: tags.map(function (name) { return { name: name }; }) };
  const link = lib.cleanText(input.link, 2000).trim();
  if (/^https?:\/\//i.test(link)) properties['링크'] = { url: link };

  return { properties: properties, createdAt: createdAt, created: created, title: title, body: body, tags: tags, link: link };
}

async function create(req, res) {
  const db = await lib.ensureDatabase({ create: true });
  const input = await lib.readJsonBody(req, 1.5 * 1024 * 1024);
  const built = buildProperties(input);

  const uploadIds = [];
  if (Array.isArray(input.images)) {
    input.images.forEach(function (value) {
      if (typeof value === 'string' && lib.isUuidLike(value) && uploadIds.length < 10) {
        uploadIds.push(lib.normalizeId(value));
      } else if (value && typeof value === 'object' && lib.isUuidLike(value.id) && uploadIds.length < 10) {
        uploadIds.push(lib.normalizeId(value.id));
      }
    });
  }
  const imageUrls = [];
  if (Array.isArray(input.imageUrls)) {
    input.imageUrls.forEach(function (url) {
      if (typeof url === 'string' && /^https?:\/\//i.test(url) && imageUrls.length + uploadIds.length < 10) {
        imageUrls.push(url);
      }
    });
  }

  const uploadSpecs = uploadIds.map(function (id) { return { fileUploadId: id }; });
  const urlSpecs = imageUrls.map(function (url) { return { url: url }; });
  const buildBatch = function (specs) {
    return lib.noteBlocks({
      createdAt: built.created,
      tags: built.tags,
      body: built.body,
      link: built.link,
      photos: specs
    });
  };

  let specs = uploadSpecs.concat(urlSpecs);
  let blocks = buildBatch(specs);

  const properties = Object.assign({}, built.properties);
  properties['사진수'] = { number: specs.length };

  const firstBatch = lib.takeBlockBatch(blocks, 100);

  const requestPage = function (children) {
    return lib.notionRequest('/pages', {
      method: 'POST',
      json: {
        parent: { database_id: db.id },
        properties: properties,
        children: children
      }
    });
  };

  let page;
  let createdCount = 0;
  try {
    page = await requestPage(firstBatch);
    createdCount = firstBatch.length;
  } catch (err) {
    // 외부 이미지 URL이 만료된 경우: 글·태그·업로드된 사진만으로 한 번 더 시도한다
    if (urlSpecs.length && err && /image|url|external/i.test(String(err.message || ''))) {
      console.warn('[daniway] retry without external images', err.message);
      specs = uploadSpecs;
      blocks = buildBatch(specs);
      properties['사진수'] = { number: specs.length };
      const retryBatch = lib.takeBlockBatch(blocks, 100);
      page = await requestPage(retryBatch);
      createdCount = retryBatch.length;
    } else {
      throw err;
    }
  }

  const rest = blocks.slice(createdCount);
  if (rest.length) {
    try {
      await lib.appendBlocks(page.id, rest);
    } catch (err) {
      console.warn('[daniway] overflow blocks failed', page.id, err && err.code);
    }
  }

  invalidateCache();

  return {
    note: {
      id: lib.normalizeId(page.id),
      title: built.title || lib.plainText((properties.Title.title || [])),
      body: built.body,
      tags: built.tags,
      createdAt: built.createdAt,
      images: specs.length,
      notionUrl: page.url || ''
    }
  };
}

async function remove(req, res) {
  const id = lib.normalizeId(req.query && req.query.id);
  if (!id || !lib.isUuidLike(id)) {
    throw new lib.ApiError(400, 'bad_id', '삭제할 기록 id가 올바르지 않아요.');
  }
  await lib.notionRequest('/pages/' + id, {
    method: 'PATCH',
    json: { archived: true }
  });
  invalidateCache();
  return { archived: id };
}

module.exports = lib.handle(['GET', 'POST', 'DELETE'], async function (req, res) {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return create(req, res);
  return remove(req, res);
});
