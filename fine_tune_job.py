import openai
from dotenv import load_dotenv
import os
import time

load_dotenv()

openai.api_key = os.getenv("API_KEY")

# Upload the training file for fine-tuning
# response = openai.files.create(
#     file=open("data/banana_sage_training_data.jsonl", "rb"),
#     purpose="fine-tune"
# )
# print("File uploaded with ID:", response.id)

#fine tuning job
fine_tune_response = openai.fine_tuning.jobs.create(
    training_file="file-7nFyPy6mjyV6bFv6F9fRDS",
    model="gpt-4o-mini-2024-07-18"
)
print("Fine-tuning job created with ID:", fine_tune_response.id)

# fine_tune_job_id = openai.fine_tuning.jobs.retrieve("ftjob-KeyXu9yH64uKVmqovPnD6HRn")
# print("Fine-tuning job status:", fine_tune_job_id)
