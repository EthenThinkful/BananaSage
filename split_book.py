import json
import re

# 🚀 Read the full book text
with open("banana_sage_book.txt", "r") as f:
    text = f.read()

# 🚀 Use regex to split by "Chapter X:"
chapters = re.split(r"(Chapter\s\d+:)", text)
structured_chapters = []

# 🚀 Reconstruct chapters properly
for i in range(len(chapters)):
    if re.match(r"Chapter\s\d+:", chapters[i]):
        chapter_title = chapters[i].strip()
        chapter_content = chapters[i + 1].strip() if i + 1 < len(chapters) else ""
        structured_chapters.append(f"{chapter_title} {chapter_content}")

# 🚀 Save structured wisdom
with open("structured_wisdom.json", "w") as f:
    json.dump(structured_chapters, f, indent=2)

print(f"✅ Successfully split book into {len(structured_chapters)} chapters.")
