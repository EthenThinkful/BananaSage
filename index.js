const { Client, IntentsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { spawn } = require('child_process');
const { createClient } = require('redis');
require('dotenv').config();
const os = require("os");
const { OpenAI } = require('openai');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PYTHON_CMD = path.join(__dirname, 'venv', 'bin', 'python3');

// Payment configuration
const MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET || '10.00');
const PAYMENT_THRESHOLD = parseFloat(process.env.PAYMENT_THRESHOLD || '2.00');
const INPUT_TOKEN_COST_PER_1M = 1.50; // $1.50 per million input tokens
const OUTPUT_TOKEN_COST_PER_1M = 7.50; // $7.50 per million output tokens
const KOFI_LINK_BASE = process.env.KOFI_LINK;
const KOFI_WEBHOOK_SECRET = process.env.KOFI_WEBHOOK_SECRET;

// Redis client setup
const redisClient = createClient({ url: 'redis://127.0.0.1:6379' });
redisClient.connect().catch(console.error);
console.log('redis client connected');

// Payment Manager Class
class PaymentManager {
    constructor() {
        this.redis = redisClient;
    }
    
    async getUserBalance(userId) {
        const balance = await this.redis.get(`user_balance:${userId}`);
        return parseFloat(balance) || 0.0;
    }
    
    async getUserThreshold(userId) {
        const threshold = await this.redis.get(`user_threshold:${userId}`);
        return parseFloat(threshold) || PAYMENT_THRESHOLD; // Fallback to default
    }
    
    async setUserThreshold(userId, amount) {
        await this.redis.set(`user_threshold:${userId}`, amount.toString());
    }
    
    async addTokenCosts(userId, inputTokens, outputTokens) {
        const inputCost = (inputTokens / 1000000) * INPUT_TOKEN_COST_PER_1M;
        const outputCost = (outputTokens / 1000000) * OUTPUT_TOKEN_COST_PER_1M;
        const totalCost = inputCost + outputCost;
        
        const currentBalance = await this.getUserBalance(userId);
        const newBalance = currentBalance + totalCost;
        
        await this.redis.set(`user_balance:${userId}`, newBalance.toString());
        
        // Log the token usage for debugging
        console.log(`💰 User ${userId} token costs: Input: ${inputTokens} tokens (${inputCost.toFixed(6)}), Output: ${outputTokens} tokens (${outputCost.toFixed(6)}), Total: ${totalCost.toFixed(6)}, New Balance: ${newBalance.toFixed(6)}`);
        
        return {
            inputCost,
            outputCost,
            totalCost,
            newBalance
        };
    }
    
    async isUserLocked(userId) {
        return await this.redis.exists(`user_locked:${userId}`);
    }
    
    async lockUser(userId) {
        await this.redis.set(`user_locked:${userId}`, '1', { EX: 86400 * 7 }); // 7 day expiry
        console.log(`🔒 User ${userId} locked for payment`);
    }
    
    async unlockUser(userId) {
        await this.redis.del(`user_locked:${userId}`);
        console.log(`🔓 User ${userId} unlocked after payment`);
    }
    
    async subtractPayment(userId, amount) {
        const currentBalance = await this.getUserBalance(userId);
        const newBalance = Math.max(0, currentBalance - amount);
        await this.redis.set(`user_balance:${userId}`, newBalance.toString());
        return newBalance;
    }
    
    async generatePaymentLink(userId, amount) {
        // Create unique identifier for this payment
        const paymentId = crypto.createHash('md5').update(`${userId}_${Date.now()}`).digest('hex').substring(0, 8);
        
        // Store payment info in Redis for webhook verification
        const paymentData = {
            user_id: userId,
            amount: amount,
            timestamp: new Date().toISOString(),
            status: 'pending'
        };
        await this.redis.set(`payment:${paymentId}`, JSON.stringify(paymentData), { EX: 3600 }); // 1 hour expiry
        
        // Return Ko-fi link with custom message
        const kofiMessage = `Payment for Discord Bot - ID: ${paymentId}`;
        return `${KOFI_LINK_BASE}?message=${encodeURIComponent(kofiMessage)}`;
    }
    
