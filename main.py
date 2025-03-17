# import os
# os.environ['HF_HOME'] = r'E:\hf_cache'

# from transformers import pipeline
# # from langchain_huggingface import HuggingFacePipeline
# # from langchain.prompts import PromptTemplate
# # from transformers.utils.logging import set_verbosity_error

import openai
from dotenv import load_dotenv
import os
import time
load_dotenv()

open_router_api_key = os.getenv("OPEN_ROUTER_API_KEY")

messages = [
    {"role": "user", "content": "Who are you?"},
]
pipe = pipeline("text-generation", model="Qwen/QwQ-32B")
pipe(messages)

# set_verbosity_error()

# summarization_pipeline = pipeline("summarization", model="facebook/bart-large-cnn")
# response = summarization_pipeline("The quick brown fox jumps over the lazy dog. The lazy dog, however, is not amused by the fox's antics. It prefers to sleep in the sun and ignore the world around it. The fox, on the other hand, is full of energy and always looking for something to do. It runs around, chasing its tail and barking at imaginary things. The dog just rolls its eyes and goes back to sleep.")
# print("🔹 **Generated Summary:**", response)
# summarizer = HuggingFacePipeline(pipeline=summarization_pipeline)

# refinement_pipeline = pipeline("summarization", model="facebook/bart-large", device=0)
# refiner = HuggingFacePipeline(pipeline=refinement_pipeline)

# qa_pipeline = pipeline("question-answering", model="deepset/roberta-base-squad2", device=0)

# summary_template = PromptTemplate.from_template("Summarize the following text in a {length} way:\n\n{text}")

# summarization_chain = summary_template | summarizer | refiner

# text_to_summarize = input("\nEnter text to summarize:\n")
# length = input("\nEnter the length (short/medium/long): ")

# summary = summarization_chain.invoke({"text": text_to_summarize, "length": length})

# print("\n🔹 **Generated Summary:**")
# print(summary)

# while True:
#     question = input("\nAsk a question about the summary (or type 'exit' to stop):\n")
#     if question.lower() == "exit":
#         break

#     qa_result = qa_pipeline(question=question, context=summary)

#     print("\n🔹 **Answer:**")
#     print(qa_result["answer"])