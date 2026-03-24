#!/bin/bash
# Update vendor libraries from WebAdmin to ChatStandalone
# Run this from the ChatStandalone directory

set -e

SOURCE="../WebAdmin/public/shared"
DEST="./shared"

if [ ! -d "$SOURCE" ]; then
    echo "Error: Source not found: $SOURCE"
    echo "Make sure to run this from the ChatStandalone directory"
    exit 1
fi

echo -e "\033[36mUpdating vendor libraries...\033[0m"
echo -e "\033[90mSource: $SOURCE\033[0m"
echo -e "\033[90mDest:   $DEST\033[0m"
echo ""

# Remove old vendor directory
if [ -d "$DEST" ]; then
    rm -rf "$DEST"
    echo -e "\033[33mRemoved old vendor directory\033[0m"
fi

# Copy new files
cp -r "$SOURCE" "$DEST"
echo -e "\033[32mCopied vendor files\033[0m"

# Show what was copied
echo ""
echo -e "\033[36mUpdated files:\033[0m"
find "$DEST" -type f | while read file; do
    size=$(du -h "$file" | cut -f1)
    rel_path="${file#$DEST/}"
    echo -e "  \033[90m$rel_path\033[0m \033[2m($size)\033[0m"
done

echo ""
echo -e "\033[32mDone! Vendor libraries updated.\033[0m"
