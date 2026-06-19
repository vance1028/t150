'use strict';

/** 统一响应：成功 { data, ... }，失败 { error: { message } }。 */

function sendData(res, status, data, extra = {}) {
  return res.status(status).json({ data, ...extra });
}

function sendError(res, status, message) {
  return res.status(status).json({ error: { message } });
}

/** 解析并校验路径上的整数 id。 */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('非法的 id');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

/** 构造带 statusCode 的业务错误，供服务层抛出、由统一错误中间件映射。 */
function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

module.exports = { sendData, sendError, parseId, httpError };
