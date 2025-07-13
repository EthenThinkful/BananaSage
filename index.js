const { Client, IntentsBitField } = require('discord.js');
const { spawn } = require('child_process');
const { createClient } = require('redis');
require('dotenv').config();
const os = require("os");
const { OpenAI } = require('openai');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PYTHON_CMD = path.join(__dirname, 'venv', 'bin', 'python3');

// Redis client setup
const redisClient = createClient({ url: 'redis://127.0.0.1:6379' });
redisClient.connect().catch(console.error);
console.log('redis client connected');

async function storeMessage(userId, role, content, maxMessages = 4) {
    const key = `discord:${userId}:history`;
    await redisClient.rPush(key, JSON.stringify({ role, content }));
    await redisClient.lTrim(key, -maxMessages, -1);
}

async function retrieveHistory(userId) {
    const key = `discord:${userId}:history`;
    const messages = await redisClient.lRange(key, 0, -1);
    return messages.map(m => JSON.parse(m));
}

// Content moderation function using OpenAI's Moderation API
async function moderateContent(text) {
    try {
        const moderation = await openai.moderations.create({
            input: text,
        });
        
        const result = moderation.results[0];
        
        if (result.flagged) {
            // Get the specific categories that were flagged
            const flaggedCategories = Object.entries(result.categories)
                .filter(([category, flagged]) => flagged)
                .map(([category]) => category);
            
            return {
                isFlagged: true,
                categories: flaggedCategories,
                categoryScores: result.category_scores
            };
        }
        
        return { isFlagged: false };
    } catch (error) {
        console.error('Moderation API error:', error);
        // If moderation fails, allow the message through (fail-safe approach)
        return { isFlagged: false, error: true };
    }
}

// Function to create supportive response based on flagged content
function createSupportiveResponse(flaggedCategories) {
    const crisisCategories = ['self-harm', 'self-harm/intent', 'self-harm/instructions'];
    const violenceCategories = ['violence', 'violence/graphic'];
    
    const hasCrisisContent = flaggedCategories.some(cat => 
        crisisCategories.some(crisis => cat.includes(crisis.replace('/', '')))
    );
    
    const hasViolenceContent = flaggedCategories.some(cat => 
        violenceCategories.some(violence => cat.includes(violence.replace('/', '')))
    );
    
    if (hasCrisisContent) {
        return `I understand you're reaching out, but I'm not able to process messages about self-harm or crisis situations. 

**If you're in immediate danger or crisis, please reach out for help:**
• **Crisis Text Line**: Text HOME to 741741
• **National Suicide Prevention Lifeline**: 988 or 1-800-273-8255
• **International**: https://findahelpline.com

For ongoing support with OCD and anxiety, I'm here to help with coping strategies, mindfulness techniques, and general wellness discussions. Feel free to share what's on your mind in a different way. 💙

Remember: You're not alone, and there are people who want to help. 🫂`;
    }
    
    if (hasViolenceContent) {
        return `I understand you may be going through a difficult time, but I'm not able to process messages containing violent content.

I'm here to provide support for OCD, anxiety, and mental wellness in a safe and positive way. Feel free to share what you're struggling with using different words, and I'll do my best to help. 💙

If you're feeling overwhelmed, consider reaching out to a mental health professional or crisis support service.`;
    }
    
    // For other flagged categories (harassment, hate, sexual, etc.)
    return `I'm here to provide a safe and supportive space for discussing OCD and mental wellness. I'm not able to process your current message, but I'd love to help if you'd like to rephrase what you're going through.

Feel free to share your thoughts about OCD, anxiety, or coping strategies in a different way. I'm here to listen and support you. 💙`;
}

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
        IntentsBitField.Flags.GuildMembers,
    ],
});

