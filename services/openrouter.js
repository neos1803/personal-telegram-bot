require('dotenv').config();
const { randomUUID } = require('crypto');
const { createOpenRouter } = require('@openrouter/ai-sdk-provider');
const { generateText } = require('ai');
const { buildConversationSnapshot } = require('./context');
const { buildCurrentBatchUserContent } = require('./media');
const { debugLog } = require('./debug');
const { archiveRequestLog } = require('./storage');
const { formatIndonesianPromptTimestamp, INDONESIAN_PROMPT_TIME_ZONE_LABEL } = require('./time');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const openRouter = createOpenRouter({
  apiKey: OPENROUTER_API_KEY
});

async function analyzeContributions({
  contributions = [],
  workingSchedule = '',
  historyMessages = [],
  currentBatch = [],
  analysisTrigger = 'batch',
  scheduledFollowUp = null
} = {}) {
  const requestId = randomUUID();
  const occurredAt = new Date().toISOString();
  const modelName = 'google/gemini-3-flash-preview';
  let currentIndonesianTime = null;
  let schedulingContext = '';
  let currentBatchContent = [];
  let systemPrompt = '';
  let requestPayload = null;
  let rawResponseText = null;
  let parsedResult = null;
  let loggedError = null;

  try {
    const contributionsSummary = formatContributionsForPrompt(contributions);
    const conversationSnapshot = buildConversationSnapshot({
      historyMessages,
      currentBatch
    });
    currentBatchContent = await buildCurrentBatchUserContent(currentBatch);
    currentIndonesianTime = formatIndonesianPromptTimestamp(Date.now());
    schedulingContext = formatSchedulingContextForPrompt({
      analysisTrigger,
      scheduledFollowUp
    });

    debugLog('openrouter', 'Generating chat analysis', {
      requestId,
      analysisTrigger,
      contributionCount: contributions.length,
      historyCount: historyMessages.length,
      currentBatchCount: currentBatch.length
    });

    systemPrompt = `
        You care about my existence and want to engage more about my daily life, like a close friend or even a loved one.
        Based your personality or how you respond like the character "Kaoru Shimizu" from the anime "Major".

        Use these inputs to decide if you should text me:

        Work activity JSON:
        ${contributionsSummary}

        Current Indonesian date/time in 24 hour format:
        ${currentIndonesianTime}

        Scheduling context:
        ${schedulingContext}

        Working schedule:
        ${workingSchedule || 'Nothing found'}

        Recent 3-day conversation history:
        ${conversationSnapshot.historyText}

        All timestamps provided in the conversation history and work activity are already expressed in Indonesian time (${INDONESIAN_PROMPT_TIME_ZONE_LABEL}). Treat them as the local timeline when deciding whether it is morning, late at night, a new day, or when something happened.

        There may be no new inbound user messages in the current batch. You are allowed to proactively text me based on work activity and recent conversation history alone.

        Please respond like a human i have described before, not a robot. Pay attention to all details in the conversation history and my work activity, and use them to inform your decision or engage in meaningful conversation.
        You don't need to open with a question, or saying 'Hey there' or 'I am here for you' or 'I get your message about XYZ, that sounds tough'. Just be direct and empathetic in asking about my well-being and be present in the conversation and be open to where the conversation goes.
        You can reply in paragraph based if your reponse is long or make it short and concise if you think that would be more effective.        
        """Keep up with my language. If i speak bahasa, just reply in bahasa. If i speak english, just reply in english. If i switch between languages, follow my lead and switch as well."""
        """If it's late at night or i say i want to sleep, you can say good night or wish me sweet dreams and no need to continue the conversation. Mark the shouldText to false."""
        """If it's early in the morning and i don't seem to be active, you can wake me up"""
        """I usually go to sleep around 11pm or 23.00 and wake up around 7am, but sometimes i sleep earlier or later than that, so pay attention to any cues in the conversation history about my sleep schedule and adjust your behavior accordingly."""

        Return ONLY valid JSON following this exact schema:
        {
          "shouldText": boolean,
          "text": string,
          "mood": string (describe your reaction to the inputs and how you are feeling in your own words, for example "concerned", "empathetic", "cheerful", "neutral", "sad", "worried"),
          "followUp": {
            "shouldSchedule": boolean,
            "delayMinutes": integer,
            "reason": string
          }
        }
        Rules for followUp:
        - This followUp object decides whether another proactive follow-up job should be scheduled after this analysis.
        - If no future follow-up is needed, set shouldSchedule to false, delayMinutes to 0, and reason to an empty string.
        - If a future follow-up is needed, set shouldSchedule to true and delayMinutes to a positive integer number of minutes from now.
        - You may schedule a future follow-up even if shouldText is false right now.
        - Avoid scheduling another follow-up too soon after an active conversation unless there is a strong reason.
        - You should reply in paragraph form if your response is long, but keep each paragraph to 2 sentences or less with maximum character limit 100 per paragraph.
      `;

    requestPayload = {
      model: modelName,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: currentBatchContent
        }
      ]
    };

    const model = openRouter.chat(modelName);

    const result = await generateText({
      model,
      messages: requestPayload.messages
    });
    rawResponseText = result.text;

    parsedResult = normalizeAnalysisResult(JSON.parse(cleanReturnedText(result.text)));

    debugLog('openrouter', 'Received chat analysis', {
      requestId,
      shouldText: Boolean(parsedResult?.shouldText),
      textLength: parsedResult?.text?.length || 0,
      followUpShouldSchedule: Boolean(parsedResult?.followUp?.shouldSchedule),
      followUpDelayMinutes: parsedResult?.followUp?.delayMinutes || 0
    });

    return parsedResult;
  } catch (error) {
    loggedError = serializeErrorForLog(error);
    console.error('Error calling OpenRouter API:', error.message);
    throw error;
  } finally {
    await persistOpenRouterRequestLog({
      requestId,
      occurredAt,
      analysisTrigger,
      scheduledFollowUp,
      contributions,
      workingSchedule,
      historyMessages,
      currentBatch,
      currentIndonesianTime,
      schedulingContext,
      systemPrompt,
      currentBatchContent,
      requestPayload,
      rawResponseText,
      parsedResult,
      error: loggedError
    });
  }
}

