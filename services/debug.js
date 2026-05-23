require('dotenv').config();

const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG_LOGS || 'false'));

function debugLog(scope, message, data) {
  if (!DEBUG_ENABLED) {
    return;
  }

  const prefix = `[debug:${scope}] ${new Date().toISOString()} ${message}`;

  if (data === undefined) {
    console.log(prefix);
    return;
  }

  if (typeof data === 'string') {
    console.log(prefix, data);
    return;
  }

  try {
    console.log(prefix, JSON.stringify(data));
  } catch (error) {
    console.log(prefix, data);
  }
}

module.exports = {
  debugLog,
  isDebugEnabled: DEBUG_ENABLED
};