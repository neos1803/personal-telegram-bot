const cron = require('node-cron');
require('dotenv').config();

const { getRecentContributions } = require('./services/gitlab');
const { analyzeContributions } = require('./services/openrouter');
const {
  claimDueProactiveJobs,
  claimReadyBatches,
  completeBatch,
  deleteProactiveJob,
  getRuntimeInfo,
  getPendingMessagesForChat,
  getRecentMessages,
  markMessagesProcessed,
  pruneExpiredData,
  rescheduleBatch,
  rescheduleProactiveJob,
  scheduleProactiveJob
} = require('./services/persistence');
const { getBatchDelayMs } = require('./services/queue');
const { ingestUpdates, sendTelegramMessage } = require('./services/telegram');
const { debugLog } = require('./services/debug');
const { formatIndonesianPromptTimestamp } = require('./services/time');

const TELEGRAM_POLL_CRON = process.env.TELEGRAM_POLL_CRON || '* * * * *';
const TELEGRAM_PROCESS_CRON = process.env.TELEGRAM_PROCESS_CRON || '* * * * *';
const GITLAB_LOOKBACK_DAYS = Number.parseInt(process.env.GITLAB_LOOKBACK_DAYS ?? '1', 10);

let ingestionInProgress = false;
let processingInProgress = false;

