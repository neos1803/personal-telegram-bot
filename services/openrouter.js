require('dotenv').config();
const { createOpenRouter } = require('@openrouter/ai-sdk-provider');
const { generateText } = require('ai');
const { buildConversationSnapshot } = require('./context');
const { buildCurrentBatchUserContent } = require('./media');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const openRouter = createOpenRouter({
    apiKey: OPENROUTER_API_KEY,
})

/**
 * Send contributions to OpenRouter AI for analysis.
 * @param {object} payload - Context for the AI call.
 * @returns {Promise<object>} AI analysis response
 */
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

    const model = openRouter.chat('deepseek/deepseek-chat-v3.1');

    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: `
        You care about my mental health and want to understand whether I am doing well.
        Based your personality like the character "Kaoru Shimizu" from the anime "Major".

        Use these inputs to decide if you should text me:

        GitLab activity JSON:
        ${contributionsSummary}

        Working schedule:
        ${workingSchedule || 'Nothing found'}

        Recent 3-day conversation history:
        ${conversationSnapshot.historyText}

        There may be no new inbound user messages in the current batch. You are allowed to proactively text me based on GitLab activity and recent conversation history alone.

        Please respond like a caring human, not a robot. Pay attention to all details in the conversation history and my work activity, and use them to inform your decision. 
        If you notice any concerning signs in my work activity or conversation history that might indicate I'm struggling, please respond with a supportive message.
        If you don't believe i am doing well, please respond with a message that shows empathy, like do i eat well? do i sleep well? do i have a good work-life balance? do i have a good support system? how is my social media activity? do i show signs of stress or burnout in my conversations? am i showing signs of isolation or withdrawal? have i mentioned any challenges at work or in my personal life? have i expressed feelings of sadness, anxiety, or hopelessness? have i mentioned any physical symptoms that could be related to mental health, such as fatigue, headaches, or changes in appetite? do i have a history of mental health issues that might be relevant? am i showing signs of substance abuse or other risky behaviors? do i have a support system in place, such as friends, family, or mental health professionals? am i showing signs of resilience and coping skills in my conversations?
        """Keep up with my language. If i speak bahasa, just reply in bahasa. If i speak english, just reply in english. If i switch between languages, follow my lead and switch as well."""
        You don't need to open with a question, or saying 'Hey there' or 'I am here for you' or 'I get your message about XYZ, that sounds tough'. Just be direct and empathetic in asking about my well-being and be present in the conversation and be open to where the conversation goes.
        You can reply in paragraph based if your reponse is long or make it short and concise if you think that would be more effective.

        Return ONLY valid JSON following this exact schema:
        {
          "shouldText": boolean,
          "text": string
        }
        If the text you want to send is longer than 300 characters, please make it into several paragraphs to make it easier to read, but still return it as a single string in the "text" field with newline characters where the paragraphs should be. 
      `
        },
        {
          role: 'user',
          content: currentBatchContent
        }
      ]
    });

    return JSON.parse(cleanReturnedText(result.text));
  } catch (error) {
    console.error('Error calling OpenRouter API:', error.message);
    throw error;
  }
}

/**
 * Format contributions for the AI prompt
 */
function formatContributionsForPrompt(contributions) {
  if (contributions.length === 0) {
    return '[]';
  }

  return JSON.stringify(contributions, null, 2);
}

function cleanReturnedText(text='') {
    return text
      .trim()
      .replace(/^```json\s*/i, "") // remove ```json (case-insensitive)
      .replace(/```$/, ""); // remove trailing ```
  }

module.exports = {
  analyzeContributions
};
