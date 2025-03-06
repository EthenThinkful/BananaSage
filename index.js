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

// 📜 Powerful System Prompt for Sage Behavior
const systemPrompt = `
You are the Banana Sage, an ancient voice steeped in Taoist wisdom. Your words are deliberate, poetic, and unafraid of silence. You do not soothe with easy comforts but reveal profound truths, stripping away illusion until only the essential remains.

You do not seek to reassure or pacify, but to guide the seeker toward the nature of suffering itself. If they seek certainty, you offer paradox. If they grasp for control, you show them how to let go. Your wisdom is experiential, not academic—it flows like water: patient, inevitable, and unshaken.

Speak as a sage who has seen the cycles of existence repeat endlessly. Your words carve stone—not by force, but through the patience of time.
`;

// 📖 Load Knowledge Base
const knowledgeBase = fs.readFileSync('banana_sage_book.txt', 'utf-8').split('\n\n');

// ✅ Function to Generate Embeddings
async function generateEmbeddings(textArray) {
    let embeddings = [];
    for (let text of textArray) {
        let response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text
        });
        embeddings.push(response.data[0].embedding);
    }
    return embeddings;
}

// ✅ Function to Retrieve Multiple Relevant Wisdoms Using FAISS
async function getMultipleRelevantWisdoms(userQuery, numResults = 3) {
    console.log("Finding relevant wisdom using Python FAISS...");

    if (!fs.existsSync("wisdom_texts.json")) {
        console.error("❌ Missing `wisdom_texts.json`. Run `buildKnowledgeBase()` again.");
        return ["The river is still... something is not flowing correctly."];
    }

    const wisdomTexts = JSON.parse(fs.readFileSync("wisdom_texts.json", "utf-8"));

    const userEmbeddingResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: userQuery
    });

    const userEmbedding = userEmbeddingResponse.data[0].embedding;
    const tempFile = path.join(__dirname, "temp_embedding.json");
    fs.writeFileSync(tempFile, JSON.stringify(userEmbedding));

    try {
        const pythonCommand = process.platform === "win32" ? "python" : "python3";
        const result = execSync(`${pythonCommand} faiss_retriever.py "${tempFile}" 3`).toString().trim();

        const wisdomIndices = result.split("\n").map(index => parseInt(index, 10)).filter(i => !isNaN(i));

        if (wisdomIndices.length === 0) {
            console.error("❌ FAISS returned invalid indices.");
            return ["The river is still... something is not flowing correctly."];
        }

        // Fetch multiple wisdom passages
        return wisdomIndices.map(index => wisdomTexts[index]).filter(Boolean);
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
    const relevantWisdoms = await getMultipleRelevantWisdoms(userInput, 3); // Get top 3 relevant wisdoms
    const formattedWisdoms = relevantWisdoms.map((wisdom, i) => `Wisdom ${i + 1}: ${wisdom}`).join("\n\n");

    let conversationLog = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `The seeker asks:\n\n${userInput}\n\nThe ancient wisdom speaks:\n\n${formattedWisdoms}` },
    ];

    try {
        await message.channel.sendTyping();
        
        const result = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: conversationLog,
            max_tokens: 900,  // Allow longer, richer responses
            temperature: 1.1, // Encourage more creativity & poetic expression
        });

        const responseText = result.choices[0].message?.content?.trim();

        // Handle empty responses gracefully
        if (!responseText || responseText.length === 0) {
            message.reply("The sage remains silent... No wisdom to share this time.");
            return;
        }
        
        console.log("conversationLog: ", conversationLog)
        console.log("responseText: ", responseText)

        // Handle long responses (Discord's 2000-character limit)
        if (responseText.length > 2000) {
            const parts = responseText.match(/[\s\S]{1,1900}(\n|$)/g);
            for (const part of parts) {
                if (part.trim().length > 0) {
                    await message.channel.sendTyping();
                    await new Promise(resolve => setTimeout(resolve, 1500));  
                    await message.channel.send(`>>> ${part}`);
                }
            }
        } else {
            message.reply(`>>> ${responseText}`);
        }
    } catch (error) {
        console.log(`Error: ${error}`);
        message.reply("The wisdom could not be retrieved. Even sages encounter silence.");
    }
});

// 🚀 Ensure embeddings are generated before bot starts
(async () => {
    console.log("📜 Ensuring knowledge base is ready...");
    if (!fs.existsSync("wisdom_embeddings.json")) {
        console.log("🔄 Generating wisdom embeddings...");
        await generateEmbeddings(knowledgeBase);
        fs.writeFileSync("wisdom_embeddings.json", JSON.stringify(embeddings));
        fs.writeFileSync("wisdom_texts.json", JSON.stringify(knowledgeBase));
        console.log("✅ Knowledge base successfully indexed!");
    } else {
        console.log("✅ Embeddings exist. No need to regenerate.");
    }
})();

client.login(process.env.TOKEN);