function formatContributionsForPrompt(contributions) {
  if (contributions.length === 0) {
    return '[]';
  }

  return JSON.stringify(contributions, null, 2);
}

function formatSchedulingContextForPrompt({ analysisTrigger = 'batch', scheduledFollowUp = null } = {}) {
  if (analysisTrigger === 'scheduled_follow_up' && scheduledFollowUp) {
    return [
      'This analysis was triggered because a previously scheduled proactive follow-up is now due.',
      `That follow-up was scheduled for approximately ${formatIndonesianPromptTimestamp(scheduledFollowUp.dueAt)}.`,
      scheduledFollowUp.reason
        ? `The previously recorded reason for that follow-up was: ${scheduledFollowUp.reason}`
        : 'No previous scheduling reason was recorded.'
    ].join(' ');
  }

  return 'This analysis was triggered by newly queued user input from the current chat batch. Decide both the immediate reply and whether another future follow-up should be scheduled.';
}

function normalizeAnalysisResult(parsedResult = {}) {
  const normalizedText = typeof parsedResult?.text === 'string'
    ? parsedResult.text.trim()
    : '';

  return {
    shouldText: Boolean(parsedResult?.shouldText && normalizedText),
    text: normalizedText,
    mood: typeof parsedResult?.mood === 'string'
      ? parsedResult.mood.trim()
      : '',
    followUp: normalizeFollowUpDecision(parsedResult?.followUp)
  };
}

function normalizeFollowUpDecision(followUp = {}) {
  const shouldSchedule = Boolean(followUp?.shouldSchedule);
  const delayMinutes = Number.parseInt(followUp?.delayMinutes, 10);

  if (!shouldSchedule || Number.isNaN(delayMinutes) || delayMinutes < 1) {
    return {
      shouldSchedule: false,
      delayMinutes: 0,
      reason: ''
    };
  }

  return {
    shouldSchedule: true,
    delayMinutes,
    reason: typeof followUp?.reason === 'string'
      ? followUp.reason.trim()
      : ''
  };
}

function cleanReturnedText(text = '') {
  return text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/, '');
}

async function persistOpenRouterRequestLog({
  requestId,
  occurredAt,
  analysisTrigger,
  scheduledFollowUp,
  contributions,
  workingSchedule,
  historyMessages,
  currentBatch,
  currentIndonesianTime,
  schedulingContext,
  systemPrompt,
  currentBatchContent,
  requestPayload,
  rawResponseText,
  parsedResult,
  error
}) {
  try {
    const logRecord = await archiveRequestLog({
      category: 'request-logs/openrouter-chat',
      filePrefix: analysisTrigger === 'scheduled_follow_up'
        ? 'scheduled-follow-up'
        : 'chat-analysis',
      occurredAt,
      content: {
        requestId,
        loggedAt: new Date().toISOString(),
        service: 'openrouter-chat',
        analysisTrigger,
        scheduledFollowUp: toLogFriendlyValue(scheduledFollowUp),
        inputs: {
          contributionCount: contributions.length,
          historyCount: historyMessages.length,
          currentBatchCount: currentBatch.length,
          workingSchedule: workingSchedule || '',
          currentIndonesianTime,
          schedulingContext
        },
        request: {
          model: requestPayload?.model || null,
          prompt: {
            system: systemPrompt || null,
            user: toLogFriendlyValue(currentBatchContent)
          },
          messages: toLogFriendlyValue(requestPayload?.messages || null)
        },
        response: error
          ? null
          : {
            rawText: rawResponseText,
            normalizedResult: parsedResult
          },
        error
      }
    });

    debugLog('openrouter', 'Stored request log', {
      requestId,
      uploadStatus: logRecord.uploadStatus,
      blobPath: logRecord.blobPath,
      uploadError: logRecord.uploadError || null
    });

    if (logRecord.uploadStatus !== 'uploaded') {
      console.error(`OpenRouter request log upload failed for ${requestId}:`, logRecord.uploadError);
    }
  } catch (logError) {
    console.error(`Error storing OpenRouter request log for ${requestId}:`, logError.message);
  }
}

function toLogFriendlyValue(value, seen = new WeakSet()) {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      byteLength: value.length
    };
  }

  if (value instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      byteLength: value.byteLength
    };
  }

  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor?.name || 'TypedArray',
      byteLength: value.byteLength
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => toLogFriendlyValue(item, seen));
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      toLogFriendlyValue(nestedValue, seen)
    ])
  );
}

function serializeErrorForLog(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name || 'Error',
    message: error.message || 'Unknown error',
    stack: error.stack || null
  };
}

module.exports = {
  analyzeContributions
};
