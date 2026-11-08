#!/usr/bin/env bash
# One-time setup of the local-models Python env (Python 3.12: mediapipe has no 3.14 wheels yet).
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-$(command -v python3.12 || echo /opt/homebrew/bin/python3.12)}"
[[ -d .venv ]] || "$PY" -m venv .venv
.venv/bin/pip install -r requirements.txt
# Prefetch SAM 3 weights (~1 GB). Plain HTTP: the hf-xet backend has hung at 0 bytes on this machine.
HF_HUB_DISABLE_XET=1 .venv/bin/python -c "from mlx_vlm.utils import get_model_path; get_model_path('mlx-community/sam3-8bit')"
echo "Local-models env ready: $(pwd)/.venv"
