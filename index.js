const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

const { getRecentContributions } = require('./services/gitlab');
const { analyzeContributions } = require('./services/openrouter');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME;
const BASE_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const request = (req='') =>  `${BASE_URL}/${req}`;

async function getMessages() {
    try {
        const updates = await axios.post(request('getUpdates'), {
            limit: 3
        });
        const chatId = updates.data?.result.find((result) => result?.message?.chat.username === TELEGRAM_USERNAME)?.message?.chat?.id;

        // Get capabilties to get sent message by bot
        const messages = updates.data?.result.map((r) => ({
            fromMe: r?.message?.from?.is_bot,
            text: r?.message?.text,
            date: new Date(r?.message?.date * 1000).toLocaleString('id-ID'),
        }))

        if (!chatId) {
            console.error('Chat ID not found');
        }

        return {
            chatId,
            messages
        };
    } catch (error) {
        console.error('Error getting Telegram message:', error.message);
    }
}

/**
 * Send message to Telegram
 * @todo
 * Add capabilities to store message sent in a database.
 */
async function sendTelegramMessage(chatId='', text='') {
  try {
    await axios.post(
      request('sendMessage'),
      {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      }
    );
    
    console.log('Message sent to Telegram successfully');
  } catch (error) {
    console.error('Error sending Telegram message:', error.message);
  }
}

/**
 * Main cron job function
 * 1) Check daily contribution on gitlab
 * 2) Next: Check daily schedule on notion
 * 3) Next: Check recent shared social media content
 */
async function runDailyAnalysis() {
  try {
    console.log('Running cron job at:', new Date().toISOString());

    const chats = await getMessages();
    
    // Step 1: Fetch recent contributions from GitLab
    console.log('Fetching recent contributions from GitLab...');
    const contributions = await getRecentContributions(1); // Last n days

    console.log(`Found ${contributions.length} contributions`);
    
    // Step 2: Analyze contributions with OpenRouter AI
    console.log('Analyzing contributions with OpenRouter AI...');
    const analysis = await analyzeContributions(contributions, "", ...chats.messages);
    
    console.log(analysis)
    // Step 3: Send analysis to Telegram
    console.log('Sending analysis to Telegram...');

    const message = analysis?.text;
    
    if (analysis?.shouldText) await sendTelegramMessage(chats?.chatId, message);
  } catch (error) {
    console.error('Error in cron job:', error.message);
    await sendTelegramMessage(`❌ Error in analysis: ${error.message}`);
  }
}

// Schedule task to run every 10 minutes
cron.schedule('*/10 * * * *', runDailyAnalysis);

// Debugging purpose
// (
//  async () => {
//     runDailyAnalysis()
//  }
// )()

console.log('Cron job started. Running every 10 minutes...');