#!/usr/bin/env bash

set -euo pipefail

UUID="livetext@cwittenberg"
BUILD_DIR="build"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Cleaning up previous builds..."
rm -rf "$BUILD_DIR"
rm -f "$UUID.zip"

echo "Creating build directory structure..."
mkdir -p "$BUILD_DIR/schemas"

echo "Validating extension files..."
for file in metadata.json extension.js prefs.js schemas/org.gnome.shell.extensions.livetext.gschema.xml; do
    if [ ! -f "$file" ]; then
        echo "Error: $file not found in the current directory. Please make sure all files exist."
        exit 1
    fi
done

echo "Compiling GSettings schema locally..."
glib-compile-schemas schemas/

echo "Copying files to build directory..."
cp metadata.json extension.js prefs.js "$BUILD_DIR/"
cp -r schemas "$BUILD_DIR/"

echo "Packaging extension..."
if command -v gnome-extensions &> /dev/null; then
    gnome-extensions pack "$BUILD_DIR" --extra-source=extension.js --extra-source=prefs.js --force
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