client.on('ready', () => {
    console.log('🌊 The Banana Sage Bot is online!');
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;
    if (message.content.startsWith('!')) return;

    const welcomeKey = `welcomed:${message.channel.id}:${message.author.id}`;
    const alreadyWelcomed = await redisClient.get(welcomeKey);

    if (!alreadyWelcomed) {
        try {
            const messageLink = 'https://discord.com/channels/988770359773913098/1124007597209559231/1335268148982579252';
            await message.channel.send(
                `Hey ${message.author}, welcome! This is our OCD support bot, inspired by the Banana Water parable: ${messageLink}

The story reflects common struggles with compulsions and connects to ACT (Acceptance and Commitment Therapy), which many find helpful in managing OCD.

A member of our server came up with the parable, and we thought it'd be a great foundation for a bot like this. We hope it helps—even just a little. 🙂`
            );
            await redisClient.set(welcomeKey, 'true');
        } catch (error) {
            console.error(`Error sending welcome message: ${error}`);
        }
    }

    const userInput = message.content.trim();
    const userId = message.author.id;

    try {
        await message.channel.sendTyping();
        
        // MODERATION CHECK - Check content before processing
        console.log(`Checking content moderation for user ${userId}...`);
        const moderationResult = await moderateContent(userInput);
        console.log(`Moderation result for user ${userId}:`, moderationResult);
        
        if (moderationResult.isFlagged) {
            console.log(`⚠️ Content flagged for user ${userId}:`, moderationResult.categories);
            
            // Send supportive response instead of processing with Claude
            const supportiveResponse = createSupportiveResponse(moderationResult.categories);
            await message.reply(supportiveResponse);
            
            // Log the incident (but don't store the flagged content in conversation history)
            console.log(`Moderation incident - User: ${userId}, Categories: ${moderationResult.categories.join(', ')}`);
            
            return; // Don't process with Claude/Python script
        }
        
        if (moderationResult.error) {
            console.log(`⚠️ Moderation API error for user ${userId}, allowing message through`);
        } else {
            console.log(`✅ Content approved for user ${userId}`);
        }

        // Continue with normal processing if content passes moderation
        const conversationLog = await retrieveHistory(userId);
        console.log(`Chat history for user ${userId}:`, conversationLog);

        const pyProcess = spawn(PYTHON_CMD, ['main.py', JSON.stringify(conversationLog), userInput]);   

        let response = '';
        pyProcess.stdout.on('data', (data) => {
            const text = data.toString();
            console.log(`[Python]: ${text}`);
            response += text;
        });

        pyProcess.stderr.on('data', (data) => {
            console.error(`Python error: ${data}`);
        });

        pyProcess.on('close', async (code) => {
            if (code !== 0) {
                message.reply("Omg I just malfunctioned. Can you try again? Sorry about that!");
                return;
            }

            if (!response || response.trim().length === 0) {
                message.reply("No response.");
                return;
            }

            await storeMessage(userId, "user", userInput);

            try {
                console.log(`Extracting text from response: ${response}`);
                let textMatch = response.match(/TextBlock\(.*?text="(.*?)",.*?\)/);
                if (!textMatch) {
                    textMatch = response.match(/TextBlock\(.*?text='(.*?)',.*?\)/);
                }
                const text = textMatch ? textMatch[1] : "No text block found.";
                await storeMessage(userId, "assistant", text);

                // Format the text for Discord
                const formattedText = text
                    .replace(/\\n\\n/g, '\n\n')
                    .replace(/\\n/g, '\n')
                    .replace(/- /g, '\n- ');

                await message.channel.send(formattedText);
            } catch (error) {
                console.error(`Failed to extract text: ${error}`);
                message.reply("Failed to extract the text.");
            }
        });

        pyProcess.on('error', (err) => {
            console.error(`Failed to start Python script: ${err}`);
            message.reply("Couldn't run the Python script.");
        });

    } catch (error) {
        console.error(`Error: ${error}`);
        message.reply("I'm broken rn.");
    }
});

client.login(process.env.DISCORD_TOKEN);