    async getAllActiveUsers() {
        // Get all users who have used the bot (have balance records)
        const keys = await this.redis.keys('user_balance:*');
        const userIds = keys.map(key => key.replace('user_balance:', ''));
        console.log(`📊 Found ${userIds.length} active users in Redis: ${userIds.slice(0, 5).join(', ')}${userIds.length > 5 ? '...' : ''}`);
        return userIds;
    }
    
    async performMonthlyReset() {
        try {
            console.log('🔄 Starting monthly budget reset...');
            
            // Get all active users
            const activeUsers = await this.getAllActiveUsers();
            const userCount = activeUsers.length;
            
            if (userCount === 0) {
                console.log('⚠️ No active users found for monthly reset');
                return;
            }
            
            // Calculate allocation per user
            const allocationPerUser = MONTHLY_BUDGET / userCount;
            
            console.log(`💰 Monthly reset: ${MONTHLY_BUDGET} budget / ${userCount} users = ${allocationPerUser.toFixed(4)} per user`);
            
            // Reset all user balances to 0 and set their monthly allocation as threshold
            for (const userId of activeUsers) {
                await this.redis.set(`user_balance:${userId}`, '0');
                await this.setUserThreshold(userId, allocationPerUser);
                await this.unlockUser(userId); // Unlock everyone for the new month
                console.log(`✅ Reset user ${userId}: Balance = $0, Threshold = ${allocationPerUser.toFixed(4)}`);
            }
            
            // Store reset info for tracking
            const resetInfo = {
                date: new Date().toISOString(),
                budget: MONTHLY_BUDGET,
                userCount: userCount,
                allocationPerUser: allocationPerUser
            };
            await this.redis.set('last_monthly_reset', JSON.stringify(resetInfo));
            
            console.log(`✅ Monthly reset completed successfully!`);
            
            return {
                userCount,
                allocationPerUser,
                resetDate: new Date().toISOString()
            };
            
        } catch (error) {
            console.error('❌ Error during monthly reset:', error);
            throw error;
        }
    }
    
    async getLastResetInfo() {
        const resetInfo = await this.redis.get('last_monthly_reset');
        return resetInfo ? JSON.parse(resetInfo) : null;
    }
    
    async shouldPerformReset() {
        const lastReset = await this.getLastResetInfo();
        const now = new Date();
        
        // If no reset has been performed, do it now
        if (!lastReset) {
            return true;
        }
        
        const lastResetDate = new Date(lastReset.date);
        
        // Check if we're in a new month
        return (now.getFullYear() > lastResetDate.getFullYear()) || 
               (now.getFullYear() === lastResetDate.getFullYear() && now.getMonth() > lastResetDate.getMonth());
    }

    async recalculateAllThresholds() {
        console.log('📊 Recalculating thresholds for all users...');
        
        // Get all active users
        const activeUsers = await this.getAllActiveUsers();
        const userCount = activeUsers.length;
        
        if (userCount === 0) return;
        
        // Calculate new threshold per user
        const newThresholdPerUser = MONTHLY_BUDGET / userCount;
        
        console.log(`💰 Recalculating: $${MONTHLY_BUDGET} budget / ${userCount} users = $${newThresholdPerUser.toFixed(4)} per user`);
        
        // Update all user thresholds
        for (const userId of activeUsers) {
            await this.setUserThreshold(userId, newThresholdPerUser);
            console.log(`✅ Updated user ${userId} threshold to $${newThresholdPerUser.toFixed(4)}`);
        }
        
        return {
            userCount,
            newThresholdPerUser
        };
    }

    async isNewUser(userId) {
        const exists = await this.redis.exists(`user_balance:${userId}`);
        return !exists;
    }

    async initializeNewUser(userId) {
        // Set initial balance to 0
        await this.redis.set(`user_balance:${userId}`, '0');
        
        // Recalculate thresholds for everyone including this new user
        const result = await this.recalculateAllThresholds();
        
        console.log(`🆕 New user ${userId} initialized. All thresholds recalculated.`);
        return result;
    }
}

const paymentManager = new PaymentManager();

async function storeMessage(userId, role, content, maxMessages = 40) {
    const key = `discord:${userId}:history`;
    await redisClient.rPush(key, JSON.stringify({ role, content }));
    await redisClient.lTrim(key, -maxMessages, -1);
}

