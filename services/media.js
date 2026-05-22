const { formatMessageForPrompt } = require('./context');
const { getArtifactAccessUrl } = require('./storage');
const { downloadTelegramFile } = require('./telegram');

const INLINE_AUDIO_MEDIA_KINDS = new Set(['audio', 'voice']);

async function buildCurrentBatchUserContent(currentBatch = [], options = {}) {
  if (!currentBatch.length) {
    return [
      {
        type: 'text',
        text: 'Current batched user inputs:\nNo user messages are queued.'
      }
    ];
  }

  const content = [
    {
      type: 'text',
      text: 'Current batched user inputs with multimodal artifacts when available:'
    }
  ];
  const audioDataCache = options.audioDataCache || new Map();
  const downloadAudioArtifact = options.downloadTelegramFile || downloadTelegramFile;

  for (const message of currentBatch) {
    content.push({
      type: 'text',
      text: formatMessageForPrompt(message)
    });

    const artifactPayload = await buildArtifactPayload(message, {
      audioDataCache,
      downloadTelegramFile: downloadAudioArtifact
    });
    content.push(...artifactPayload.parts);

    if (artifactPayload.fallbackLines.length) {
      content.push({
        type: 'text',
        text: artifactPayload.fallbackLines.join('\n')
      });
    }
  }

  return mergeAdjacentTextParts(content);
}

async function buildArtifactPayload(message, options) {
  const parts = [];
  const fallbackLines = [];

  for (const artifact of message.artifacts || []) {
    const artifactResult = await buildArtifactPart(artifact, options);

    if (artifactResult.part) {
      parts.push(artifactResult.part);
    }

    if (artifactResult.fallbackLine) {
      fallbackLines.push(artifactResult.fallbackLine);
    }
  }

  return {
    parts,
    fallbackLines
  };
}

async function buildArtifactPart(artifact, options) {
  const label = artifact.derivedFileName || artifact.originalFileName || artifact.mediaKind;

  if (INLINE_AUDIO_MEDIA_KINDS.has(artifact.mediaKind)) {
    return buildInlineAudioArtifactPart(artifact, label, options);
  }

  if (artifact.uploadStatus !== 'uploaded') {
    return {
      part: null,
      fallbackLine: `Artifact ${artifact.mediaKind}:${label} is not attached as a model input because upload status is ${artifact.uploadStatus}.`
    };
  }

  const accessUrl = await getArtifactAccessUrl(artifact);

  if (!accessUrl) {
    return {
      part: null,
      fallbackLine: `Artifact ${artifact.mediaKind}:${label} is uploaded but no readable URL could be generated for model input.`
    };
  }

  const artifactUrl = new URL(accessUrl);

  if (isImageArtifact(artifact)) {
    return {
      part: {
        type: 'image',
        image: artifactUrl,
        ...(artifact.mimeType ? { mediaType: artifact.mimeType } : {})
      },
      fallbackLine: null
    };
  }

  return {
    part: {
      type: 'file',
      data: artifactUrl,
      filename: label,
      mediaType: artifact.mimeType || 'application/octet-stream'
    },
    fallbackLine: null
  };
}

async function buildInlineAudioArtifactPart(artifact, label, options = {}) {
  if (!artifact.telegramFileId) {
    return {
      part: null,
      fallbackLine: `Artifact ${artifact.mediaKind}:${label} is missing a Telegram file id, so inline audio could not be fetched.`
    };
  }

  const audioDataCache = options.audioDataCache || new Map();
  const downloadAudioArtifact = options.downloadTelegramFile || downloadTelegramFile;

  try {
    let telegramFile = audioDataCache.get(artifact.telegramFileId);

    if (!telegramFile) {
      telegramFile = await downloadAudioArtifact(artifact.telegramFileId);
      audioDataCache.set(artifact.telegramFileId, telegramFile);
    }

    return {
      part: {
        type: 'file',
        data: telegramFile.binaryData,
        filename: label,
        mediaType: artifact.mimeType || inferAudioMediaType(telegramFile.filePath)
      },
      fallbackLine: null
    };
  } catch (error) {
    return {
      part: null,
      fallbackLine: `Artifact ${artifact.mediaKind}:${label} could not be fetched as inline audio input: ${error.message}`
    };
  }
}

function inferAudioMediaType(filePath = '') {
  const normalizedPath = String(filePath).toLowerCase();

  if (normalizedPath.endsWith('.ogg') || normalizedPath.endsWith('.oga')) {
    return 'audio/ogg';
  }

  if (normalizedPath.endsWith('.m4a') || normalizedPath.endsWith('.mp4')) {
    return 'audio/m4a';
  }

  if (normalizedPath.endsWith('.wav')) {
    return 'audio/wav';
  }

  if (normalizedPath.endsWith('.flac')) {
    return 'audio/flac';
  }

  return 'audio/mpeg';
}

function isImageArtifact(artifact) {
  return Boolean(
    artifact.mimeType?.startsWith('image/') ||
    artifact.mediaKind === 'photo'
  );
}

function mergeAdjacentTextParts(parts) {
  const mergedParts = [];

  for (const part of parts) {
    const previousPart = mergedParts[mergedParts.length - 1];

    if (part.type === 'text' && previousPart?.type === 'text') {
      previousPart.text = `${previousPart.text}\n${part.text}`;
      continue;
    }

    mergedParts.push(part);
  }

  return mergedParts;
}

module.exports = {
  buildCurrentBatchUserContent
};