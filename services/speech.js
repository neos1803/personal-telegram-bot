require('dotenv').config();
const { randomUUID } = require('crypto');
const axios = require('axios');
const { debugLog } = require('./debug');
const { archiveRequestLog } = require('./storage');

const DEFAULT_GEMINI_TTS_VOICE = 'Leda';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_TTS_MODEL = process.env.OPENROUTER_TTS_MODEL || 'google/gemini-3.1-flash-tts-preview';
const OPENROUTER_TTS_VOICE = process.env.OPENROUTER_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE;
const OPENROUTER_TTS_SPEED = Number.parseFloat(process.env.OPENROUTER_TTS_SPEED ?? '1');
const OPENROUTER_TTS_RESPONSE_FORMAT = process.env.OPENROUTER_TTS_RESPONSE_FORMAT || 'pcm';
const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_TTS_VOICES = new Set([
  'zephyr',
  'puck',
  'charon',
  'kore',
  'fenrir',
  'leda',
  'orus',
  'aoede',
  'callirrhoe',
  'autonoe',
  'enceladus',
  'iapetus',
  'umbriel',
  'algieba',
  'despina',
  'erinome',
  'algenib',
  'rasalgethi',
  'laomedeia',
  'achernar',
  'alnilam',
  'schedar',
  'gacrux',
  'pulcherrima',
  'achird',
  'zubenelgenubi',
  'vindemiatrix',
  'sadachbia',
  'sadaltager',
  'sulafat'
]);

async function synthesizeSpeech({
  input = '',
  model = OPENROUTER_TTS_MODEL,
  voice = OPENROUTER_TTS_VOICE,
  responseFormat = OPENROUTER_TTS_RESPONSE_FORMAT,
  speed = OPENROUTER_TTS_SPEED,
  instructions = ''
} = {}) {
  const requestId = randomUUID();
  const occurredAt = new Date().toISOString();
  const normalizedInput = String(input || '').trim();
  const resolvedVoice = resolveSpeechVoice({ model, voice });
  const normalizedInstructions = String(instructions || '').trim();
  let responseMetadata = null;
  let loggedError = null;

  if (!normalizedInput) {
    throw new Error('OpenRouter speech synthesis requires non-empty input text');
  }

  const payload = {
    model,
    input: normalizedInput,
    voice: resolvedVoice,
    response_format: responseFormat
  };

  if (Number.isFinite(speed) && speed > 0) {
    payload.speed = speed;
  }

  if (normalizedInstructions) {
    payload.provider = {
      options: {
        openai: {
          instructions: normalizedInstructions
        }
      }
    };
  }

  debugLog('speech', 'Requesting speech synthesis', {
    requestId,
    model,
    requestedVoice: voice,
    voice: resolvedVoice,
    responseFormat,
    inputLength: normalizedInput.length
  });

  try {
    const response = await axios.post(
      `${OPENROUTER_API_BASE_URL}/audio/speech`,
      payload,
      {
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const audioBuffer = Buffer.from(response.data);

    debugLog('speech', 'Received speech synthesis audio', {
      requestId,
      model,
      voice: resolvedVoice,
      responseFormat,
      contentType: response.headers['content-type'] || getSpeechContentType(responseFormat),
      byteLength: audioBuffer.length,
      generationId: response.headers['x-generation-id'] || null
    });

    responseMetadata = {
      contentType: response.headers['content-type'] || getSpeechContentType(responseFormat),
      byteLength: audioBuffer.length,
      generationId: response.headers['x-generation-id'] || null
    };

    return {
      audioBuffer,
      contentType: response.headers['content-type'] || getSpeechContentType(responseFormat),
      generationId: response.headers['x-generation-id'] || null,
      responseFormat,
      model,
      voice: resolvedVoice,
      input: normalizedInput
    };
  } catch (error) {
    const speechError = extractSpeechErrorMessage(error);
    loggedError = serializeSpeechErrorForLog(error, speechError);
    console.error('Error calling OpenRouter speech API:', speechError);
    throw new Error(speechError);
  } finally {
    await persistSpeechRequestLog({
      requestId,
      occurredAt,
      model,
      requestedVoice: voice,
      resolvedVoice,
      responseFormat,
      speed,
      input: normalizedInput,
      instructions: normalizedInstructions,
      payload,
      responseMetadata,
      error: loggedError
    });
  }
}

function extractSpeechErrorMessage(error) {
  if (!error.response?.data) {
    return error.message;
  }

  try {
    const responseBody = Buffer.isBuffer(error.response.data)
      ? error.response.data.toString('utf8')
      : Buffer.from(error.response.data).toString('utf8');
    const parsedBody = JSON.parse(responseBody);
    return parsedBody?.error?.message || parsedBody?.message || error.message;
  } catch (parseError) {
    return error.message;
  }
}

function getSpeechContentType(responseFormat = '') {
  return String(responseFormat).toLowerCase() === 'pcm'
    ? 'audio/pcm'
    : 'audio/mpeg';
}

function resolveSpeechVoice({ model = '', voice = '' } = {}) {
  const normalizedModel = String(model || '').toLowerCase();
  const requestedVoice = String(voice || '').trim();
  const configuredDefaultVoice = String(OPENROUTER_TTS_VOICE || '').trim();

  if (!normalizedModel.includes('gemini')) {
    return requestedVoice || configuredDefaultVoice || DEFAULT_GEMINI_TTS_VOICE;
  }

  const normalizedRequestedVoice = requestedVoice.toLowerCase();

  if (GEMINI_TTS_VOICES.has(normalizedRequestedVoice)) {
    return requestedVoice;
  }

  const fallbackVoice = GEMINI_TTS_VOICES.has(configuredDefaultVoice.toLowerCase())
    ? configuredDefaultVoice
    : DEFAULT_GEMINI_TTS_VOICE;

  debugLog('speech', 'Falling back to a supported Gemini voice', {
    model,
    requestedVoice: requestedVoice || null,
    fallbackVoice
  });

  return fallbackVoice;
}

async function persistSpeechRequestLog({
  requestId,
  occurredAt,
  model,
  requestedVoice,
  resolvedVoice,
  responseFormat,
  speed,
  input,
  instructions,
  payload,
  responseMetadata,
  error
}) {
  try {
    const logRecord = await archiveRequestLog({
      category: 'request-logs/openrouter-speech',
      filePrefix: 'speech-synthesis',
      occurredAt,
      content: {
        requestId,
        loggedAt: new Date().toISOString(),
        service: 'openrouter-speech',
        request: {
          model,
          requestedVoice,
          resolvedVoice,
          responseFormat,
          speed,
          input,
          instructions,
          payload
        },
        response: error
          ? null
          : responseMetadata,
        error
      }
    });

    debugLog('speech', 'Stored speech request log', {
      requestId,
      uploadStatus: logRecord.uploadStatus,
      blobPath: logRecord.blobPath,
      uploadError: logRecord.uploadError || null
    });

    if (logRecord.uploadStatus !== 'uploaded') {
      console.error(`Speech request log upload failed for ${requestId}:`, logRecord.uploadError);
    }
  } catch (logError) {
    console.error(`Error storing speech request log for ${requestId}:`, logError.message);
  }
}

function serializeSpeechErrorForLog(error, normalizedMessage) {
  if (!error) {
    return null;
  }

  return {
    name: error.name || 'Error',
    message: normalizedMessage || error.message || 'Unknown error',
    stack: error.stack || null,
    status: error.response?.status || null
  };
}

module.exports = {
  synthesizeSpeech
};