async function retrieveHistory(userId) {
    const key = `discord:${userId}:history`;
    const messages = await redisClient.lRange(key, 0, -1);
    return messages.map(m => JSON.parse(m));
}

// Function to extract token usage from Python response
function extractTokenUsage(pythonResponse) {
    try {
        // Look for token usage patterns in the Python output
        // This assumes your Python script outputs token information
        // You may need to modify your Python script to include this information
        
        // Pattern to match: "Input tokens: 123, Output tokens: 456"
        const tokenMatch = pythonResponse.match(/Input tokens:\s*(\d+),?\s*Output tokens:\s*(\d+)/i);
        if (tokenMatch) {
            return {
                inputTokens: parseInt(tokenMatch[1]),
                outputTokens: parseInt(tokenMatch[2])
            };
        }
        
        // Alternative pattern: "Usage: input=123 output=456"
        const usageMatch = pythonResponse.match(/Usage:\s*input=(\d+)\s*output=(\d+)/i);
        if (usageMatch) {
            return {
                inputTokens: parseInt(usageMatch[1]),
                outputTokens: parseInt(usageMatch[2])
            };
        }
        
        // If no token usage found, return null
        console.log('⚠️ No token usage found in Python response');
        return null;
        
    } catch (error) {
        console.error('Error extracting token usage:', error);
        return null;
    }
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

// Function to create payment embed and buttons
async function createPaymentEmbed(userId, balance, isThresholdReached = false) {
    const embed = new EmbedBuilder()
        .setColor(isThresholdReached ? 0xFFA500 : 0xFF0000)
        .setTitle(isThresholdReached ? '💳 Payment Threshold Reached' : '⚠️ Payment Required')
        .setDescription(isThresholdReached ? 
            `Your usage has reached **$${balance.toFixed(4)}**.\nPlease complete payment to continue using the bot.` :
            `You have an outstanding balance of **$${balance.toFixed(4)}**.\nPlease complete your payment to continue using the bot.`
        )
        .addFields(
            { name: 'Your Threshold', value: `$${userThreshold.toFixed(2)}`, inline: true },
            { name: 'Current Balance', value: `$${balance.toFixed(4)}`, inline: true }
        )
        .setFooter({ text: 'Click the button below to pay via Ko-fi' });

    const paymentLink = await paymentManager.generatePaymentLink(userId, balance);
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel(`Pay $${balance.toFixed(2)}`)
                .setStyle(ButtonStyle.Link)
                .setURL(paymentLink)
                .setEmoji('☕')
        );

    return { embeds: [embed], components: [row] };
}

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
        IntentsBitField.Flags.GuildMembers,
    ],
});

