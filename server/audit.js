'use strict';

/** Журнал действий (аудит). Никогда не логируем пароли и тексты ответов студентов. */

const { run, nowIso } = require('./db');
const config = require('./config');

function logAudit(req, action, { entity = null, entityId = null, details = null } = {}) {
  try {
    const actor = req && req.user ? req.user : null;
    const safeDetails =
      details === null || details === undefined
        ? null
        : JSON.stringify(details).slice(0, 4000);
    run(
      `INSERT INTO audit_log (actor_id, actor_login, actor_role, action, entity, entity_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      actor ? actor.id : null,
      actor ? actor.login : null,
      actor ? actor.role : 'anonymous',
      action,
      entity,
      entityId,
      safeDetails,
      nowIso()
    );
  } catch (err) {
    if (!config.IS_PROD) console.warn('[audit] не удалось записать событие:', err.message);
  }
}

function listAudit({ limit = 100 } = {}) {
  const { all } = require('./db');
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return all(
    `SELECT id, actor_login, actor_role, action, entity, entity_id, details, created_at
       FROM audit_log ORDER BY id DESC LIMIT ?`,
    safeLimit
  );
}

module.exports = { logAudit, listAudit };
