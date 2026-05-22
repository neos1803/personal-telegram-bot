require('dotenv').config();
const axios = require('axios');

const {
  getLastTelegramUpdateId,
  pruneExpiredData,
  saveInboundMessage,
  saveOutboundMessage,
  setLastTelegramUpdateId
} = require('./persistence');
const { archiveArtifact, isAzureBlobStorageConfigured } = require('./storage');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME;
const TELEGRAM_FETCH_LIMIT = Number.parseInt(process.env.TELEGRAM_FETCH_LIMIT ?? '25', 10);
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_TELEGRAM_CHUNK_DELAY_MS = 800;

function assertConfiguration() {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }
}

function getBaseUrl() {
  assertConfiguration();
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
}

async function callTelegram(method, payload = {}) {
  const response = await axios.post(`${getBaseUrl()}/${method}`, payload);

  if (!response.data?.ok) {
    throw new Error(response.data?.description || `Telegram ${method} failed`);
  }

  return response.data.result;
}

async function ingestUpdates(batchDelayMs) {
  pruneExpiredData();

  const lastUpdateId = getLastTelegramUpdateId();
  const updates = await callTelegram('getUpdates', {
    offset: lastUpdateId == null ? undefined : lastUpdateId + 1,
    limit: TELEGRAM_FETCH_LIMIT,
    allowed_updates: ['message']
  });

  let maxUpdateId = lastUpdateId;
  const storedMessages = [];

  for (const update of updates) {
    if (typeof update.update_id === 'number') {
      maxUpdateId = maxUpdateId == null
        ? update.update_id
        : Math.max(maxUpdateId, update.update_id);
    }

    if (!shouldTrackUpdate(update)) {
      continue;
    }

    const normalizedMessage = await normalizeUpdate(update);

    if (!normalizedMessage) {
      continue;
    }

    const savedMessage = saveInboundMessage(normalizedMessage, batchDelayMs);

    if (savedMessage) {
      storedMessages.push(savedMessage);
    }
  }

  if (maxUpdateId != null) {
    setLastTelegramUpdateId(maxUpdateId);
  }

  return {
    fetchedCount: updates.length,
    storedCount: storedMessages.length,
    lastUpdateId: maxUpdateId,
    messages: storedMessages
  };
}

async function sendTelegramMessage(chatId = '', text = '', options = {}) {
  const textChunks = splitOutgoingTextIntoMessages(text);
  const results = [];
  const sendMessageFn = options.sendMessageFn || ((payload) => callTelegram('sendMessage', payload));
  const persistMessageFn = options.persistMessageFn || saveOutboundMessage;
  const sleepFn = options.sleepFn || waitForDelay;
  const chunkDelayMs = options.chunkDelayMs ?? getTelegramChunkDelayMs();

  for (const [index, chunk] of textChunks.entries()) {
    const result = await sendMessageFn({
      chat_id: chatId,
      text: chunk,
      parse_mode: 'HTML'
    });

    const normalizedMessage = normalizeOutboundMessage(result);
    persistMessageFn(normalizedMessage);
    results.push(result);

    if (index < textChunks.length - 1 && chunkDelayMs > 0) {
      await sleepFn(chunkDelayMs);
    }
  }

  return results;
}

function getTelegramChunkDelayMs() {
  const parsedValue = Number.parseInt(
    process.env.TELEGRAM_CHUNK_DELAY_MS ?? String(DEFAULT_TELEGRAM_CHUNK_DELAY_MS),
    10
  );

  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    return DEFAULT_TELEGRAM_CHUNK_DELAY_MS;
  }

  return parsedValue;
}

function splitOutgoingTextIntoMessages(text = '', maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const normalizedText = String(text || '').trim();

  if (!normalizedText) {
    return [];
  }

  const paragraphs = normalizedText
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length <= 1) {
    return normalizedText.length <= maxLength
      ? [normalizedText]
      : splitLongParagraph(normalizedText, maxLength);
  }

  const chunks = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
      for (const paragraphChunk of splitLongParagraph(paragraph, maxLength)) {
        chunks.push(paragraphChunk);
      }

      continue;
    }

    chunks.push(paragraph);
  }

  return chunks;
}