// Slash command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Check your current usage balance'),
    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Get payment link to unlock your account'),
    new SlashCommandBuilder()
        .setName('budget')
        .setDescription('View monthly budget allocation info'),
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Manually trigger monthly budget reset (admin only)'),
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.on('ready', async () => {
    console.log('🌊 The Banana Sage Bot is online!');
    
    try {
        console.log('Refreshing slash commands...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('✅ Slash commands registered successfully');
    } catch (error) {
        console.error('❌ Error registering slash commands:', error);
    }
    
    // Check if monthly reset is needed on startup
    try {
        if (await paymentManager.shouldPerformReset()) {
            console.log('🔄 Monthly reset needed on startup...');
            await paymentManager.performMonthlyReset();
        } else {
            console.log('✅ Monthly reset not needed');
        }
    } catch (error) {
        console.error('❌ Error checking monthly reset on startup:', error);
    }
});

// Handle slash command interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;

    if (interaction.commandName === 'balance') {
        const balance = await paymentManager.getUserBalance(userId);
        const userThreshold = await paymentManager.getUserThreshold(userId);
        const isLocked = await paymentManager.isUserLocked(userId);
        
        const embed = new EmbedBuilder()
            .setTitle('💰 Your Balance')
            .setColor(isLocked ? 0xFF0000 : 0x00FF00)
            .addFields(
                { name: 'Current Balance', value: `${balance.toFixed(4)}`, inline: true },
                { name: 'Your Threshold', value: `$${userThreshold.toFixed(2)}`, inline: true },
                { name: 'Status', value: isLocked ? '🔒 Locked' : '✅ Active', inline: true }
            );

        if (isLocked && balance > 0) {
            const paymentLink = await paymentManager.generatePaymentLink(userId, balance);
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel(`Pay ${balance.toFixed(2)}`)
                        .setStyle(ButtonStyle.Link)
                        .setURL(paymentLink)
                        .setEmoji('☕')
                );
            
            await interaction.reply({ 
                embeds: [embed], 
                components: [row], 
                ephemeral: true 
            });
        } else {
            await interaction.reply({ 
                embeds: [embed], 
                ephemeral: true 
            });
        }
    }

    if (interaction.commandName === 'unlock') {
        const balance = await paymentManager.getUserBalance(userId);
        const isLocked = await paymentManager.isUserLocked(userId);
        const userThreshold = await paymentManager.getUserThreshold(userId);

        if (!isLocked) {
            await interaction.reply({ 
                content: "✅ Your account is already unlocked! You can use the bot normally.", 
                ephemeral: true 
            });
            return;
        }
        
        if (balance <= 0) {
            await interaction.reply({ 
                content: "🤔 You don't have any outstanding balance, but you're locked. This might be an error. Please contact support.", 
                ephemeral: true 
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('🔓 Unlock Your Account')
            .setDescription(`Your current balance is **${balance.toFixed(4)}**.\nComplete payment below to unlock your account and continue using the bot.`)
            .setColor(0xFFA500)
            .addFields(
                { name: 'Amount Due', value: `${balance.toFixed(4)}`, inline: true },
                { name: 'Threshold', value: `${userThreshold.toFixed(2)}`, inline: true }
            )
            .setFooter({ text: 'This payment link is unique to you and expires in 1 hour' });

        const paymentLink = await paymentManager.generatePaymentLink(userId, balance);
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setLabel(`Pay ${balance.toFixed(2)}`)
                    .setStyle(ButtonStyle.Link)
                    .setURL(paymentLink)
                    .setEmoji('☕')
            );

        await interaction.reply({ 
            embeds: [embed], 
            components: [row], 
            ephemeral: true 
        });
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;
    if (message.content.startsWith('!')) {
        return; // Exit for other commands
    }
    const userId = message.author.id;
    if (await paymentManager.isNewUser(userId)) {
        console.log(`🆕 First message from new user ${userId}`);
        await paymentManager.initializeNewUser(userId);
    }

    // Get user's personal threshold (not the global PAYMENT_THRESHOLD)
    const userThreshold = await paymentManager.getUserThreshold(userId);
    
    // Check if user is locked BEFORE processing
    if (await paymentManager.isUserLocked(userId)) {
        try {
            await message.delete();
        } catch (error) {
            console.log('Could not delete message:', error.message);
        }
        
        // Send instruction directly in channel
        const sentMessage = await message.channel.send(
            `${message.author} Your account is locked. Type \`/unlock\` in this channel to pay and continue using the bot.`
        );
        
        setTimeout(async () => {
            try {
                await sentMessage.delete();
            } catch (deleteError) {
                console.log('Could not delete instruction message:', deleteError.message);
            }
        }, 15000); // Delete after 15 seconds
        
        return;
    }

    // Check if user balance is already over threshold BEFORE processing
    const currentBalance = await paymentManager.getUserBalance(userId);
    if (currentBalance >= userThreshold) {
        await paymentManager.lockUser(userId);
        
        try {
            await message.delete();
        } catch (error) {
            console.log('Could not delete message:', error.message);
        }
        
        // Send instruction to use slash command
        try {
            await message.author.send(`🔒 **Payment threshold reached!**\n\nYour balance is ${currentBalance.toFixed(4)} (threshold: ${userThreshold.toFixed(2)})\n\nUse \`/unlock\` in the server to pay and continue using the bot!`);
        } catch (error) {
            const sentMessage = await message.channel.send(
                `${message.author} Payment required! Your balance is ${currentBalance.toFixed(4)}. Use \`/unlock\` to pay.`
            );
            
            setTimeout(async () => {
                try {
                    await sentMessage.delete();
                } catch (deleteError) {
                    console.log('Could not delete payment notification:', deleteError.message);
                }
            }, 20000);
        }
        return;
    }

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

        // Continue with normal processing if content passes moderation and payment check
        const conversationLog = await retrieveHistory(userId);

        const pyProcess = spawn(PYTHON_CMD, ['main.py', JSON.stringify(conversationLog), userInput, userId]);

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

            // Store user message first
            await storeMessage(userId, "user", userInput);

            try {
                // Extract text from response
                let textMatch = response.match(/TextBlock\(.*?text="(.*?)",.*?\)/);
                if (!textMatch) {
                    textMatch = response.match(/TextBlock\(.*?text='(.*?)',.*?\)/);
                }
                const text = textMatch ? textMatch[1] : "No text block found.";
                
                // Store assistant response
                await storeMessage(userId, "assistant", text);

                // Extract token usage from Python response
                const tokenUsage = extractTokenUsage(response);
                
                if (tokenUsage) {
                    // Add token costs to user's balance AFTER successful API call
                    const costInfo = await paymentManager.addTokenCosts(
                        userId, 
                        tokenUsage.inputTokens, 
                        tokenUsage.outputTokens
                    );
                    
                    console.log(`💳 User ${userId} charged $${costInfo.totalCost.toFixed(6)} for this interaction`);
                    
                    // Note: We don't check threshold here because we already checked before processing
                    // The user will be locked on their NEXT message attempt if they're over threshold
                } else {
                    console.log(`⚠️ Could not extract token usage for user ${userId}, no charges applied`);
                }

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

// Express server for Ko-fi webhooks
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/3t3333', async (req, res) => {
    try {
        console.log('Ko-fi webhook received:', req.body);
        
        // Ko-fi sends data in 'data' field as JSON string
        let kofiData;
        if (req.body.data) {
            kofiData = JSON.parse(req.body.data);
        } else {
            kofiData = req.body;
        }
        
        // Extract payment info
        const amount = parseFloat(kofiData.amount || 0);
        const message = kofiData.message || '';
        
        console.log(`Payment received: $${amount}, Message: ${message}`);
        
        // Extract payment ID from message
        if (message.includes('ID:')) {
            const paymentId = message.split('ID:')[1].trim();
            console.log(`Processing payment ID: ${paymentId}`);
            
            // Get payment info from Redis
            const paymentInfo = await redisClient.get(`payment:${paymentId}`);
            if (paymentInfo) {
                const paymentData = JSON.parse(paymentInfo);
                const userId = paymentData.user_id;
                
                console.log(`Processing payment for user: ${userId}, Amount: $${amount}`);
                
                // Process payment
                const newBalance = await paymentManager.subtractPayment(userId, amount);
                
                const userThreshold = await paymentManager.getUserThreshold(userId);
                if (newBalance < userThreshold) {
                    await paymentManager.unlockUser(userId);
                    console.log(`User ${userId} unlocked, new balance: ${newBalance.toFixed(4)}`);
                }
                
                // Update payment status
                paymentData.status = 'completed';
                paymentData.amount_paid = amount;
                await redisClient.set(`payment:${paymentId}`, JSON.stringify(paymentData), { EX: 86400 });
                
                // Notify user via Discord
                try {
                    const user = await client.users.fetch(userId);
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Payment Received')
                        .setDescription(`Thank you! Your payment of **${amount.toFixed(2)}** has been processed.`)
                        .setColor(0x00FF00)
                        .addFields(
                            { name: 'New Balance', value: `${newBalance.toFixed(4)}`, inline: true },
                            { name: 'Status', value: newBalance < userThreshold ? '✅ Unlocked' : '⚠️ Still locked', inline: true }
                        );
                    
                    await user.send({ embeds: [embed] });
                    console.log(`Payment notification sent to user ${userId}`);
                } catch (error) {
                    console.error(`Failed to notify user ${userId}:`, error);
                }
                
                res.json({ status: 'success' });
                return;
            } else {
                console.log(`Payment ID ${paymentId} not found in Redis`);
            }
        }
        
        res.json({ status: 'ignored' });
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ status: 'error' });
    }
});

// Start webhook server
const PORT = process.env.WEBHOOK_PORT || 5000;
app.listen(PORT, () => {
    console.log(`Ko-fi webhook server running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);