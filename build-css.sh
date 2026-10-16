#!/bin/bash
set -e

# Compile Tailwind into a local stylesheet so the UI works offline.
# The generated file (static/tailwind.css) is committed; run this only when
# templates/ or static/app.js change and introduce new utility classes.

echo "🎨 Building Tailwind CSS..."

npx --yes tailwindcss@3 -c tailwind.config.js \
    -i static/src/tailwind.css \
    -o static/tailwind.css \
    --minify

echo "✅ Wrote static/tailwind.css"
