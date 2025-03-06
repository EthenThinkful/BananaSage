import faiss
import numpy as np
import json
import sys

# 🚀 Read user embedding from file
temp_file = sys.argv[1]

with open(temp_file, "r") as f:
    user_embedding = np.array(json.load(f), dtype="float32").reshape(1, -1)

# 🚀 Load stored embeddings
with open("wisdom_embeddings.json", "r") as f:
    wisdom_embeddings = np.array(json.load(f), dtype="float32")

# Ensure the embeddings are correctly shaped
if wisdom_embeddings.ndim != 2:
    print("-1")  # Return an invalid index if embeddings are wrong
    sys.exit(1)

embedding_dimension = wisdom_embeddings.shape[1]

if user_embedding.shape[1] != embedding_dimension:
    print("-1")  # If query embedding size is incorrect, return an invalid index
    sys.exit(1)

# 🚀 Accept `k` as a command-line argument (default to 3)
k = int(sys.argv[2]) if len(sys.argv) > 2 else 3  # Retrieve `k` most relevant wisdoms

# 🚀 Debugging: Check if embeddings are valid
print(f"User embedding shape: {user_embedding.shape}", file=sys.stderr)
print(f"Wisdom embeddings shape: {wisdom_embeddings.shape}", file=sys.stderr)

# Create a FAISS index and add the embeddings
index = faiss.IndexFlatL2(embedding_dimension)
index.add(wisdom_embeddings)

# Perform FAISS search (get `k` closest matches)
_, indices = index.search(user_embedding, k)

# 🚀 Debugging: Print FAISS selected indices before returning
sys.stderr.write(f"FAISS selected indices: {indices[0]}\n")

# Print all retrieved indices (one per line)
print("\n".join(map(str, indices[0]))) 
