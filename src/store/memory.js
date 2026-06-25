'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');

// Very small per-chat conversation store, persisted to a JSON file so the agent
// remembers context across restarts. For a handful of clients this is plenty;
// swap for SQLite/Redis later if volume grows.

const MAX_TURNS = 30; // keep the last N messages per chat to bound token usage

const dataDir = config.paths.data;
const storePath = path.join(dataDir, 'conversations.json');

let store = {};

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function load() {
  ensureDir();
  try {
    if (fs.existsSync(storePath)) {
      store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    }
  } catch (err) {
    store = {};
  }
}

let saveTimer = null;
function save() {
  // debounce writes so a burst of messages doesn't thrash the disk
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    ensureDir();
    try {
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
    } catch (err) {
      /* best-effort persistence */
    }
  }, 500);
}

function getHistory(chatId) {
  return store[chatId]?.messages ? [...store[chatId].messages] : [];
}

function appendMessage(chatId, role, content) {
  if (!store[chatId]) store[chatId] = { messages: [], lastReplyAt: 0 };
  store[chatId].messages.push({ role, content });
  // trim to the last MAX_TURNS, but never start the history on an assistant turn
  if (store[chatId].messages.length > MAX_TURNS) {
    store[chatId].messages = store[chatId].messages.slice(-MAX_TURNS);
    while (store[chatId].messages.length && store[chatId].messages[0].role !== 'user') {
      store[chatId].messages.shift();
    }
  }
  save();
}

function getLastReplyAt(chatId) {
  return store[chatId]?.lastReplyAt || 0;
}

function setLastReplyAt(chatId, ts) {
  if (!store[chatId]) store[chatId] = { messages: [], lastReplyAt: 0 };
  store[chatId].lastReplyAt = ts;
  save();
}

load();

module.exports = {
  getHistory,
  appendMessage,
  getLastReplyAt,
  setLastReplyAt,
};
