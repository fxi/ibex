#!/usr/bin/env bash
# Copy the deploy and data configuration from .env to the GitHub repository.
#
#   scripts/gh-setup.sh [owner/repo]     # default: the repository gh resolves here
#
# Only the names below are sent; nothing else in .env leaves this machine. Empty values
# are skipped, so rerunning never blanks a setting. Enable Pages (source: GitHub Actions)
# in the repository settings afterwards.
set -euo pipefail

SECRETS=(S3_ENDPOINT S3_KEY S3_SECRET S3_BUCKET)
VARIABLES=(VITE_DATA_URL VITE_HEATMAP_URL S3_PREFIX S3_PUBLIC_URL APP_ORIGIN)

repo=(${1:+--repo "$1"})
[[ -f .env ]] || { echo "No .env here; run from the repository root." >&2; exit 1; }

value() {
  # Last assignment wins, as in dotenv; strip optional quotes.
  sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" .env |
    tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

for name in "${SECRETS[@]}"; do
  v=$(value "$name")
  if [[ -n "$v" ]]; then
    printf '%s' "$v" | gh secret set "$name" ${repo[@]+"${repo[@]}"}
  else
    echo "skip secret $name (empty)"
  fi
done
for name in "${VARIABLES[@]}"; do
  v=$(value "$name")
  if [[ -n "$v" ]]; then
    gh variable set "$name" --body "$v" ${repo[@]+"${repo[@]}"}
  else
    echo "skip variable $name (empty)"
  fi
done