function splitLongParagraph(paragraph, maxLength) {
  const words = paragraph.split(/\s+/).filter(Boolean);

  if (!words.length) {
    return [];
  }

  const chunks = [];
  let currentChunk = '';

  for (const word of words) {
    if (word.length > maxLength) {
      flushCurrentChunk(chunks, currentChunk);
      currentChunk = '';

      for (let index = 0; index < word.length; index += maxLength) {
        chunks.push(word.slice(index, index + maxLength));
      }

      continue;
    }

    const candidateChunk = currentChunk
      ? `${currentChunk} ${word}`
      : word;

    if (candidateChunk.length <= maxLength) {
      currentChunk = candidateChunk;
      continue;
    }

    flushCurrentChunk(chunks, currentChunk);
    currentChunk = word;
  }

  flushCurrentChunk(chunks, currentChunk);

  return chunks;
}

function flushCurrentChunk(chunks, currentChunk) {
  const normalizedChunk = String(currentChunk || '').trim();

  if (normalizedChunk) {
    chunks.push(normalizedChunk);
  }
}

function waitForDelay(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function shouldTrackUpdate(update) {
  const message = update?.message;

  if (!message?.chat) {
    return false;
  }

  if (!TELEGRAM_USERNAME) {
    return true;
  }

  const candidates = [
    message.chat.username,
    message.from?.username
  ].filter(Boolean);

  return candidates.includes(TELEGRAM_USERNAME);
}

async function normalizeUpdate(update) {
  const message = update?.message;

  if (!message?.chat || typeof message.message_id !== 'number') {
    return null;
  }

  const messageType = detectMessageType(message);
  const textContent = extractTextContent(message);
  const occurredAt = normalizeTimestamp(message.date);

  return {
    chat: normalizeChat(message.chat),
    telegramMessageId: message.message_id,
    telegramUpdateId: update.update_id,
    senderId: message.from?.id ? String(message.from.id) : null,
    senderUsername: message.from?.username || null,
    senderDisplayName: buildDisplayName(message.from, message.chat),
    isFromBot: Boolean(message.from?.is_bot),
    messageType,
    textContent,
    replyToMessageId: message.reply_to_message?.message_id || null,
    occurredAt,
    artifacts: await collectArtifacts({
      message,
      messageType,
      messageText: textContent,
      occurredAt
    }),
    raw: message
  };
}

function normalizeOutboundMessage(message) {
  return {
    chat: normalizeChat(message.chat),
    telegramMessageId: message.message_id,
    senderId: message.from?.id ? String(message.from.id) : null,
    senderUsername: message.from?.username || null,
    senderDisplayName: buildDisplayName(message.from, message.chat),
    messageType: detectMessageType(message),
    textContent: extractTextContent(message),
    replyToMessageId: message.reply_to_message?.message_id || null,
    occurredAt: normalizeTimestamp(message.date),
    raw: message
  };
}

function normalizeChat(chat) {
  return {
    chatId: String(chat.id),
    username: chat.username || '',
    displayName: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || chat.username || String(chat.id),
    chatType: chat.type || 'private'
  };
}

function detectMessageType(message) {
  if (message.text) {
    return 'text';
  }

  if (message.photo) {
    return 'photo';
  }

  if (message.document) {
    return 'document';
  }

  if (message.voice) {
    return 'voice';
  }

  if (message.audio) {
    return 'audio';
  }

  if (message.video_note) {
    return 'video_note';
  }

  if (message.video) {
    return 'video';
  }

  if (message.animation) {
    return 'animation';
  }

  if (message.sticker) {
    return 'sticker';
  }

  if (message.location) {
    return 'location';
  }

  if (message.venue) {
    return 'venue';
  }

  if (message.contact) {
    return 'contact';
  }

  if (message.poll) {
    return 'poll';
  }

  return 'unknown';
}

async function collectArtifacts({ message, messageType, messageText, occurredAt }) {
  const descriptors = getArtifactDescriptors(message, messageType);

  if (!descriptors.length) {
    return [];
  }

  const storageConfigured = isAzureBlobStorageConfigured();
  const artifacts = [];

  for (const descriptor of descriptors) {
    if (!storageConfigured) {
      artifacts.push(await archiveArtifact({
        descriptor,
        messageText,
        occurredAt,
        binaryData: null
      }));
      continue;
    }

    try {
      const telegramFile = await downloadTelegramFile(descriptor.telegramFileId);

      artifacts.push(await archiveArtifact({
        descriptor: {
          ...descriptor,
          telegramFilePath: telegramFile.filePath,
          fileSizeBytes: descriptor.fileSizeBytes || telegramFile.fileSizeBytes
        },
        messageText,
        occurredAt,
        binaryData: telegramFile.binaryData
      }));
    } catch (error) {
      artifacts.push({
        telegramFileId: descriptor.telegramFileId,
        telegramFileUniqueId: descriptor.telegramFileUniqueId,
        mediaKind: descriptor.mediaKind,
        mimeType: descriptor.mimeType || null,
        originalFileName: descriptor.originalFileName || null,
        derivedFileName: `${descriptor.mediaKind}--${descriptor.telegramFileUniqueId || Date.now()}${descriptor.fallbackExtension || '.bin'}`,
        fileExtension: descriptor.fallbackExtension || '.bin',
        fileSizeBytes: descriptor.fileSizeBytes || null,
        telegramFilePath: null,
        summarySlug: descriptor.mediaKind,
        storageProvider: 'azure-blob',
        containerName: process.env.AZURE_STORAGE_CONTAINER_NAME || 'personal-experiment',
        blobPath: null,
        blobUrl: null,
        uploadStatus: 'download_failed',
        uploadError: error.message,
        raw: descriptor.raw || null
      });
    }
  }

  return artifacts;
}

function getArtifactDescriptors(message, messageType) {
  switch (messageType) {
    case 'photo': {
      const largestPhoto = pickLargestPhoto(message.photo);
      return largestPhoto ? [
        createArtifactDescriptor({
          mediaKind: 'photo',
          telegramFileId: largestPhoto.file_id,
          telegramFileUniqueId: largestPhoto.file_unique_id,
          mimeType: 'image/jpeg',
          fileSizeBytes: largestPhoto.file_size,
          fallbackExtension: '.jpg',
          raw: largestPhoto
        })
      ] : [];
    }
    case 'document':
      return [
        createArtifactDescriptor({
          mediaKind: 'document',
          telegramFileId: message.document?.file_id,
          telegramFileUniqueId: message.document?.file_unique_id,
          mimeType: message.document?.mime_type,
          originalFileName: message.document?.file_name,
          fileSizeBytes: message.document?.file_size,
          fallbackExtension: '.bin',
          raw: message.document
        })
      ].filter(Boolean);
    case 'audio':
      return [
        createArtifactDescriptor({
          mediaKind: 'audio',
          telegramFileId: message.audio?.file_id,
          telegramFileUniqueId: message.audio?.file_unique_id,
          mimeType: message.audio?.mime_type || 'audio/mpeg',
          originalFileName: message.audio?.file_name,
          fileSizeBytes: message.audio?.file_size,
          fallbackExtension: '.mp3',
          raw: message.audio
        })
      ].filter(Boolean);
    case 'voice':
      return [
        createArtifactDescriptor({
          mediaKind: 'voice',
          telegramFileId: message.voice?.file_id,
          telegramFileUniqueId: message.voice?.file_unique_id,
          mimeType: message.voice?.mime_type || 'audio/ogg',
          originalFileName: null,
          fileSizeBytes: message.voice?.file_size,
          fallbackExtension: '.ogg',
          raw: message.voice
        })
      ].filter(Boolean);
    case 'video':
      return [
        createArtifactDescriptor({
          mediaKind: 'video',
          telegramFileId: message.video?.file_id,
          telegramFileUniqueId: message.video?.file_unique_id,
          mimeType: message.video?.mime_type || 'video/mp4',
          originalFileName: message.video?.file_name,
          fileSizeBytes: message.video?.file_size,
          fallbackExtension: '.mp4',
          raw: message.video
        })
      ].filter(Boolean);
    case 'video_note':
      return [
        createArtifactDescriptor({
          mediaKind: 'video_note',
          telegramFileId: message.video_note?.file_id,
          telegramFileUniqueId: message.video_note?.file_unique_id,
          mimeType: 'video/mp4',
          originalFileName: null,
          fileSizeBytes: message.video_note?.file_size,
          fallbackExtension: '.mp4',
          raw: message.video_note
        })
      ].filter(Boolean);
    case 'animation':
      return [
        createArtifactDescriptor({
          mediaKind: 'animation',
          telegramFileId: message.animation?.file_id,
          telegramFileUniqueId: message.animation?.file_unique_id,
          mimeType: message.animation?.mime_type || 'image/gif',
          originalFileName: message.animation?.file_name,
          fileSizeBytes: message.animation?.file_size,
          fallbackExtension: '.gif',
          raw: message.animation
        })
      ].filter(Boolean);
    case 'sticker':
      return [
        createArtifactDescriptor({
          mediaKind: 'sticker',
          telegramFileId: message.sticker?.file_id,
          telegramFileUniqueId: message.sticker?.file_unique_id,
          mimeType: resolveStickerMimeType(message.sticker),
          originalFileName: null,
          fileSizeBytes: message.sticker?.file_size,
          fallbackExtension: resolveStickerExtension(message.sticker),
          raw: message.sticker
        })
      ].filter(Boolean);
    default:
      return [];
  }
}

function createArtifactDescriptor(descriptor) {
  if (!descriptor.telegramFileId) {
    return null;
  }

  return descriptor;
}

function pickLargestPhoto(photos = []) {
  if (!Array.isArray(photos) || !photos.length) {
    return null;
  }

  return photos.reduce((largestPhoto, currentPhoto) => {
    if (!largestPhoto) {
      return currentPhoto;
    }

    return (currentPhoto.file_size || 0) >= (largestPhoto.file_size || 0)
      ? currentPhoto
      : largestPhoto;
  }, null);
}

async function downloadTelegramFile(fileId) {
  const fileMetadata = await callTelegram('getFile', { file_id: fileId });

  if (!fileMetadata?.file_path) {
    throw new Error(`Telegram file metadata for ${fileId} did not include a file_path`);
  }

  const response = await axios.get(
    `${getFileBaseUrl()}/${fileMetadata.file_path}`,
    { responseType: 'arraybuffer' }
  );

  return {
    filePath: fileMetadata.file_path,
    fileSizeBytes: fileMetadata.file_size || response.data?.byteLength || null,
    binaryData: Buffer.from(response.data)
  };
}

function getFileBaseUrl() {
  assertConfiguration();
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
}

function resolveStickerMimeType(sticker = {}) {
  if (sticker.is_video) {
    return 'video/webm';
  }

  if (sticker.is_animated) {
    return 'application/x-tgsticker';
  }

  return 'image/webp';
}

function resolveStickerExtension(sticker = {}) {
  if (sticker.is_video) {
    return '.webm';
  }

  if (sticker.is_animated) {
    return '.tgs';
  }

  return '.webp';
}

function extractTextContent(message) {
  if (message.text) {
    return message.text;
  }

  if (message.caption) {
    return message.caption;
  }

  const messageType = detectMessageType(message);

  switch (messageType) {
    case 'document':
      return `[document] ${message.document?.file_name || 'attachment'}`;
    case 'photo':
      return '[photo]';
    case 'audio':
      return `[audio] ${message.audio?.title || message.audio?.file_name || 'attachment'}`;
    case 'voice':
      return '[voice message]';
    case 'video':
      return `[video] ${message.video?.file_name || 'attachment'}`;
    case 'video_note':
      return '[video note]';
    case 'animation':
      return `[animation] ${message.animation?.file_name || 'attachment'}`;
    case 'sticker':
      return `[sticker] ${message.sticker?.emoji || ''}`.trim();
    case 'location':
      return `[location] ${message.location.latitude}, ${message.location.longitude}`;
    case 'venue':
      return `[venue] ${message.venue?.title || ''} ${message.venue?.address || ''}`.trim();
    case 'contact':
      return `[contact] ${[message.contact?.first_name, message.contact?.last_name].filter(Boolean).join(' ') || message.contact?.phone_number || 'shared contact'}`;
    case 'poll':
      return `[poll] ${message.poll?.question || 'shared poll'}`;
    default:
      return null;
  }
}

function buildDisplayName(sender, chat) {
  if (sender) {
    const fullName = [sender.first_name, sender.last_name].filter(Boolean).join(' ');
    return fullName || sender.username || String(sender.id || chat.id);
  }

  return [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || chat.username || String(chat.id);
}

function normalizeTimestamp(timestampInSeconds) {
  const timestamp = Number.isFinite(timestampInSeconds)
    ? timestampInSeconds
    : Math.floor(Date.now() / 1000);

  return new Date(timestamp * 1000).toISOString();
}

module.exports = {
  downloadTelegramFile,
  getTelegramChunkDelayMs,
  ingestUpdates,
  sendTelegramMessage,
  splitOutgoingTextIntoMessages
};