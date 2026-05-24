const INDONESIAN_PROMPT_TIME_ZONE = 'Asia/Jakarta';
const INDONESIAN_PROMPT_TIME_ZONE_LABEL = 'WIB';

const promptTimestampFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: INDONESIAN_PROMPT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function formatIndonesianPromptTimestamp(value) {
  const date = value instanceof Date
    ? value
    : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    return String(value || 'Unknown time');
  }

  const parts = Object.fromEntries(
    promptTimestampFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${INDONESIAN_PROMPT_TIME_ZONE_LABEL}`;
}

module.exports = {
  INDONESIAN_PROMPT_TIME_ZONE,
  INDONESIAN_PROMPT_TIME_ZONE_LABEL,
  formatIndonesianPromptTimestamp
};