#!/usr/bin/env bash
set -euo pipefail

UUID="snaptext@cwittenberg"
BUILD_DIR="build"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Cleaning up previous builds..."
rm -rf "$BUILD_DIR"
rm -f "$UUID.zip"

echo "Creating build directory structure..."
mkdir -p "$BUILD_DIR/schemas"
mkdir -p "$BUILD_DIR/locale"
mkdir -p "po"

echo "Validating extension files..."
for file in metadata.json extension.js prefs.js schemas/org.gnome.shell.extensions.snaptext.gschema.xml; do
    if [ ! -f "$file" ]; then
        echo "Error: $file not found in the current directory. Please make sure all files exist."
        exit 1
    fi
done

echo "Compiling GSettings schema locally..."
glib-compile-schemas schemas/

echo "Extracting strings and generating translation template..."
if command -v xgettext &> /dev/null; then
    xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --add-comments -o po/snaptext.pot extension.js prefs.js
    echo "Translation template generated at po/snaptext.pot"
else
    echo "Warning: xgettext not found, skipping string extraction."
fi

echo "Merging and compiling translations..."
for po_file in po/*.po; do
    if [ -f "$po_file" ]; then
        if command -v msgmerge &> /dev/null && [ -f "po/snaptext.pot" ]; then
            msgmerge --update --quiet "$po_file" po/snaptext.pot
        fi
        lang=$(basename "$po_file" .po)
        mkdir -p "$BUILD_DIR/locale/$lang/LC_MESSAGES"
        msgfmt "$po_file" -o "$BUILD_DIR/locale/$lang/LC_MESSAGES/snaptext.mo"
        echo "Compiled locale: $lang"
    fi
done

echo "Copying files to build directory..."
cp metadata.json extension.js prefs.js "$BUILD_DIR/"
cp -r schemas "$BUILD_DIR/"

if [ -d "$BUILD_DIR/locale" ]; then
    cp -r "$BUILD_DIR/locale" "$BUILD_DIR/" 2>/dev/null || true
fi

echo "Packaging extension..."
if command -v gnome-extensions &> /dev/null; then
    gnome-extensions pack "$BUILD_DIR" --extra-source=extension.js --extra-source=prefs.js --extra-source=locale --force
    mv "$UUID.shell-extension.zip" "$BUILD_DIR/"
else
    echo "gnome-extensions CLI not found, falling back to zip..."
    (cd "$BUILD_DIR" && zip -r "../$UUID.zip" .)
    mv "$UUID.zip" "$BUILD_DIR/"
fi

echo "Installing extension locally..."
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR"
cp -r "$BUILD_DIR"/* "$EXTENSION_DIR/"

echo "Build and installation complete."
echo "Extension installed to: $EXTENSION_DIR"
echo ""
echo "To enable the extension, restart your GNOME Shell (Alt+F2, then type 'r' under X11, or log out and log back in under Wayland) and run:"
echo "gnome-extensions enable $UUID"