const { createHash } = require('crypto');
const cron = require('node-cron');
require('dotenv').config();

const { getRecentContributions } = require('./services/gitlab');
const { analyzeContributions } = require('./services/openrouter');
const { getActiveChats, getAppState, getRuntimeInfo, claimReadyBatches, completeBatch, getPendingMessagesForChat, getRecentMessages, markMessagesProcessed, pruneExpiredData, rescheduleBatch, setAppState } = require('./services/persistence');
const { getBatchDelayMs } = require('./services/queue');
const { ingestUpdates, sendTelegramMessage } = require('./services/telegram');

const TELEGRAM_POLL_CRON = process.env.TELEGRAM_POLL_CRON || '* * * * *';
const TELEGRAM_PROCESS_CRON = process.env.TELEGRAM_PROCESS_CRON || '* * * * *';
const TELEGRAM_PROACTIVE_CRON = process.env.TELEGRAM_PROACTIVE_CRON || '*/30 * * * *';
const GITLAB_LOOKBACK_DAYS = Number.parseInt(process.env.GITLAB_LOOKBACK_DAYS ?? '1', 10);

let ingestionInProgress = false;
let processingInProgress = false;
let proactiveInProgress = false;

async function runIngestion() {
  if (ingestionInProgress) {
    console.log('Skipping Telegram ingest tick because the previous run is still in progress.');
    return;
  }

  ingestionInProgress = true;

  try {
    const result = await ingestUpdates(getBatchDelayMs());

    console.log(
      `Telegram ingest completed. fetched=${result.fetchedCount} stored=${result.storedCount} lastUpdateId=${result.lastUpdateId ?? 'n/a'}`
    );
  } catch (error) {
    console.error('Error ingesting Telegram updates:', error.message);
  } finally {
    ingestionInProgress = false;
  }
}

/**
 * Process chats whose batch windows have elapsed.
 */
async function runPendingBatchProcessing() {
  if (processingInProgress) {
    console.log('Skipping pending batch tick because the previous run is still in progress.');
    return;
  }

  processingInProgress = true;

  try {
    pruneExpiredData();

    console.log('Running batch processor at:', new Date().toISOString());

    const readyBatches = claimReadyBatches();

    if (!readyBatches.length) {
      console.log('No pending chat batches are ready yet.');
      return;
    }

    console.log(`Found ${readyBatches.length} chat batch(es) ready for processing.`);

    const contributions = await getRecentContributions(GITLAB_LOOKBACK_DAYS);
    console.log(`GitLab contribution count for this tick: ${contributions.length}`);
    const processedChatIds = new Set();

    for (const batch of readyBatches) {
      try {
        processedChatIds.add(batch.chatId);
        const currentBatch = getPendingMessagesForChat(batch.chatId);

        if (!currentBatch.length) {
          console.log(`Batch for chat ${batch.chatId} became empty before processing; completing it without an AI call.`);
          completeBatch(batch.chatId);
          continue;
        }

        const historyMessages = getRecentMessages(batch.chatId);
        const analysis = await analyzeContributions({
          contributions,
          workingSchedule: '',
          historyMessages,
          currentBatch
        });
        logAnalysisDecision('batch', batch.chatId, analysis);

        if (analysis?.shouldText && analysis?.text) {
          await sendTelegramMessage(batch.chatId, analysis.text);
          console.log(`Sent batch-triggered reply to chat ${batch.chatId}.`);
        }

        markMessagesProcessed(currentBatch.map((message) => message.id));
        completeBatch(batch.chatId);
        setAppState(
          `proactive.last_context_hash.${batch.chatId}`,
          buildProactiveFingerprint({ contributions, historyMessages })
        );
      } catch (error) {
        console.error(`Error processing chat batch ${batch.chatId}:`, error.message);
        rescheduleBatch(batch.chatId);
      }
    }
  } catch (error) {
    console.error('Error in batch processor:', error.message);
  } finally {
    processingInProgress = false;
  }
}

