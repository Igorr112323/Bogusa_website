'use strict';

/** Ошибка с HTTP-статусом. Сообщения — на русском, без внутренних деталей. */
class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.extra = extra;
  }
}

const badRequest = (message, extra) => new ApiError(400, message, extra);
const unauthorized = (message = 'Требуется вход в систему') => new ApiError(401, message);
const forbidden = (message = 'Недостаточно прав') => new ApiError(403, message);
const notFound = (message = 'Не найдено') => new ApiError(404, message);
const conflict = (message) => new ApiError(409, message);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict };
