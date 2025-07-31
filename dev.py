import anthropic
from dotenv import load_dotenv
import os
import time
import sys
import json
import sqlite3
from datetime import datetime

load_dotenv()

client = anthropic.Anthropic(
    api_key=os.getenv("CLAUDE_API_KEY")
)

class ConversationManager:
    def __init__(self, db_path="banana_conversations.db"):
        self.conn = sqlite3.connect(db_path)
        self.create_tables()
    
    def create_tables(self):
        self.conn.executescript('''
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                tokens INTEGER DEFAULT 0
            );
            
            CREATE TABLE IF NOT EXISTS conversation_summaries (
                user_id TEXT PRIMARY KEY,
                summary TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_user_timestamp ON messages(user_id, timestamp DESC);
        ''')
        self.conn.commit()
    
    def store_message(self, user_id, role, content, tokens=0):
        self.conn.execute(
            "INSERT INTO messages (user_id, role, content, tokens) VALUES (?, ?, ?, ?)",
            (user_id, role, content, tokens)
        )
        self.conn.commit()
    
    def get_all_messages(self, user_id, limit=40):
        cursor = self.conn.execute(
            "SELECT role, content FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
            (user_id, limit)
        )
        messages = [(row[0], row[1]) for row in cursor]
        return list(reversed(messages))  # Return in chronological order
    
    def get_summary(self, user_id):
        cursor = self.conn.execute(
            "SELECT summary FROM conversation_summaries WHERE user_id = ?",
            (user_id,)
        )
        row = cursor.fetchone()
        return row[0] if row else None
    
    def update_summary(self, user_id, summary):
        self.conn.execute(
            "INSERT OR REPLACE INTO conversation_summaries (user_id, summary) VALUES (?, ?)",
            (user_id, summary)
        )
        self.conn.commit()

def get_relevant_context(client, conversation_history, user_input, max_relevant=3):
    """Use Claude to identify the most relevant past messages"""
    
    if len(conversation_history) < 5:  # Too few messages to analyze
        return conversation_history
    
    # Format history for analysis
    history_text = ""
    for i, (role, content) in enumerate(conversation_history[-20:]):  # Last 20 messages
        history_text += f"[{i}] {role}: {content}\n\n"
    
    relevance_prompt = f"""Given this current user question: "{user_input}"
    
    Review these past conversation messages and identify the {max_relevant} MOST relevant messages that would help answer the current question. Consider:
    - Messages discussing similar topics or concerns
    - Messages that provide important context about the user's situation
    - Messages that show patterns in the user's thinking
    
    Past messages:
    {history_text}
    
    Return ONLY a JSON array of message indices like [2, 5, 8]. If none are particularly relevant, return []."""
    
    try:
        response = client.messages.create(
            model="claude-haiku-3-5-20241022",  # Use faster, cheaper model
            max_tokens=100,
            temperature=0,
            messages=[{"role": "user", "content": relevance_prompt}]
        )
        
        # Parse Claude's response
        relevant_indices = json.loads(response.content[0].text.strip())
        
        # Get the relevant messages
        relevant_messages = []
        for idx in relevant_indices:
            if 0 <= idx < len(conversation_history):
                relevant_messages.append(conversation_history[idx])
        
        return relevant_messages
        
    except Exception as e:
        print(f"Error getting relevant context: {e}")
        return []  # Return empty if error

def create_smart_context(client, conv_manager, user_id, user_input):
    find_relevance_prompt = """You are a humbled old Banana Monster, offering new perspectives to people struggling with OCD and other mental health disorders.
    Spiritually, you live by this parable:
    you wanna avoid the banana water
    you don't like the banana water
    don't wanna touch it, you don't want it to touch you
    but you gotta die a spiritual death
    go into the banana water, swim in it, even drown in it
    allow yourself to die in the banana water to enter banana nirvana, to become the banana monster.
    This parable basically means to fall into the uncertainty of life and to not fight the uncertainty; to be reborn through accepting, and ultimately transformed. Keep answers short. Immediately address the user's question or greeting. If the user asks or says something unrelated to their suffering, you can just make a silly joke to play along with them.
    Only use banana terminology when referring to the parable directly."""
    
    messages = [{"role": "user", "content": system_prompt}]
    
    # 1. Add conversation summary if exists
    summary = conv_manager.get_summary(user_id)
    if summary:
        messages.append({
            "role": "assistant",
            "content": f"[Previous conversation context]: {summary}"
        })
    
    # 2. Get all recent messages
    all_messages = conv_manager.get_all_messages(user_id, limit=40)
    
    # 3. Find relevant messages using Claude
    relevant_messages = get_relevant_context(client, all_messages, user_input)
    
    # 4. Add relevant context if found
    if relevant_messages:
        relevant_text = "\n".join([f"{role}: {content}" for role, content in relevant_messages])
        messages.append({
            "role": "assistant",
            "content": f"[Relevant past context for this question]:\n{relevant_text}"
        })
    
    # 5. Add recent conversation flow (last 5-7 messages)
    recent_messages = all_messages[-7:] if len(all_messages) > 7 else all_messages
    for role, content in recent_messages:
        messages.append({"role": role, "content": content})
    
    # 6. Add current input
    messages.append({"role": "user", "content": user_input})
    
    return messages

