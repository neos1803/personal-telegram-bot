require('dotenv').config();
const path = require('path');
const {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters
} = require('@azure/storage-blob');

const STORAGE_PROVIDER = 'azure-blob';
const DEFAULT_CONTAINER_NAME = 'personal-experiment';
const SUMMARY_WORD_LIMIT = 8;
const SUMMARY_CHARACTER_LIMIT = 80;

let containerClientPromise = null;
let blobServiceClient = null;
let sharedKeyCredential = undefined;

async function archiveArtifact({ descriptor, messageText = '', occurredAt, binaryData = null }) {
  const containerName = getContainerName();
  const summarySlug = createSummarySlug(messageText, descriptor.mediaKind);
  const fileExtension = resolveFileExtension(descriptor);
  const derivedFileName = `${summarySlug}--${descriptor.telegramFileUniqueId || Date.now()}${fileExtension}`;
  const blobPath = buildBlobPath(occurredAt, derivedFileName);

  const artifactRecord = {
    telegramFileId: descriptor.telegramFileId || null,
    telegramFileUniqueId: descriptor.telegramFileUniqueId || null,
    mediaKind: descriptor.mediaKind,
    mimeType: descriptor.mimeType || null,
    originalFileName: descriptor.originalFileName || null,
    derivedFileName,
    fileExtension,
    fileSizeBytes: descriptor.fileSizeBytes || (binaryData ? binaryData.length : null),
    telegramFilePath: descriptor.telegramFilePath || null,
    summarySlug,
    storageProvider: STORAGE_PROVIDER,
    containerName,
    blobPath,
    blobUrl: null,
    uploadStatus: 'unconfigured',
    uploadError: null,
    raw: descriptor.raw || null
  };

  if (!isAzureBlobStorageConfigured()) {
    artifactRecord.uploadError = 'AZURE_STORAGE_CONNECTION_STRING is not configured';
    return artifactRecord;
  }

  if (!binaryData) {
    artifactRecord.uploadStatus = 'download_failed';
    artifactRecord.uploadError = 'Artifact binary data was not provided';
    return artifactRecord;
  }

  try {
    const containerClient = await getContainerClient();
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

    await blockBlobClient.uploadData(binaryData, {
      blobHTTPHeaders: descriptor.mimeType
        ? { blobContentType: descriptor.mimeType }
        : undefined
    });

    artifactRecord.blobUrl = blockBlobClient.url;
    artifactRecord.uploadStatus = 'uploaded';

    return artifactRecord;
  } catch (error) {
    artifactRecord.uploadStatus = 'upload_failed';
    artifactRecord.uploadError = error.message;
    return artifactRecord;
  }
}

function isAzureBlobStorageConfigured() {
  return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING);
}

function getContainerName() {
  return process.env.AZURE_STORAGE_CONTAINER_NAME || DEFAULT_CONTAINER_NAME;
}

function createSummarySlug(messageText, fallbackLabel = 'attachment') {
  const normalizedText = String(messageText || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, ' ')
    .toLowerCase();

  const words = normalizedText
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, SUMMARY_WORD_LIMIT);

  const fallbackSlug = sanitizeSlug(fallbackLabel) || 'attachment';

  if (!words.length) {
    return fallbackSlug;
  }

  const slug = words.join('-').slice(0, SUMMARY_CHARACTER_LIMIT);
  return sanitizeSlug(slug) || fallbackSlug;
}

function buildBlobPath(occurredAt, derivedFileName) {
  const date = new Date(occurredAt || Date.now());
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}/${derivedFileName}`;
}

function resolveFileExtension(descriptor) {
  const fileNameExtension = path.extname(descriptor.originalFileName || '');
  if (fileNameExtension) {
    return normalizeExtension(fileNameExtension);
  }

  const telegramPathExtension = path.extname(descriptor.telegramFilePath || '');
  if (telegramPathExtension) {
    return normalizeExtension(telegramPathExtension);
  }

  if (descriptor.mimeType) {
    const mimeExtension = MIME_EXTENSION_MAP[descriptor.mimeType.toLowerCase()];
    if (mimeExtension) {
      return mimeExtension;
    }
  }

  if (descriptor.fallbackExtension) {
    return normalizeExtension(descriptor.fallbackExtension);
  }

  return '.bin';
}

function normalizeExtension(extension) {
  if (!extension) {
    return '.bin';
  }

  return extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}

function sanitizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function getContainerClient() {
  if (!containerClientPromise) {
    containerClientPromise = createContainerClient();
  }

  return containerClientPromise;
}

async function createContainerClient() {
  const resolvedBlobServiceClient = getBlobServiceClient();
  const containerClient = resolvedBlobServiceClient.getContainerClient(getContainerName());

  await containerClient.createIfNotExists();

  return containerClient;
}

async function getArtifactAccessUrl(artifact, expiresInMinutes = 60) {
  if (!artifact?.containerName || !artifact?.blobPath) {
    return artifact?.blobUrl || null;
  }

  try {
    const resolvedBlobServiceClient = getBlobServiceClient();
    const blockBlobClient = resolvedBlobServiceClient
      .getContainerClient(artifact.containerName)
      .getBlockBlobClient(artifact.blobPath);
    const credential = getSharedKeyCredential();

    if (!credential) {
      return artifact.blobUrl || blockBlobClient.url;
    }

    const startsOn = new Date(Date.now() - 5 * 60 * 1000);
    const expiresOn = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: artifact.containerName,
        blobName: artifact.blobPath,
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn
      },
      credential
    ).toString();

    return `${blockBlobClient.url}?${sas}`;
  } catch (error) {
    return artifact?.blobUrl || null;
  }
}

function getBlobServiceClient() {
  if (!blobServiceClient) {
    blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING
    );
  }

  return blobServiceClient;
}

function getSharedKeyCredential() {
  if (sharedKeyCredential !== undefined) {
    return sharedKeyCredential;
  }

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    sharedKeyCredential = null;
    return sharedKeyCredential;
  }

  const parts = parseConnectionString(connectionString);
  if (!parts.AccountName || !parts.AccountKey) {
    sharedKeyCredential = null;
    return sharedKeyCredential;
  }

  sharedKeyCredential = new StorageSharedKeyCredential(
    parts.AccountName,
    parts.AccountKey
  );

  return sharedKeyCredential;
}

function parseConnectionString(connectionString) {
  return String(connectionString || '')
    .split(';')
    .reduce((parts, segment) => {
      const separatorIndex = segment.indexOf('=');

      if (separatorIndex === -1) {
        return parts;
      }

      const key = segment.slice(0, separatorIndex);
      const value = segment.slice(separatorIndex + 1);
      parts[key] = value;
      return parts;
    }, {});
}

const MIME_EXTENSION_MAP = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/m4a': '.m4a',
  'audio/mp3': '.mp3',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm'
};

module.exports = {
  archiveArtifact,
  buildBlobPath,
  createSummarySlug,
  getArtifactAccessUrl,
  getContainerName,
  isAzureBlobStorageConfigured
};