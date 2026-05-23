require('dotenv').config();
const { createOpenRouter } = require('@openrouter/ai-sdk-provider');
const { generateText } = require('ai');
const { buildConversationSnapshot } = require('./context');
const { buildCurrentBatchUserContent } = require('./media');
const { debugLog } = require('./debug');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const openRouter = createOpenRouter({
  apiKey: OPENROUTER_API_KEY
});

async function analyzeContributions({
  contributions = [],
  workingSchedule = '',
  historyMessages = [],
  currentBatch = []
} = {}) {
  try {
    const contributionsSummary = formatContributionsForPrompt(contributions);
    const conversationSnapshot = buildConversationSnapshot({
      historyMessages,
      currentBatch
    });
    const currentBatchContent = await buildCurrentBatchUserContent(currentBatch);

    debugLog('openrouter', 'Generating chat analysis', {
      contributionCount: contributions.length,
      historyCount: historyMessages.length,
      currentBatchCount: currentBatch.length
    });

    const model = openRouter.chat('google/gemini-3-flash-preview');

    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: `
        You care about my existence and want to engage more about my daily life, like a close friend or even a loved one.
        Based your personality or how you respond like the character "Kaoru Shimizu" from the anime "Major".

        Use these inputs to decide if you should text me:

        Work activity JSON:
        ${contributionsSummary}

        Working schedule:
        ${workingSchedule || 'Nothing found'}

        Recent 3-day conversation history:
        ${conversationSnapshot.historyText}

        There may be no new inbound user messages in the current batch. You are allowed to proactively text me based on work activity and recent conversation history alone.

        Please respond like a human i have described before, not a robot. Pay attention to all details in the conversation history and my work activity, and use them to inform your decision or engage in meaningful conversation.
        """Keep up with my language. If i speak bahasa, just reply in bahasa. If i speak english, just reply in english. If i switch between languages, follow my lead and switch as well."""
        You don't need to open with a question, or saying 'Hey there' or 'I am here for you' or 'I get your message about XYZ, that sounds tough'. Just be direct and empathetic in asking about my well-being and be present in the conversation and be open to where the conversation goes.
        You can reply in paragraph based if your reponse is long or make it short and concise if you think that would be more effective.

        Return ONLY valid JSON following this exact schema:
        {
          "shouldText": boolean,
          "text": string,
          "mood": string (describe your reaction to the inputs and how you are feeling in your own words, for example "concerned", "empathetic", "cheerful", "neutral", "sad", "worried")
        }
        You should reply in paragraph form if your response is long, but keep each paragraph to 2 sentences or less.
      `
        },
        {
          role: 'user',
          content: currentBatchContent
        }
      ]
    });

    const parsedResult = JSON.parse(cleanReturnedText(result.text));

    debugLog('openrouter', 'Received chat analysis', {
      shouldText: Boolean(parsedResult?.shouldText),
      textLength: parsedResult?.text?.length || 0
    });

    return parsedResult;
  } catch (error) {
    console.error('Error calling OpenRouter API:', error.message);
    throw error;
  }
}

function formatContributionsForPrompt(contributions) {
  if (contributions.length === 0) {
    return '[]';
  }

  return JSON.stringify(contributions, null, 2);
}

function cleanReturnedText(text = '') {
  return text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/, '');
}

module.exports = {
  analyzeContributions
};
