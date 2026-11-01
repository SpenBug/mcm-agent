'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 判断 target 是否在 root 内（含 root 自身）。
 *
 * 不能只写 rel.startsWith('..')：Windows 跨盘时 path.relative 会返回
 * `D:\\secret` 这种绝对路径，不以 `..` 开头；另外 `..foo` 是合法文件名，
 * 不能和真正的父目录跳转混为一谈。
 */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === ''
    || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/** 把相对路径解析到 root 内；越界直接抛错。 */
function resolveInside(root, target, label = '路径') {
  const abs = path.resolve(root, target || '.');
  if (isInside(root, abs)) return abs;
  throw new Error(`${label} 越界：${target} 不在允许范围内（${root}）`);
}

/**
 * 对已存在的路径再做一次 realpath 校验，防止工作区里的符号链接 / junction
 * 指向外部后被 IPC 当成普通文件读取。
 *
 * 目标不存在时只做词法校验（后续 fs 操作会返回更准确的“文件不存在”）。
 */
function resolveExistingInside(root, target, label = '路径') {
  const abs = resolveInside(root, target, label);
  let realRoot;
  let realAbs;
  try {
    realRoot = fs.realpathSync.native(path.resolve(root));
    realAbs = fs.realpathSync.native(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return abs;
    throw err;
  }
  if (!isInside(realRoot, realAbs)) {
    throw new Error(`${label} 越界：${target} 指向了工作区外部`);
  }
  return abs;
}

module.exports = { isInside, resolveInside, resolveExistingInside };
