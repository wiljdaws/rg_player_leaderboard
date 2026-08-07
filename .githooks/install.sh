#!/usr/bin/env bash
# One-shot: point git at our tracked hooks directory + mark them executable.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "hooks installed → git config core.hooksPath = $(git config core.hooksPath)"
