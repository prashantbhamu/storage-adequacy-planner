#!/usr/bin/env bash
# Publish the committed code to a Hugging Face Space (Docker SDK).
#
#   deploy/push_space.sh <hf-user>/<space-name>
#
# Only files tracked by git at HEAD are sent (via git archive), so local-only
# data and uncommitted changes never leave this machine. Needs the `hf` CLI
# (pip install huggingface_hub) and a prior `hf auth login` with a write token.
set -euo pipefail

space="${1:?usage: deploy/push_space.sh <hf-user>/<space-name>}"
root="$(git rev-parse --show-toplevel)"
bundle="$(mktemp -d)"
trap 'rm -rf "$bundle"' EXIT

git -C "$root" archive HEAD Dockerfile .dockerignore requirements.txt LICENSE PRIVACY.md \
  backend examples frontend | tar -x -C "$bundle"
cp "$root/deploy/huggingface/README.md" "$bundle/README.md"

hf upload "$space" "$bundle" . --repo-type space \
  --delete "backend/*" --delete "frontend/*" --delete "examples/*" \
  --commit-message "Deploy $(git -C "$root" rev-parse --short HEAD)"
echo "Deployed. The Space rebuilds itself: https://huggingface.co/spaces/$space"
