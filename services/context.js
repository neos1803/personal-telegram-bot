const ROLE_LABELS = {
  inbound: 'user',
  outbound: 'assistant'
};
const { formatIndonesianPromptTimestamp } = require('./time');

function buildConversationSnapshot({ historyMessages = [], currentBatch = [] }) {
  const currentBatchIds = new Set(currentBatch.map((message) => message.id));
  const filteredHistory = historyMessages.filter((message) => !currentBatchIds.has(message.id));

  return {
    historyText: formatMessages(filteredHistory, 'No recent conversation history.'),
    currentBatchText: formatMessages(currentBatch, 'No user messages are queued.'),
    historyCount: filteredHistory.length,
    batchCount: currentBatch.length
  };
}

function formatMessages(messages, emptyValue) {
  if (!messages.length) {
    return emptyValue;
  }

  return messages
    .map((message) => formatMessageForPrompt(message))
    .join('\n');
}

function formatMessageForPrompt(message) {
  const role = ROLE_LABELS[message.direction] || (message.isFromBot ? 'assistant' : 'user');
  const timestamp = formatIndonesianPromptTimestamp(message.occurredAt);
  const content = message.textContent || formatMessageFallback(message);
  const artifactSummary = formatArtifactSummary(message.artifacts);

  return `[${timestamp}] ${role} (${message.messageType}): ${content}${artifactSummary}`;
}

function formatMessageFallback(message) {
  switch (message.messageType) {
    case 'photo':
      return '[photo attachment]';
    case 'document':
      return '[document attachment]';
    case 'audio':
      return '[audio attachment]';
    case 'voice':
      return '[voice message]';
    case 'video':
      return '[video attachment]';
    case 'video_note':
      return '[video note]';
    case 'animation':
      return '[animation attachment]';
    case 'sticker':
      return '[sticker]';
    case 'location':
      return '[location shared]';
    case 'venue':
      return '[venue shared]';
    case 'contact':
      return '[contact shared]';
    case 'poll':
      return '[poll shared]';
    default:
      return '[message without text content]';
  }
}

function formatArtifactSummary(artifacts = []) {
  if (!artifacts.length) {
    return '';
  }

  const summary = artifacts
    .map((artifact) => {
      const name = artifact.derivedFileName || artifact.originalFileName || artifact.mediaKind;
      const location = artifact.blobPath ? ` at ${artifact.blobPath}` : '';
      return `${artifact.mediaKind}:${name} (${artifact.uploadStatus}${location})`;
    })
    .join(', ');

  return ` | artifacts: ${summary}`;
}

module.exports = {
  buildConversationSnapshot,
  formatMessageForPrompt
};