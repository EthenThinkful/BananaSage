const { Client, IntentsBitField } = require('discord.js');
const { spawn } = require('child_process');
const { createClient } = require('redis');
require('dotenv').config();
const { OpenAI } = require('openai');
const path = require("path");
const os = require("os");

const PYTHON_CMD = os.platform() === 'win32' ? 'python' : 'python3';

const openai = new OpenAI({ apiKey: process.env.API_KEY });

// Redis client setup
const redisClient = createClient({ url: 'redis://127.0.0.1:6379' });
redisClient.connect().catch(console.error);
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

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMembers, // Add this intent for member join events
  ],
});

client.on('ready', () => {
  console.log('🌊 The Banana Sage Bot is online!');
});

gptRephrase = [{
    role: "system",
    content: `if the response looks good, leave as is. If it sounds too poetic or flowery, rewrite it to be more clear and chill.`
  }];

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== process.env.CHANNEL_ID) return;
    if (message.content.startsWith('!')) return;

    const welcomeKey = `welcomed:${message.channel.id}:${message.author.id}`;
    const alreadyWelcomed = await redisClient.get(welcomeKey);

    if (!alreadyWelcomed) {
      try {
        const messageLink = 'https://discord.com/channels/988770359773913098/1124007597209559231/1335268148982579252';
        await message.channel.send(
          `Hey ${message.author}, welcome! This is our OCD support bot, inspired by the Banana Water parable: ${messageLink}

          The story reflects common struggles with compulsions and connects to ACT (Acceptance and Commitment Therapy), which many find helpful in managing OCD.

          A member of our server came up with the parable, and we thought it’d be a great foundation for a bot like this. We hope it helps—even just a little. 🙂
          `
        );
        // Mark the user as welcomed (you can also set an expiration if needed)
        await redisClient.set(welcomeKey, 'true');
      } catch (error) {
        console.error(`Error sending welcome message: ${error}`);
      }
    }
  
    const userInput = message.content.trim();
    const userId = message.author.id;
  
    try {
      await message.channel.sendTyping();
      const conversationLog = await retrieveHistory(userId);
      // Log user's conversation history clearly
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
  
        // console.log(`Raw response: ${response}`); // Log the raw response

        await storeMessage(userId, "user", userInput);

        try {
          // Extract the text from the TextBlock
          console.log(`Extracting text from response: ${response}`); // Log the response being processed
          let textMatch = response.match(/TextBlock\(.*?text="(.*?)",.*?\)/);
          if (!textMatch) {
            textMatch = response.match(/TextBlock\(.*?text='(.*?)',.*?\)/);
          }
          const text = textMatch ? textMatch[1] : "No text block found.";
          await storeMessage(userId, "assistant", text); 

          // Format the text for Discord
          const formattedText = text
            .replace(/\\n\\n/g, '\n\n') // Replace double newlines with actual newlines
            .replace(/\\n/g, '\n') // Replace single newlines with actual newlines
            .replace(/- /g, '\n- '); // Ensure bullet points are on new lines

            // gptRephrase.push({ role: "user", content: formattedText })
            // const result = await openai.chat.completions.create({
            //     model: 'gpt-4o',
            //     messages: gptRephrase,
            //     max_tokens: 4096,
            //     temperature: 1,
            //     });
            
            // const responseText = result.choices[0].message?.content?.trim();

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

client.login(process.env.TOKEN);