async function runScheduledProactiveWellbeingChecks() {
  if (proactiveInProgress) {
    console.log('Skipping proactive wellbeing tick because the previous run is still in progress.');
    return;
  }

  if (processingInProgress) {
    console.log('Skipping proactive wellbeing tick because the batch processor is still running.');
    return;
  }

  proactiveInProgress = true;

  try {
    pruneExpiredData();

    console.log('Running proactive wellbeing check at:', new Date().toISOString());

    const activeChats = getActiveChats();

    if (!activeChats.length) {
      console.log('No recent chats are eligible for proactive evaluation.');
      return;
    }

    const contributions = await getRecentContributions(GITLAB_LOOKBACK_DAYS);
    console.log(`GitLab contribution count for proactive tick: ${contributions.length}`);

    await runProactiveWellbeingChecks({
      activeChats,
      contributions
    });
  } catch (error) {
    console.error('Error in proactive wellbeing processor:', error.message);
  } finally {
    proactiveInProgress = false;
  }
}

async function runProactiveWellbeingChecks({
  activeChats = [],
  contributions = [],
  skipChatIds = new Set()
} = {}) {
  if (!activeChats.length) {
    console.log('No recent chats are eligible for proactive evaluation.');
    return;
  }

  console.log(`Evaluating ${activeChats.length} recent chat(s) for proactive outreach.`);

  for (const chat of activeChats) {
    if (skipChatIds.has(chat.chatId)) {
      console.log(`Skipping proactive evaluation for chat ${chat.chatId} because it was already handled by the batch processor this tick.`);
      continue;
    }

    try {
      const currentBatch = getPendingMessagesForChat(chat.chatId);

      if (currentBatch.length) {
        console.log(`Skipping proactive evaluation for chat ${chat.chatId} because ${currentBatch.length} inbound message(s) are still pending.`);
        continue;
      }

      const historyMessages = getRecentMessages(chat.chatId);

      if (!historyMessages.length) {
        console.log(`Skipping proactive evaluation for chat ${chat.chatId} because no recent history is available.`);
        continue;
      }

      const fingerprint = buildProactiveFingerprint({ contributions, historyMessages });
      const stateKey = `proactive.last_context_hash.${chat.chatId}`;

      if (getAppState(stateKey) === fingerprint) {
        console.log(`Skipping proactive evaluation for chat ${chat.chatId} because conversation and contribution inputs are unchanged.`);
        continue;
      }

      const analysis = await analyzeContributions({
        contributions,
        workingSchedule: '',
        historyMessages,
        currentBatch: []
      });
      logAnalysisDecision('proactive', chat.chatId, analysis);

      if (analysis?.shouldText && analysis?.text) {
        await sendTelegramMessage(chat.chatId, analysis.text);
        console.log(`Sent proactive reply to chat ${chat.chatId}.`);
      }

      setAppState(stateKey, fingerprint);
    } catch (error) {
      console.error(`Error evaluating proactive outreach for chat ${chat.chatId}:`, error.message);
    }
  }
}

function buildProactiveFingerprint({ contributions = [], historyMessages = [] } = {}) {
  const inboundMessages = historyMessages
    .filter((message) => message.direction === 'inbound')
    .map((message) => ({
      id: message.id,
      occurredAt: message.occurredAt,
      messageType: message.messageType,
      textContent: message.textContent,
      artifacts: (message.artifacts || []).map((artifact) => artifact.id)
    }));

  return createHash('sha256')
    .update(JSON.stringify({ contributions, inboundMessages }))
    .digest('hex');
}

function logAnalysisDecision(mode, chatId, analysis) {
  const shouldText = Boolean(analysis?.shouldText && analysis?.text);
  const preview = shouldText
    ? analysis.text.replace(/\s+/g, ' ').slice(0, 120)
    : 'no outbound message';

  console.log(
    `[${mode}] AI decision for chat ${chatId}: shouldText=${shouldText} preview="${preview}"`
  );
}

const runtimeInfo = getRuntimeInfo();

cron.schedule(TELEGRAM_POLL_CRON, runIngestion);
cron.schedule(TELEGRAM_PROCESS_CRON, runPendingBatchProcessing);
cron.schedule(TELEGRAM_PROACTIVE_CRON, runScheduledProactiveWellbeingChecks);

console.log('Telegram ingest cron started:', TELEGRAM_POLL_CRON);
console.log('Telegram processing cron started:', TELEGRAM_PROCESS_CRON);
console.log('Telegram proactive cron started:', TELEGRAM_PROACTIVE_CRON);
console.log('SQLite runtime database:', runtimeInfo.databasePath);