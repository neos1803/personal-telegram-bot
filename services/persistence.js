const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_STALE_BATCH_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_DIR = path.join(process.cwd(), '.runtime');
const RUNTIME_DIR = process.env.RUNTIME_DATA_DIR
  ? path.resolve(process.env.RUNTIME_DATA_DIR)
  : DEFAULT_RUNTIME_DIR;
const DATABASE_PATH = path.join(RUNTIME_DIR, 'personal-telegram-bot.sqlite');

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

initializeSchema();

const getStateStatement = db.prepare(`
  SELECT value
  FROM app_state
  WHERE key = ?
`);

const setStateStatement = db.prepare(`
  INSERT INTO app_state (key, value, updated_at)
  VALUES (@key, @value, @updatedAt)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const upsertChatStatement = db.prepare(`
  INSERT INTO chats (
    chat_id,
    username,
    display_name,
    chat_type,
    updated_at
  ) VALUES (
    @chatId,
    @username,
    @displayName,
    @chatType,
    @updatedAt
  )
  ON CONFLICT(chat_id) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name,
    chat_type = excluded.chat_type,
    updated_at = excluded.updated_at
`);

const insertInboundMessageStatement = db.prepare(`
  INSERT OR IGNORE INTO messages (
    chat_id,
    telegram_message_id,
    telegram_update_id,
    direction,
    sender_id,
    sender_username,
    sender_display_name,
    is_from_bot,
    message_type,
    text_content,
    reply_to_message_id,
    occurred_at,
    raw_json
  ) VALUES (
    @chatId,
    @telegramMessageId,
    @telegramUpdateId,
    'inbound',
    @senderId,
    @senderUsername,
    @senderDisplayName,
    @isFromBot,
    @messageType,
    @textContent,
    @replyToMessageId,
    @occurredAt,
    @rawJson
  )
`);

const insertOutboundMessageStatement = db.prepare(`
  INSERT OR IGNORE INTO messages (
    chat_id,
    telegram_message_id,
    telegram_update_id,
    direction,
    sender_id,
    sender_username,
    sender_display_name,
    is_from_bot,
    message_type,
    text_content,
    reply_to_message_id,
    occurred_at,
    raw_json,
    processed_at
  ) VALUES (
    @chatId,
    @telegramMessageId,
    0,
    'outbound',
    @senderId,
    @senderUsername,
    @senderDisplayName,
    1,
    @messageType,
    @textContent,
    @replyToMessageId,
    @occurredAt,
    @rawJson,
    @processedAt
  )
`);

const insertArtifactStatement = db.prepare(`
  INSERT INTO artifacts (
    message_id,
    telegram_file_id,
    telegram_file_unique_id,
    media_kind,
    mime_type,
    original_file_name,
    derived_file_name,
    file_extension,
    file_size_bytes,
    telegram_file_path,
    summary_slug,
    storage_provider,
    container_name,
    blob_path,
    blob_url,
    upload_status,
    upload_error,
    raw_json,
    created_at
  ) VALUES (
    @messageId,
    @telegramFileId,
    @telegramFileUniqueId,
    @mediaKind,
    @mimeType,
    @originalFileName,
    @derivedFileName,
    @fileExtension,
    @fileSizeBytes,
    @telegramFilePath,
    @summarySlug,
    @storageProvider,
    @containerName,
    @blobPath,
    @blobUrl,
    @uploadStatus,
    @uploadError,
    @rawJson,
    @createdAt
  )
`);

const upsertPendingBatchStatement = db.prepare(`
  INSERT INTO pending_batches (
    chat_id,
    process_after,
    last_message_at,
    status,
    updated_at
  ) VALUES (
    @chatId,
    @processAfter,
    @lastMessageAt,
    'pending',
    @updatedAt
  )
  ON CONFLICT(chat_id) DO UPDATE SET
    process_after = excluded.process_after,
    last_message_at = excluded.last_message_at,
    status = 'pending',
    updated_at = excluded.updated_at
`);

const resetStaleBatchStatement = db.prepare(`
  UPDATE pending_batches
  SET status = 'pending',
      process_after = @now,
      updated_at = @now
  WHERE status = 'processing'
    AND updated_at <= @cutoff
`);

const selectReadyBatchesStatement = db.prepare(`
  SELECT chat_id, process_after, last_message_at, status, updated_at
  FROM pending_batches
  WHERE status = 'pending'
    AND process_after <= @now
  ORDER BY process_after ASC
  LIMIT @limit
`);

const claimBatchStatement = db.prepare(`
  UPDATE pending_batches
  SET status = 'processing',
      updated_at = @now
  WHERE chat_id = @chatId
    AND status = 'pending'
    AND process_after <= @now
`);

const selectPendingMessagesStatement = db.prepare(`
  SELECT *
  FROM messages
  WHERE chat_id = @chatId
    AND direction = 'inbound'
    AND processed_at IS NULL
  ORDER BY occurred_at ASC, id ASC
`);

const selectRecentMessagesStatement = db.prepare(`
  SELECT *
  FROM messages
  WHERE chat_id = @chatId
    AND occurred_at >= @cutoff
  ORDER BY occurred_at ASC, id ASC
`);

const selectActiveChatsStatement = db.prepare(`
  SELECT chats.chat_id, chats.username, chats.display_name, chats.chat_type, MAX(messages.occurred_at) AS last_message_at
  FROM chats
  INNER JOIN messages ON messages.chat_id = chats.chat_id
  WHERE messages.occurred_at >= @cutoff
  GROUP BY chats.chat_id, chats.username, chats.display_name, chats.chat_type
  ORDER BY last_message_at DESC
`);

const markMessageProcessedStatement = db.prepare(`
  UPDATE messages
  SET processed_at = @processedAt
  WHERE id = @id
`);

const completeBatchStatement = db.prepare(`
  DELETE FROM pending_batches
  WHERE chat_id = ?
`);

const rescheduleBatchStatement = db.prepare(`
  UPDATE pending_batches
  SET status = 'pending',
      process_after = @processAfter,
      updated_at = @updatedAt
  WHERE chat_id = @chatId
`);

const pruneMessagesStatement = db.prepare(`
  DELETE FROM messages
  WHERE occurred_at < @cutoff
`);

const pruneBatchesStatement = db.prepare(`
  DELETE FROM pending_batches
  WHERE last_message_at < @cutoff
`);

const saveInboundMessageTransaction = db.transaction((payload, batchDelayMs) => {
  upsertChat(payload.chat);

  const insertResult = insertInboundMessageStatement.run({
    chatId: payload.chat.chatId,
    telegramMessageId: payload.telegramMessageId,
    telegramUpdateId: payload.telegramUpdateId,
    senderId: payload.senderId,
    senderUsername: payload.senderUsername,
    senderDisplayName: payload.senderDisplayName,
    isFromBot: payload.isFromBot ? 1 : 0,
    messageType: payload.messageType,
    textContent: payload.textContent,
    replyToMessageId: payload.replyToMessageId,
    occurredAt: payload.occurredAt,
    rawJson: JSON.stringify(payload.raw)
  });

  if (!insertResult.changes) {
    return null;
  }

  if (Array.isArray(payload.artifacts) && payload.artifacts.length) {
    insertArtifacts(insertResult.lastInsertRowid, payload.artifacts, payload.occurredAt);
  }

  schedulePendingBatch(payload.chat.chatId, payload.occurredAt, batchDelayMs);

  return getMessageById(insertResult.lastInsertRowid);
});

function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      chat_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      chat_type TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      telegram_update_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      sender_id TEXT,
      sender_username TEXT,
      sender_display_name TEXT,
      is_from_bot INTEGER NOT NULL DEFAULT 0,
      message_type TEXT NOT NULL,
      text_content TEXT,
      reply_to_message_id INTEGER,
      occurred_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      processed_at TEXT,
      UNIQUE(chat_id, telegram_message_id, direction),
      FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_occurred_at
      ON messages (chat_id, occurred_at);

    CREATE INDEX IF NOT EXISTS idx_messages_chat_processed
      ON messages (chat_id, processed_at, direction);

    CREATE TABLE IF NOT EXISTS pending_batches (
      chat_id TEXT PRIMARY KEY,
      process_after TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(chat_id) REFERENCES chats(chat_id)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      telegram_file_id TEXT,
      telegram_file_unique_id TEXT,
      media_kind TEXT NOT NULL,
      mime_type TEXT,
      original_file_name TEXT,
      derived_file_name TEXT NOT NULL,
      file_extension TEXT,
      file_size_bytes INTEGER,
      telegram_file_path TEXT,
      summary_slug TEXT NOT NULL,
      storage_provider TEXT NOT NULL,
      container_name TEXT,
      blob_path TEXT,
      blob_url TEXT,
      upload_status TEXT NOT NULL,
      upload_error TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_message_id
      ON artifacts (message_id);
  `);
}

