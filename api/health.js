'use strict';

/*
 * GET /api/health
 * 노션 토큰/페이지 설정을 확인하고, 부모 페이지 아래의
 * 'DANI WAY ARCHIVE DB' 데이터베이스를 찾거나 없으면 새로 만든다.
 */

const lib = require('./_lib.js');

module.exports = lib.handle(['GET'], async function (req, res) {
  const pageId = lib.normalizeId(lib.parentPageId());

  // 토큰이 실제로 동작하는지 확인 (통합 이름을 함께 돌려준다)
  let botName = '';
  let workspace = '';
  try {
    const me = await lib.notionRequest('/users/me');
    botName = (me && me.name) || '';
    workspace = (me && me.bot && me.bot.workspace_name) || '';
  } catch (err) {
    if (err && err.status === 401) throw err;
    // users/me 가 막혀 있어도 데이터베이스 확인은 계속 진행한다
    botName = '';
  }

  const db = await lib.ensureDatabase({ create: true });

  return {
    service: 'daniway-archive',
    version: '3.1',
    pageId: pageId,
    pageIdFallback: lib.usesDefaultParentPage(),
    databaseId: db.id,
    databaseCreated: !!db.created,
    integration: botName,
    workspace: workspace,
    time: new Date().toISOString()
  };
});
