"""Isolated pose verification worker; the API can stop it and its ffmpeg children."""
import json
import sys
from pathlib import Path

from .angles import extract

if __name__ == "__main__":
    args = json.loads(sys.argv[1])
    result = extract(Path(args["video"]), Path(args["out_dir"]), args["step_deg"], args["size"], viz=True)
    print(json.dumps(result))