function getRetentionDays() {
  const parsedValue = Number.parseInt(
    process.env.MESSAGE_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS),
    10
  );

  if (Number.isNaN(parsedValue) || parsedValue < 1) {
    return DEFAULT_RETENTION_DAYS;
  }

  return parsedValue;
}

function getState(key) {
  const row = getStateStatement.get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  setStateStatement.run({
    key,
    value: String(value),
    updatedAt: new Date().toISOString()
  });
}

function getLastTelegramUpdateId() {
  const rawValue = getState('telegram.last_update_id');

  if (rawValue == null) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function setLastTelegramUpdateId(updateId) {
  setState('telegram.last_update_id', updateId);
}

function upsertChat(chat) {
  upsertChatStatement.run({
    chatId: chat.chatId,
    username: chat.username,
    displayName: chat.displayName,
    chatType: chat.chatType,
    updatedAt: new Date().toISOString()
  });
}

function saveInboundMessage(payload, batchDelayMs) {
  return saveInboundMessageTransaction(payload, batchDelayMs);
}

function saveOutboundMessage(payload) {
  upsertChat(payload.chat);

  const insertResult = insertOutboundMessageStatement.run({
    chatId: payload.chat.chatId,
    telegramMessageId: payload.telegramMessageId,
    senderId: payload.senderId,
    senderUsername: payload.senderUsername,
    senderDisplayName: payload.senderDisplayName,
    messageType: payload.messageType,
    textContent: payload.textContent,
    replyToMessageId: payload.replyToMessageId,
    occurredAt: payload.occurredAt,
    rawJson: JSON.stringify(payload.raw),
    processedAt: payload.occurredAt
  });

  if (!insertResult.changes) {
    return null;
  }

  return getMessageById(insertResult.lastInsertRowid);
}

function schedulePendingBatch(chatId, occurredAt, batchDelayMs) {
  const processAfter = new Date(new Date(occurredAt).getTime() + batchDelayMs).toISOString();
  const now = new Date().toISOString();

  upsertPendingBatchStatement.run({
    chatId,
    processAfter,
    lastMessageAt: occurredAt,
    updatedAt: now
  });
}

function claimReadyBatches(limit = 10) {
  resetStaleBatches();

  const now = new Date().toISOString();
  const rows = selectReadyBatchesStatement.all({ now, limit });
  const claimed = [];

  for (const row of rows) {
    const claimResult = claimBatchStatement.run({
      chatId: row.chat_id,
      now
    });

    if (claimResult.changes) {
      claimed.push(mapBatch(row));
    }
  }

  return claimed;
}

function resetStaleBatches(staleBatchMs = DEFAULT_STALE_BATCH_MS) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - staleBatchMs).toISOString();

  resetStaleBatchStatement.run({ now, cutoff });
}

