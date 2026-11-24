'use strict';

/*
 * POST /api/upload
 * body: { filename, contentType, data }   data = base64 (data URL 접두사 허용)
 *
 * 프론트에서 1200px·JPEG로 줄인 사진 한 장을 노션 파일 업로드 API로 바로 올린다.
 * 1) POST /v1/file_uploads   (single_part)
 * 2) POST /v1/file_uploads/{id}/send  (multipart/form-data)
 * Vercel 요청 본문 한도(4.5MB)를 넘지 않도록 프론트가 장당 순차 업로드한다.
 */

const lib = require('./_lib.js');

const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

function sanitizeFilename(name, contentType) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[^\w.\-가-힣]/g, '_').slice(0, 80);
  const ext = ALLOWED[contentType] || 'jpg';
  if (!base) return 'daniway-' + Date.now() + '.' + ext;
  if (/\.(jpe?g|png|webp|gif)$/i.test(base)) return base.slice(0, 90);
  return base + '.' + ext;
}

async function createUpload(filename, contentType) {
  return lib.notionRequest('/file_uploads', {
    method: 'POST',
    json: { mode: 'single_part', filename: filename, content_type: contentType }
  });
}

async function sendUpload(uploadId, buffer, contentType, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);

  const attempt = async function (tryNo) {
    const response = await fetch('https://api.notion.com/v1/file_uploads/' + uploadId + '/send', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + lib.notionToken(),
        'Notion-Version': '2022-06-28'
      },
      body: form
    });
    if (response.status === 429 && tryNo < 3) {
      await lib.sleep(1500 * tryNo);
      return attempt(tryNo + 1);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 300) }; }
    if (!response.ok) {
      throw new lib.ApiError(
        502,
        (data && data.code) || 'upload_failed',
        '노션에 사진을 올리지 못했어요. (' + ((data && data.message) || response.status) + ')'
      );
    }
    return data || {};
  };

  return attempt(1);
}

module.exports = lib.handle(['POST'], async function (req, res) {
  lib.envValue('NOTION_TOKEN');
  lib.parentPageId(); // 설정 누락은 초기에 알려 준다

  const body = await lib.readJsonBody(req, 4.3 * 1024 * 1024);
  const rawType = String(body.contentType || 'image/jpeg').toLowerCase().split(';')[0].trim();
  const contentType = ALLOWED[rawType] ? (rawType === 'image/jpg' ? 'image/jpeg' : rawType) : '';
  if (!contentType) {
    throw new lib.ApiError(415, 'unsupported_type', 'JPG · PNG · WEBP · GIF 사진만 올릴 수 있어요.');
  }

  let base64 = String(body.data || '');
  const comma = base64.indexOf(',');
  if (comma >= 0 && base64.slice(0, comma).indexOf('base64') >= 0) base64 = base64.slice(comma + 1);
  base64 = base64.replace(/\s/g, '');
  if (!base64) throw new lib.ApiError(400, 'empty_file', '사진 데이터가 비어 있어요.');

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new lib.ApiError(400, 'empty_file', '사진 데이터를 읽지 못했어요.');
  if (buffer.length > 3.2 * 1024 * 1024) {
    throw new lib.ApiError(413, 'image_too_large', '사진 한 장이 너무 커요(3.2MB 초과). 조금 작은 사진으로 시도해 주세요.');
  }

  const filename = sanitizeFilename(body.filename, contentType);
  const created = await createUpload(filename, contentType);
  if (!created || !created.id) {
    throw new lib.ApiError(502, 'upload_failed', '노션 업로드 세션을 만들지 못했어요.');
  }
  const sent = await sendUpload(created.id, buffer, contentType, filename);

  return {
    file_upload_id: lib.normalizeId(sent.id || created.id),
    status: sent.status || 'uploaded',
    contentType: contentType,
    bytes: buffer.length
  };
});
