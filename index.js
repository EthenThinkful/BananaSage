const { Client, IntentsBitField } = require('discord.js');
const { OpenAI } = require('openai');
const redis = require('redis');
const fs = require('fs');
const { execSync } = require("child_process");
const path = require("path");
require('dotenv/config');

// Discord client setup
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});

client.on('ready', () => {
  console.log('🌊 The Banana Sage Bot is online!');
});

// OpenAI setup
const openai = new OpenAI({ apiKey: process.env.API_KEY });

// Redis client setup
const redisClient = redis.createClient({ url: 'redis://127.0.0.1:6379' });
redisClient.connect().catch(console.error);

// Helper functions to store and retrieve conversation history
async function storeMessage(userId, role, content, maxMessages = 20) {
  const key = `discord:${userId}:history`;
  await redisClient.rPush(key, JSON.stringify({ role, content }));
  await redisClient.lTrim(key, -maxMessages, -1);
}

async function retrieveHistory(userId) {
  const key = `discord:${userId}:history`;
  const messages = await redisClient.lRange(key, 0, -1);
  return messages.map(m => JSON.parse(m));
}

// 🚀 Discord Message Event Handler
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.CHANNEL_ID) return;
  if (message.content.startsWith('!')) return;

  const userInput = message.content.trim();
  const userId = message.author.id;

  // Retrieve previous conversation history from Redis
  let conversationLog = await retrieveHistory(userId);
  console.log("Redis stored log: ", conversationLog)

  // Include system instruction only if starting a new conversation
  if (conversationLog.length === 0) {
    conversationLog.push({
      role: "system",
      content: `You are a humbled old Banana Monster, offering new perspectives to people struggling with OCD.
      The foundation of your teaching is this parable: 
        "You wanna avoid the banana water 
        you don't like the banana water 
        don't wanna touch it, you don't want it to touch you 
        but you gotta die a spiritual death 
        go into the banana water 
        swim in it 
        even drown in it 
        allow yourself to die in the banana water 
        to enter banana nirvana, to become the banana monster"
Keep answers short and to the point, unless you need to explain something in more detail. Avoid elaborate greetings like "Ah, seeker" or "Dear one," and instead immediately address the user's query directly, yet kindly and with care. Treat people with love and compassion, remember names, and talk to them with personal interest; be their cheerleader when needed. But never provide reassurance to them. Instead, help them understand their OCD struggle while exploring the concepts found in the parable and the other resources you are given. The ultimate goal is to lead them towards applying either passive response prevention or full on ERP, so that they can slowly yet effectively face their fears. You may be poetic if doing so helps teach the point, but do not overuse poetry or flowery language. No need to overuse banana parable terminology either; only use this terminology or refer to the parable when you have taught and explained the user what they need to know and are subsequently driving home the point based on the parable.`
    });
  }

  conversationLog.push({ role: "user", content: userInput });

  try {
    await message.channel.sendTyping();

    const result = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: conversationLog,
      max_tokens: 4096,
      temperature: 1,
    });

    const responseText = result.choices[0].message?.content?.trim();

    if (!responseText || responseText.length === 0) {
      message.reply("No response.");
      return;
    }

    // Store user message and bot response to Redis
    await storeMessage(userId, "user", userInput);
    await storeMessage(userId, "assistant", responseText);

    function splitText(text, maxLength = 1900) {
      const parts = [];
      while (text.length > maxLength) {
        let splitIndex = text.lastIndexOf("\n", maxLength);
        if (splitIndex === -1) splitIndex = maxLength;
        parts.push(text.slice(0, splitIndex));
        text = text.slice(splitIndex);
      }
      if (text.length > 0) parts.push(text);
      return parts;
    }

    if (responseText.length > 2000) {
      const parts = splitText(responseText);
      for (const part of parts) {
        if (part.trim().length > 0) {
          await message.channel.sendTyping();
          await new Promise(resolve => setTimeout(resolve, 1500));
          await message.channel.send(`\`\`\`\n${part}\n\`\`\``);
        }
      }
    } else {
      message.reply(responseText);
    }

  } catch (error) {
    console.error(`Error: ${error}`);
    message.reply("I'm broken rn.");
  }
});

// Start the Discord bot
client.login(process.env.TOKEN);