function getPendingMessagesForChat(chatId) {
  return mapMessages(selectPendingMessagesStatement.all({ chatId }));
}

function getRecentMessages(chatId, retentionDays = getRetentionDays()) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  return mapMessages(selectRecentMessagesStatement.all({ chatId, cutoff }));
}

function getActiveChats(retentionDays = getRetentionDays()) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  return selectActiveChatsStatement.all({ cutoff }).map((row) => ({
    chatId: row.chat_id,
    username: row.username || '',
    displayName: row.display_name || row.username || String(row.chat_id),
    chatType: row.chat_type || 'private',
    lastMessageAt: row.last_message_at
  }));
}

function getAppState(key) {
  return getState(key);
}

function setAppState(key, value) {
  setState(key, value);
}

function markMessagesProcessed(messageIds) {
  const processedAt = new Date().toISOString();

  const transaction = db.transaction((ids) => {
    for (const id of ids) {
      markMessageProcessedStatement.run({ id, processedAt });
    }
  });

  transaction(messageIds);
}

function completeBatch(chatId) {
  completeBatchStatement.run(chatId);
}

function rescheduleBatch(chatId, delayMs = 60 * 1000) {
  const updatedAt = new Date().toISOString();
  const processAfter = new Date(Date.now() + delayMs).toISOString();

  rescheduleBatchStatement.run({
    chatId,
    processAfter,
    updatedAt
  });
}

function pruneExpiredData(retentionDays = getRetentionDays()) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  pruneMessagesStatement.run({ cutoff });
  pruneBatchesStatement.run({ cutoff });
}

