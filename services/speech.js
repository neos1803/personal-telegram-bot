require('dotenv').config();
const axios = require('axios');
const { debugLog } = require('./debug');

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
  const normalizedInput = String(input || '').trim();
  const resolvedVoice = resolveSpeechVoice({ model, voice });

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

  if (instructions) {
    payload.provider = {
      options: {
        openai: {
          instructions
        }
      }
    };
  }

  debugLog('speech', 'Requesting speech synthesis', {
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
      model,
      voice: resolvedVoice,
      responseFormat,
      contentType: response.headers['content-type'] || getSpeechContentType(responseFormat),
      byteLength: audioBuffer.length,
      generationId: response.headers['x-generation-id'] || null
    });

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
    console.error('Error calling OpenRouter speech API:', speechError);
    throw new Error(speechError);
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

module.exports = {
  synthesizeSpeech
};