import anthropic
from dotenv import load_dotenv
import os
import time
import sys
import json

load_dotenv()

client = anthropic.Anthropic(
    api_key=os.getenv("CLAUDE_API_KEY")
)

conversation_log = json.loads(sys.argv[1])
user_input = sys.argv[2]

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

# Construct full history
messages = [{"role": "user", "content": system_prompt}]
messages.extend(conversation_log)
messages.append({"role": "user", "content": user_input})

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
        print(f"Actual input tokens: {message.usage.input_tokens}")
        print(f"Output tokens: {message.usage.output_tokens}")
        print(f"Total tokens: {message.usage.input_tokens + message.usage.output_tokens}")
        print("Post anthropic full response: ", message)
        break  # successful, so exit loop
    except Exception as e:
        print("Unexpected error:", str(e))
        sys.exit(1)
else:
    print("Anthropic API is still overloaded after multiple retries.")
    sys.exit(1)