function getRuntimeInfo() {
  return {
    databasePath: DATABASE_PATH,
    runtimeDirectory: RUNTIME_DIR,
    retentionDays: getRetentionDays()
  };
}

function getMessageById(id) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? mapMessages([row])[0] : null;
}

function insertArtifacts(messageId, artifacts, createdAt) {
  for (const artifact of artifacts) {
    insertArtifactStatement.run({
      messageId,
      telegramFileId: artifact.telegramFileId,
      telegramFileUniqueId: artifact.telegramFileUniqueId,
      mediaKind: artifact.mediaKind,
      mimeType: artifact.mimeType,
      originalFileName: artifact.originalFileName,
      derivedFileName: artifact.derivedFileName,
      fileExtension: artifact.fileExtension,
      fileSizeBytes: artifact.fileSizeBytes,
      telegramFilePath: artifact.telegramFilePath,
      summarySlug: artifact.summarySlug,
      storageProvider: artifact.storageProvider,
      containerName: artifact.containerName,
      blobPath: artifact.blobPath,
      blobUrl: artifact.blobUrl,
      uploadStatus: artifact.uploadStatus,
      uploadError: artifact.uploadError,
      rawJson: JSON.stringify(artifact.raw || null),
      createdAt
    });
  }
}

function mapMessages(rows) {
  const messages = rows.map(mapMessage);
  const artifactsByMessageId = getArtifactsByMessageIds(messages.map((message) => message.id));

  for (const message of messages) {
    message.artifacts = artifactsByMessageId.get(message.id) || [];
  }

  return messages;
}

function getArtifactsByMessageIds(messageIds) {
  const ids = messageIds.filter(Boolean);

  if (!ids.length) {
    return new Map();
  }

  const placeholders = ids.map(() => '?').join(', ');
  const statement = db.prepare(`
    SELECT *
    FROM artifacts
    WHERE message_id IN (${placeholders})
    ORDER BY id ASC
  `);
  const rows = statement.all(...ids);
  const artifactsByMessageId = new Map();

  for (const row of rows) {
    const artifact = mapArtifact(row);
    const messageArtifacts = artifactsByMessageId.get(row.message_id) || [];
    messageArtifacts.push(artifact);
    artifactsByMessageId.set(row.message_id, messageArtifacts);
  }

  return artifactsByMessageId;
}

function mapBatch(row) {
  return {
    chatId: row.chat_id,
    processAfter: row.process_after,
    lastMessageAt: row.last_message_at,
    status: row.status,
    updatedAt: row.updated_at
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    chatId: row.chat_id,
    telegramMessageId: row.telegram_message_id,
    telegramUpdateId: row.telegram_update_id,
    direction: row.direction,
    senderId: row.sender_id,
    senderUsername: row.sender_username,
    senderDisplayName: row.sender_display_name,
    isFromBot: Boolean(row.is_from_bot),
    messageType: row.message_type,
    textContent: row.text_content,
    replyToMessageId: row.reply_to_message_id,
    occurredAt: row.occurred_at,
    processedAt: row.processed_at,
    raw: safeJsonParse(row.raw_json)
  };
}

function mapArtifact(row) {
  return {
    id: row.id,
    messageId: row.message_id,
    telegramFileId: row.telegram_file_id,
    telegramFileUniqueId: row.telegram_file_unique_id,
    mediaKind: row.media_kind,
    mimeType: row.mime_type,
    originalFileName: row.original_file_name,
    derivedFileName: row.derived_file_name,
    fileExtension: row.file_extension,
    fileSizeBytes: row.file_size_bytes,
    telegramFilePath: row.telegram_file_path,
    summarySlug: row.summary_slug,
    storageProvider: row.storage_provider,
    containerName: row.container_name,
    blobPath: row.blob_path,
    blobUrl: row.blob_url,
    uploadStatus: row.upload_status,
    uploadError: row.upload_error,
    createdAt: row.created_at,
    raw: safeJsonParse(row.raw_json)
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

module.exports = {
  claimReadyBatches,
  completeBatch,
  getActiveChats,
  getAppState,
  getLastTelegramUpdateId,
  getPendingMessagesForChat,
  getRecentMessages,
  getRuntimeInfo,
  markMessagesProcessed,
  pruneExpiredData,
  rescheduleBatch,
  saveInboundMessage,
  saveOutboundMessage,
  setAppState,
  setLastTelegramUpdateId
};