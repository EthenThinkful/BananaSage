import faiss
import numpy as np
import json
import sys

# 🚀 Read user embedding from file
temp_file = sys.argv[1]

with open(temp_file, "r") as f:
    user_embedding = np.array(json.load(f), dtype="float32").reshape(1, -1)

# 🚀 Load stored chapters
with open("indexed_wisdom.json", "r") as f:
    wisdom_texts = json.load(f)

# 🚀 Load FAISS index
index = faiss.read_index("wisdom_index.faiss")

# Ensure embeddings are correct
embedding_dimension = index.d
if user_embedding.shape[1] != embedding_dimension:
    print("-1")  # Return an invalid index if query embedding size is incorrect
    sys.exit(1)

# 🚀 Accept `k` as a command-line argument (default to 3)
k = int(sys.argv[2]) if len(sys.argv) > 2 else 3  # Retrieve `k` most relevant wisdoms

# 🚀 Perform FAISS search (get `k` closest matches)
_, indices = index.search(user_embedding, k)

# 🚀 Print FAISS selected indices before returning
sys.stderr.write(f"FAISS selected indices: {indices[0]}\n")

# 🚀 Print all retrieved wisdom passages (as JSON for Node.js to parse)
retrieved_wisdom = [wisdom_texts[i] for i in indices[0] if i < len(wisdom_texts)]
print(json.dumps(retrieved_wisdom))
