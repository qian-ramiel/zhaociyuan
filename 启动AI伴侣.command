#!/bin/zsh
cd "$(dirname "$0")" || exit 1
exec npm run dev
