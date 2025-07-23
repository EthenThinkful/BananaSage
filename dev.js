const { Client, IntentsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
const PAYMENT_THRESHOLD = parseFloat(process.env.PAYMENT_THRESHOLD || '5.00');
const TOKEN_COST_PER_1K = parseFloat(process.env.TOKEN_COST || '0.003');
const KOFI_LINK_BASE = process.env.KOFI_LINK || 'https://ko-fi.com/yourusername';
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
    
    async addUsageCost(userId, tokensUsed) {
        const cost = (tokensUsed / 1000) * TOKEN_COST_PER_1K;
        const currentBalance = await this.getUserBalance(userId);
        const newBalance = currentBalance + cost;
        await this.redis.set(`user_balance:${userId}`, newBalance.toString());
        return newBalance;
    }
    
    async isUserLocked(userId) {
        return await this.redis.exists(`user_locked:${userId}`);
    }
    
    async lockUser(userId) {
        await this.redis.set(`user_locked:${userId}`, '1', { EX: 86400 * 7 }); // 7 day expiry
    }
    
    async unlockUser(userId) {
        await this.redis.del(`user_locked:${userId}`);
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
            `Your usage has reached **$${balance.toFixed(2)}**.\nPlease complete payment to continue using the bot.` :
            `You have an outstanding balance of **$${balance.toFixed(2)}**.\nPlease complete your payment to continue using the bot.`
        )
        .addFields(
            { name: 'Threshold', value: `$${PAYMENT_THRESHOLD.toFixed(2)}`, inline: true },
            { name: 'Current Balance', value: `$${balance.toFixed(2)}`, inline: true }
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

// Estimate tokens from message (rough approximation)
function estimateTokens(text) {
    return Math.ceil(text.split(/\s+/).length * 1.3);
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
    if (message.content.startsWith('!')) {
        // Handle payment commands
        if (message.content === '!balance') {
            const userId = message.author.id;
            const balance = await paymentManager.getUserBalance(userId);
            const isLocked = await paymentManager.isUserLocked(userId);
            
            const embed = new EmbedBuilder()
                .setTitle('💰 Your Balance')
                .setColor(isLocked ? 0xFF0000 : 0x00FF00)
                .addFields(
                    { name: 'Current Balance', value: `$${balance.toFixed(2)}`, inline: true },
                    { name: 'Threshold', value: `$${PAYMENT_THRESHOLD.toFixed(2)}`, inline: true },
                    { name: 'Status', value: isLocked ? '🔒 Locked' : '✅ Active', inline: true }
                );

            if (isLocked) {
                const paymentData = await createPaymentEmbed(userId, balance);
                await message.reply({ embeds: [embed, ...paymentData.embeds], components: paymentData.components });
            } else {
                await message.reply({ embeds: [embed] });
            }
            return;
        }
        
        if (message.content === '!pay') {
            const userId = message.author.id;
            const balance = await paymentManager.getUserBalance(userId);
            
            if (balance <= 0) {
                await message.reply("You don't have any outstanding balance!");
                return;
            }
            
            const paymentData = await createPaymentEmbed(userId, balance);
            await message.reply(paymentData);
            return;
        }
        
        return; // Exit for other commands
    }

    const userId = message.author.id;
    
    // Check if user is locked
    if (await paymentManager.isUserLocked(userId)) {
        try {
            await message.delete();
        } catch (error) {
            console.log('Could not delete message:', error.message);
        }
        
        // Send payment request via DM or channel
        const balance = await paymentManager.getUserBalance(userId);
        const paymentData = await createPaymentEmbed(userId, balance);
        
        try {
            await message.author.send(paymentData);
        } catch (error) {
            // If DM fails, send in channel with auto-delete
            const sentMessage = await message.channel.send({
                content: `${message.author}`,
                ...paymentData
            });
            
            setTimeout(async () => {
                try {
                    await sentMessage.delete();
                } catch (deleteError) {
                    console.log('Could not delete payment message:', deleteError.message);
                }
            }, 30000); // Delete after 30 seconds
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

        // Estimate tokens for cost calculation
        const estimatedTokens = estimateTokens(userInput);
        const newBalance = await paymentManager.addUsageCost(userId, estimatedTokens);
        
        // Check if threshold reached
        if (newBalance >= PAYMENT_THRESHOLD) {
            await paymentManager.lockUser(userId);
            
            try {
                await message.delete();
            } catch (error) {
                console.log('Could not delete message:', error.message);
            }
            
            // Send payment request
            const paymentData = await createPaymentEmbed(userId, newBalance, true);
            
            try {
                await message.author.send(paymentData);
            } catch (error) {
                const sentMessage = await message.channel.send({
                    content: `${message.author}`,
                    ...paymentData
                });
                
                setTimeout(async () => {
                    try {
                        await sentMessage.delete();
                    } catch (deleteError) {
                        console.log('Could not delete payment message:', deleteError.message);
                    }
                }, 60000); // Delete after 1 minute
            }
            return;
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

            await storeMessage(userId, "user", userInput);

            try {
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

// Express server for Ko-fi webhooks
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/kofi-webhook', async (req, res) => {
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
                
                // Unlock user if balance is under threshold
                if (newBalance < PAYMENT_THRESHOLD) {
                    await paymentManager.unlockUser(userId);
                    console.log(`User ${userId} unlocked, new balance: $${newBalance.toFixed(2)}`);
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
                        .setDescription(`Thank you! Your payment of **$${amount.toFixed(2)}** has been processed.`)
                        .setColor(0x00FF00)
                        .addFields(
                            { name: 'New Balance', value: `$${newBalance.toFixed(2)}`, inline: true },
                            { name: 'Status', value: newBalance < PAYMENT_THRESHOLD ? '✅ Unlocked' : '⚠️ Still locked', inline: true }
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