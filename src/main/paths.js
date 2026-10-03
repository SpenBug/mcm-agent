'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

/**
 * 技能资源根目录。
 * 开发态：<project>/resources/skills
 * 打包后：<resources>/skills
 */
function getSkillsRoot() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'skills') : null,
    path.join(__dirname, '..', '..', 'resources', 'skills'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

/** 用户配置目录 */
function getUserDataDir() {
  return app.getPath('userData');
}

function getConfigPath() {
  return path.join(getUserDataDir(), 'config.json');
}

/** 应用私有 Python 环境目录 */
function getPythonEnvDir() {
  return path.join(getUserDataDir(), 'python-env');
}

/** 默认工作区：文档/数模智能体工作区 */
function getDefaultWorkspace() {
  return path.join(app.getPath('documents'), '数模智能体工作区');
}

function isDev() {
  return !app.isPackaged;
}

module.exports = {
  getSkillsRoot,
  getUserDataDir,
  getConfigPath,
  getPythonEnvDir,
  getDefaultWorkspace,
  isDev,
};