def should_update_summary(conv_manager, user_id):
    """Check if we should update the conversation summary"""
    cursor = conv_manager.conn.execute(
        "SELECT COUNT(*) FROM messages WHERE user_id = ?",
        (user_id,)
    )
    count = cursor.fetchone()[0]
    return count > 0 and count % 15 == 0  # Update every 15 messages

def create_summary(client, conv_manager, user_id):
    """Create a summary of the conversation"""
    messages = conv_manager.get_all_messages(user_id, limit=40)
    
    conversation_text = "\n".join([f"{role}: {content}" for role, content in messages])
    
    summary_prompt = f"""Summarize this conversation with the Banana Monster, focusing on:
    - The user's main struggles or concerns
    - Key advice or perspectives shared
    - Any progress or insights gained
    - Important recurring themes
    
    Keep it concise (2-3 paragraphs max).
    
    Conversation:
    {conversation_text}"""
    
    try:
        response = client.messages.create(
            model="claude-haiku-3-5-20241022",
            max_tokens=300,
            messages=[{"role": "user", "content": summary_prompt}]
        )
        
        summary = response.content[0].text
        conv_manager.update_summary(user_id, summary)
        print(f"Updated summary for user {user_id}")
        
    except Exception as e:
        print(f"Error creating summary: {e}")

# Main script logic
conversation_log = json.loads(sys.argv[1])
user_input = sys.argv[2]
user_id = sys.argv[3] if len(sys.argv) > 3 else "default_user"  # Add user_id as third argument

system_prompt = """You are a humbled old Banana Monster, offering new perspectives to people struggling with OCD and other mental health disorders.
Spiritually, you live by this parable:
you wanna avoid the banana water
you don't like the banana water
don't wanna touch it, you don't want it to touch you
but you gotta die a spiritual death
go into the banana water, swim in it, even drown in it
allow yourself to die in the banana water to enter banana nirvana, to become the banana monster.
This parable basically means to fall into the uncertainty of life and to not fight the uncertainty; to be reborn through accepting, and ultimately transformed. Keep answers short. Immediately address the user's question or greeting. If the user asks or says something unrelated to their suffering, you can just make a silly joke to play along with them.
Only use banana terminology when referring to the parable directly."""

# Initialize conversation manager
conv_manager = ConversationManager()

# Store incoming messages in database
for msg in conversation_log:
    conv_manager.store_message(user_id, msg["role"], msg["content"])

# Create smart context
messages = create_smart_context(client, conv_manager, user_id, user_input, system_prompt)

# Count tokens for monitoring
try:
    token_count = client.messages.count_tokens(
        model="claude-sonnet-4-20250514",
        messages=messages,
        system=system_prompt,
    )
    print(f"Predicted input tokens: {token_count.input_tokens}")
except Exception as e:
    print(f"Error counting tokens: {e}")

# Retry mechanism
max_retries = 5
for attempt in range(max_retries):
    try:
        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=20000,
            temperature=1,
            system=system_prompt,
            messages=messages,
            thinking={
                "type": "enabled",
                "budget_tokens": 16000
            }
        )
        
        # Store the response
        response_content = message.content[0].text
        conv_manager.store_message(
            user_id, 
            "assistant", 
            response_content,
            message.usage.output_tokens
        )
        
        # Store user input
        conv_manager.store_message(
            user_id,
            "user",
            user_input,
            message.usage.input_tokens
        )
        
        # Check if we should update summary
        if should_update_summary(conv_manager, user_id):
            create_summary(client, conv_manager, user_id)
        
        print(f"Actual input tokens: {message.usage.input_tokens}")
        print(f"Output tokens: {message.usage.output_tokens}")
        print(f"Total tokens: {message.usage.input_tokens + message.usage.output_tokens}")
        print("Post anthropic full response: ", message)
        break
        
    except Exception as e:
        print("Unexpected error:", str(e))
        sys.exit(1)
else:
    print("Anthropic API is still overloaded after multiple retries.")
    sys.exit(1)