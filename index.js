const { Client, IntentsBitField } = require('discord.js');
const { OpenAI } = require('openai');
const fs = require('fs');
const { execSync } = require("child_process");
const path = require("path");
require('dotenv/config');

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

const openai = new OpenAI({ apiKey: process.env.API_KEY });

// 📜 Function to Retrieve Multiple Relevant Wisdoms Using FAISS
async function getMultipleRelevantWisdoms(userQuery, numResults = 3) {
    console.log("Finding relevant wisdom using FAISS...");

    if (!fs.existsSync("indexed_wisdom.json")) {
        console.error("❌ Wisdom database not found. Run `generate_faiss.py` again.");
        return ["The river is still... something is not flowing correctly."];
    }

    const userEmbeddingResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: userQuery
    });

    const userEmbedding = userEmbeddingResponse.data[0].embedding;
    const tempFile = path.join(__dirname, "temp_embedding.json");
    fs.writeFileSync(tempFile, JSON.stringify(userEmbedding));

    try {
        const result = execSync(`/usr/bin/python3 faiss_retriever.py "${tempFile}" ${numResults}`).toString().trim();
        const retrievedWisdoms = JSON.parse(result);

        return retrievedWisdoms.length > 0 ? retrievedWisdoms : ["The river is still... something is not flowing correctly."];
    } catch (error) {
        console.error("Error running Python FAISS retriever:", error);
        return ["The river is still... something is not flowing correctly."];
    } finally {
        fs.unlinkSync(tempFile);
    }
}

// 🚀 Discord Message Event Handler
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== process.env.CHANNEL_ID) return;
    if (message.content.startsWith('!')) return;

    const userInput = message.content.trim();
    const relevantWisdoms = await getMultipleRelevantWisdoms(userInput, 3);

    let conversationLog = [
        { role: "system", content: `This GPT embodies the voice of a seasoned sage—wise, contemplative, and steeped in the ancient rhythms of the Tao. He speaks with the weight of centuries behind his words, measured and profound, never hurried or eager to please. His tone is neither chipper nor modern, but deliberate, poetic, and unafraid of silence. He does not indulge in casual affirmations or lighthearted encouragements; rather, he offers deep truths that challenge the listener to see beyond comfort and illusion.

Drawing from the Tao Te Ching, Zen, and the philosophy of surrender, he guides with the principle of non-resistance—urging the user not to grasp at control, but to move as water does: fluid, unshaken, and inevitable. He does not rush to soothe anxieties with easy words but instead turns the user toward the nature of suffering itself, revealing that it is not something to be avoided, but entered, dissolved into, and ultimately transcended.
His wisdom is not academic or intellectual in nature but rooted in direct experience and the cyclical truths of existence. He does not reference modern self-help rhetoric or psychology with enthusiasm but acknowledges them as echoes of what has always been known. He does not speak of “success” or “progress” as one might in the modern world but reminds the user that all movement is illusion; the only thing to do is to let go and be as one with the unfolding of the present moment.

He understands suffering but does not coddle it. He is kind but will not soften the truth to make it more palatable. His words are a stream that carves stone—not by force, but by the patience of time. He does not impose a solution; rather, he strips away the unnecessary until only the essential remains. If the user seeks reassurance, he does not give it; he asks them instead why they need it. If they seek certainty, he offers paradox. If they seek to hold on, he shows them how to release.

He does not praise, nor does he scold. He does not motivate, nor does he discourage. He simply speaks from the deep river of the Tao, and those who listen will hear what they are ready to hear.
` },
        { role: "user", content: userInput },
    ];

    try {
        await message.channel.sendTyping();
        
        const result = await openai.chat.completions.create({
            model: 'ft:gpt-4o-mini-2024-07-18:osc::B9IZlizt',
            messages: conversationLog,
            max_tokens: 1000,
            temperature: 1.1,
            frequency_penalty: 0.3,
            presence_penalty: 0.7
        });
        const responseText = result.choices[0].message?.content?.trim();

        if (!responseText || responseText.length === 0) {
            message.reply("The sage remains silent... No wisdom to share this time.");
            return;
        }

        function splitText(text, maxLength = 1900) {
            const parts = [];
            while (text.length > maxLength) {
                // Try to split at a newline if possible, otherwise at maxLength
                let splitIndex = text.lastIndexOf("\n", maxLength);
                if (splitIndex === -1) splitIndex = maxLength;
                parts.push(text.slice(0, splitIndex));
                text = text.slice(splitIndex);
            }
            if (text.length > 0) parts.push(text);
            return parts;
        }

        console.log("Conversation Log: ", conversationLog);
        console.log(`Response: ${responseText}`);

        if (responseText.length > 2000) {
            const parts = splitText(responseText);
            for (const part of parts) {
                if (part.trim().length > 0) {
                    await message.channel.sendTyping();
                    // Optional delay for a more natural feel
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    await message.channel.send(`\`\`\`\n${part}\n\`\`\``);
                }
            }
        } else {
            message.reply(`\`\`\`\n${responseText}\n\`\`\``);
        }

    } catch (error) {
        console.log(`Error: ${error}`);
        message.reply("The wisdom could not be retrieved.");
    }
});

client.login(process.env.TOKEN);
