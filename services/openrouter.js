require('dotenv').config();
const { createOpenRouter } = require('@openrouter/ai-sdk-provider');
const { generateText } = require('ai');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const openRouter = createOpenRouter({
    apiKey: OPENROUTER_API_KEY,
})

/**
 * Send contributions to OpenRouter AI for analysis
 * @param {Array} contributions - Array of recent contributions
 * @param {string} customPrompt - Custom prompt to add context
 * @returns {Promise<object>} AI analysis response
 */
async function analyzeContributions(contributions, workingSchedule, customPrompt = '') {
  try {
    const contributionsSummary = formatContributionsForPrompt(contributions);

    const model = openRouter.chat("deepseek/deepseek-chat-v3.1")

    const result = await generateText({
      model,
      messages: [
        {
            role: 'system',
            content: `
                Act as if you are care with my mental health. Trying to know whether i am good or not, based on this several input.

                My current job contribution

                ${contributionsSummary}

                My current working shecedule
                ${workingSchedule ?? `Nothing found`}

                Please analyze these provide insights about my mental health. Talk to me like you care that i am a human being who needs
                a emotional support. Try to be as human as you can. Not like a robot. Also make sure to keep track on given previour or current chats.

                Return ONLY valid JSON following this exact schema:
                {
                    "shouldText": boolean (only if you really think i need to be talked to based on my summary),
                    "text": string
                }
            `
        },
        {
            role: 'user',
            content: `
                My responses
                ${customPrompt}
            `
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
    return 'No recent contributions found.';
  }

  return contributions.map((contrib, index) => {
    return `${index + 1}. [${contrib.createdAt}] ${contrib.project} - ${contrib.action}: ${contrib.target}`;
  }).join('\n');
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