async function runIngestion() {
  if (ingestionInProgress) {
    console.log('Skipping Telegram ingest tick because the previous run is still in progress.');
    return;
  }

  ingestionInProgress = true;

  try {
    debugLog('scheduler', 'Starting Telegram ingestion tick', {
      batchDelayMs: getBatchDelayMs()
    });

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
 * Process ready inbound batches and due proactive follow-up jobs.
 */
async function runPendingBatchProcessing() {
  if (processingInProgress) {
    console.log('Skipping processing tick because the previous run is still in progress.');
    return;
  }

  processingInProgress = true;
  const claimedBatchIds = new Set();
  const claimedProactiveJobIds = new Set();

  try {
    pruneExpiredData();

    console.log('Running processing queue at:', new Date().toISOString());
    debugLog('scheduler', 'Starting processing queue tick');

    const readyBatches = claimReadyBatches();
    const dueProactiveJobs = claimDueProactiveJobs();

    for (const batch of readyBatches) {
      claimedBatchIds.add(batch.chatId);
    }

    for (const job of dueProactiveJobs) {
      claimedProactiveJobIds.add(job.chatId);
    }

    if (!readyBatches.length && !dueProactiveJobs.length) {
      console.log('No pending chat batches or proactive jobs are ready yet.');
      return;
    }

    console.log(`Found ${readyBatches.length} chat batch(es) and ${dueProactiveJobs.length} proactive job(s) ready for processing.`);

    const contributions = await getRecentContributions(GITLAB_LOOKBACK_DAYS);
    console.log(`GitLab contribution count for this tick: ${contributions.length}`);
    const batchHandledChatIds = new Set();

    for (const batch of readyBatches) {
      try {
        const currentBatch = getPendingMessagesForChat(batch.chatId);

        if (!currentBatch.length) {
          console.log(`Batch for chat ${batch.chatId} became empty before processing; completing it without an AI call.`);
          completeBatch(batch.chatId);
          claimedBatchIds.delete(batch.chatId);
          continue;
        }

        const historyMessages = getRecentMessages(batch.chatId);
        debugLog('scheduler', 'Processing ready batch', {
          chatId: batch.chatId,
          pendingCount: currentBatch.length,
          historyCount: historyMessages.length
        });
        const analysis = await analyzeContributions({
          contributions,
          workingSchedule: '',
          historyMessages,
          currentBatch,
          analysisTrigger: 'batch'
        });
        logAnalysisDecision('batch', batch.chatId, analysis);

        if (analysis?.shouldText && analysis?.text) {
          await sendTelegramMessage(batch.chatId, analysis.text, { ttsMood: analysis?.mood });
          console.log(`Sent batch-triggered reply to chat ${batch.chatId}.`);
        }

        markMessagesProcessed(currentBatch.map((message) => message.id));
        completeBatch(batch.chatId);
        applyFollowUpDecision({
          chatId: batch.chatId,
          analysis,
          source: 'batch'
        });
        batchHandledChatIds.add(batch.chatId);
        claimedBatchIds.delete(batch.chatId);
      } catch (error) {
        console.error(`Error processing chat batch ${batch.chatId}:`, error.message);
        rescheduleBatch(batch.chatId);
        claimedBatchIds.delete(batch.chatId);
      }
    }

    for (const job of dueProactiveJobs) {
      if (batchHandledChatIds.has(job.chatId)) {
        console.log(`Skipping due proactive job for chat ${job.chatId} because the batch processor already handled this chat this tick.`);
        claimedProactiveJobIds.delete(job.chatId);
        continue;
      }

      try {
        const currentBatch = getPendingMessagesForChat(job.chatId);

        if (currentBatch.length) {
          deleteProactiveJob(job.chatId);
          console.log(`Cleared proactive job for chat ${job.chatId} because ${currentBatch.length} inbound message(s) are pending.`);
          claimedProactiveJobIds.delete(job.chatId);
          continue;
        }

        const historyMessages = getRecentMessages(job.chatId);

        if (!historyMessages.length) {
          deleteProactiveJob(job.chatId);
          console.log(`Cleared proactive job for chat ${job.chatId} because no recent history is available.`);
          claimedProactiveJobIds.delete(job.chatId);
          continue;
        }

        debugLog('scheduler', 'Processing due proactive job', {
          chatId: job.chatId,
          historyCount: historyMessages.length,
          dueAt: job.dueAt,
          reason: job.reason
        });

        const analysis = await analyzeContributions({
          contributions,
          workingSchedule: '',
          historyMessages,
          currentBatch: [],
          analysisTrigger: 'scheduled_follow_up',
          scheduledFollowUp: job
        });
        logAnalysisDecision('proactive', job.chatId, analysis);

        if (analysis?.shouldText && analysis?.text) {
          await sendTelegramMessage(job.chatId, analysis.text, { ttsMood: analysis?.mood });
          console.log(`Sent scheduled proactive reply to chat ${job.chatId}.`);
        }

        applyFollowUpDecision({
          chatId: job.chatId,
          analysis,
          source: 'scheduled_follow_up'
        });
        claimedProactiveJobIds.delete(job.chatId);
      } catch (error) {
        console.error(`Error processing proactive job for chat ${job.chatId}:`, error.message);
        rescheduleProactiveJob(job.chatId);
        claimedProactiveJobIds.delete(job.chatId);
      }
    }
  } catch (error) {
    console.error('Error in processing queue:', error.message);

    for (const chatId of claimedBatchIds) {
      rescheduleBatch(chatId);
    }

    for (const chatId of claimedProactiveJobIds) {
      rescheduleProactiveJob(chatId);
    }
  } finally {
    processingInProgress = false;
  }
}

function applyFollowUpDecision({ chatId, analysis, source }) {
  const followUp = analysis?.followUp;

  if (!followUp?.shouldSchedule || followUp.delayMinutes < 1) {
    const cleared = deleteProactiveJob(chatId);

    if (cleared) {
      console.log(`Cleared proactive follow-up for chat ${chatId}.`);
    }

    return null;
  }

  const scheduledJob = scheduleProactiveJob({
    chatId,
    delayMinutes: followUp.delayMinutes,
    reason: followUp.reason,
    source
  });

  if (!scheduledJob) {
    return null;
  }

  const reasonSuffix = scheduledJob.reason
    ? ` reason="${scheduledJob.reason}"`
    : '';

  console.log(
    `Scheduled proactive follow-up for chat ${chatId} at ${formatIndonesianPromptTimestamp(scheduledJob.dueAt)} (${scheduledJob.requestedDelayMinutes} minute(s) from now).${reasonSuffix}`
  );

  return scheduledJob;
}

function logAnalysisDecision(mode, chatId, analysis) {
  const shouldText = Boolean(analysis?.shouldText && analysis?.text);
  const preview = shouldText
    ? analysis.text.replace(/\s+/g, ' ').slice(0, 120)
    : 'no outbound message';
  const followUpPreview = analysis?.followUp?.shouldSchedule
    ? `${analysis.followUp.delayMinutes} minute(s)`
    : 'none';

  console.log(
    `[${mode}] AI decision for chat ${chatId}: shouldText=${shouldText} followUp=${followUpPreview} preview="${preview}"`
  );
}

const runtimeInfo = getRuntimeInfo();

cron.schedule(TELEGRAM_POLL_CRON, runIngestion);
cron.schedule(TELEGRAM_PROCESS_CRON, runPendingBatchProcessing);

console.log('Telegram ingest cron started:', TELEGRAM_POLL_CRON);
console.log('Telegram processing cron started (batches + proactive jobs):', TELEGRAM_PROCESS_CRON);
console.log('SQLite runtime database:', runtimeInfo.databasePath);