#!/usr/bin/env bash
# generate-locale.sh
set -euo pipefail

DOMAIN="snaptext"
PODIR="po"

# most popular langs i'd say.
LANGS=(
    "ar" "bn" "bg" "bs" "ca" "cs" "da" "de" "el" "en_GB"
    "es" "et" "fa" "fi" "fr" "gu" "he" "hi" "hr" "hu"
    "id" "it" "ja" "kn" "ko" "lt" "lv" "ml" "mr" "ms"
    "nl" "no" "pl" "pt" "pt_BR" "ro" "ru" "sk" "sl"
    "sv" "sw" "ta" "te" "th" "tr" "uk" "ur" "vi" "zh_CN" "zh_TW"
)

echo "Creating $PODIR directory..."
mkdir -p "$PODIR"

echo "Extracting translation strings into $PODIR/$DOMAIN.pot..."
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
    --output="$PODIR/$DOMAIN.pot" \
    extension.js prefs.js dependencies.js

echo "Generating or updating PO files for 50 languages..."
for lang in "${LANGS[@]}"; do
    if [ -f "$PODIR/$lang.po" ]; then
        echo "Updating $lang.po..."
        msgmerge --update --backup=none "$PODIR/$lang.po" "$PODIR/$DOMAIN.pot"
    else
        echo "Initializing $lang.po..."
        # We allow fallback since users' systems might not have all 50 full locales installed to perform a perfect init
        msginit --no-translator --input="$PODIR/$DOMAIN.pot" --locale="$lang" --output="$PODIR/$lang.po" || true
    fi
done

echo "Automatically translating missing strings via Google Trans..."
python3 auto_translate.py