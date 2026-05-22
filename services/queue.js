const DEFAULT_BATCH_DELAY_MS = 2 * 60 * 1000;

function getBatchDelayMs() {
  const parsedValue = Number.parseInt(
    process.env.TELEGRAM_BATCH_DELAY_MS ?? String(DEFAULT_BATCH_DELAY_MS),
    10
  );

  if (Number.isNaN(parsedValue) || parsedValue < 1000) {
    return DEFAULT_BATCH_DELAY_MS;
  }

  return parsedValue;
}

module.exports = {
  DEFAULT_BATCH_DELAY_MS,
  getBatchDelayMs
};