import faiss
import numpy as np
import json
import openai
from dotenv import load_dotenv
import os

load_dotenv()

openai.api_key = os.getenv("API_KEY")

# 🚀 Load structured chapters
with open("structured_wisdom.json", "r") as f:
    wisdom_texts = json.load(f)

# 🚀 Generate embeddings for each chapter
embeddings = []
for passage in wisdom_texts:
    response = openai.embeddings.create(model="text-embedding-ada-002", input=passage)
    embeddings.append(response.data[0].embedding)

# 🚀 Convert to numpy array and store in FAISS
embedding_dim = len(embeddings[0])
index = faiss.IndexFlatL2(embedding_dim)
index.add(np.array(embeddings, dtype="float32"))

# 🚀 Save FAISS index and structured wisdom
faiss.write_index(index, "wisdom_index.faiss")
with open("indexed_wisdom.json", "w") as f:
    json.dump(wisdom_texts, f)

print(f"✅ Successfully indexed {len(wisdom_texts)} structured wisdom passages.")
