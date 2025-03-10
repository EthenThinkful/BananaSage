import json

def remove_line_breaks(obj):
    """
    Recursively remove line breaks from all string values in a JSON object.
    """
    if isinstance(obj, dict):
        return {k: remove_line_breaks(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [remove_line_breaks(item) for item in obj]
    elif isinstance(obj, str):
        # Remove all types of line breaks (CR, LF)
        return obj.replace('\r', ' ').replace('\n', ' ')
    else:
        return obj

input_file = "data/banana_sage_training_data.jsonl"
output_file = "data/banana_sage_training_data_clean.jsonl"

with open(input_file, 'r', encoding='utf-8') as infile, \
     open(output_file, 'w', encoding='utf-8') as outfile:
    
    for line in infile:
        if line.strip():  # ensure the line is not empty
            try:
                json_obj = json.loads(line)
                # Recursively remove line breaks from all string values
                cleaned_obj = remove_line_breaks(json_obj)
                # Dump the cleaned JSON object as a single line
                outfile.write(json.dumps(cleaned_obj) + "\n")
            except json.JSONDecodeError as e:
                print("Error parsing a line:", e)

print(f"Cleaning complete. Clean file saved as {output_file}")
