#!/usr/bin/env bash
set -euo pipefail

UUID="snaptext@cwittenberg"
BUILD_DIR="build"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
PROJECT_DIR="$(pwd)"
PACKAGE_PATH="$PROJECT_DIR/$BUILD_DIR/$UUID.shell-extension.zip"
SHEXLI_VENV="$PROJECT_DIR/.shexli-venv"

echo "Cleaning up previous builds..."
rm -rf "$BUILD_DIR"
rm -f "$UUID.zip"
rm -f "$UUID.shell-extension.zip"

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
glib-compile-schemas --strict schemas/

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

        if ! command -v msgfmt &> /dev/null; then
            echo "Error: msgfmt not found. Install gettext to compile translations."
            exit 1
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

if [ -f stylesheet.css ]; then
    cp stylesheet.css "$BUILD_DIR/"
fi

if [ -f trayicon.svg ]; then
    cp trayicon.svg "$BUILD_DIR/"
fi

echo "Packaging extension..."
if command -v gnome-extensions &> /dev/null; then
    gnome-extensions pack "$BUILD_DIR" \
        --extra-source=extension.js \
        --extra-source=prefs.js \
        --extra-source=schemas \
        --extra-source=locale \
        --extra-source=trayicon.svg \
        --force

    mv "$UUID.shell-extension.zip" "$PACKAGE_PATH"
else
    echo "gnome-extensions CLI not found, falling back to zip..."

    if ! command -v zip &> /dev/null; then
        echo "Error: zip not found. Install zip or gnome-shell-extension-prefs / gnome-shell-common."
        exit 1
    fi

    (cd "$BUILD_DIR" && zip -r "../$UUID.shell-extension.zip" .)
    mv "$UUID.shell-extension.zip" "$PACKAGE_PATH"
fi

echo "Running Shexli EGO checks..."
if command -v shexli &> /dev/null; then
    shexli "$PROJECT_DIR/$BUILD_DIR" --format text
    shexli "$PACKAGE_PATH" --format text
    shexli "$PACKAGE_PATH" --format json > "$PROJECT_DIR/shexli-report.json"
    echo "Shexli JSON report written to: $PROJECT_DIR/shexli-report.json"
else
    echo "Shexli not found in PATH."

    if command -v python3.12 &> /dev/null; then
        echo "Creating local Shexli virtual environment..."
        python3.12 -m venv "$SHEXLI_VENV"
        # shellcheck disable=SC1091
        source "$SHEXLI_VENV/bin/activate"

        python -m pip install --upgrade pip
        python -m pip install "git+https://github.com/GNOME/extensions-web.git#subdirectory=shexli"

        shexli "$PROJECT_DIR/$BUILD_DIR" --format text
        shexli "$PACKAGE_PATH" --format text
        shexli "$PACKAGE_PATH" --format json > "$PROJECT_DIR/shexli-report.json"
        echo "Shexli JSON report written to: $PROJECT_DIR/shexli-report.json"
    else
        echo "Warning: python3.12 not found, skipping Shexli checks."
        echo "Install Python 3.12 or activate your existing shexli-venv before running this script."
    fi
fi

echo "Installing extension locally..."
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR"

cp "$BUILD_DIR/metadata.json" "$EXTENSION_DIR/"
cp "$BUILD_DIR/extension.js" "$EXTENSION_DIR/"
cp "$BUILD_DIR/prefs.js" "$EXTENSION_DIR/"
cp -r "$BUILD_DIR/schemas" "$EXTENSION_DIR/"

if [ -f "$BUILD_DIR/stylesheet.css" ]; then
    cp "$BUILD_DIR/stylesheet.css" "$EXTENSION_DIR/"
fi

if [ -f "$BUILD_DIR/trayicon.svg" ]; then
    cp "$BUILD_DIR/trayicon.svg" "$EXTENSION_DIR/"
fi

if find "$BUILD_DIR/locale" -type f -name '*.mo' | grep -q .; then
    cp -r "$BUILD_DIR/locale" "$EXTENSION_DIR/"
fi

echo "Upload package created at: $PACKAGE_PATH"


rm -rf .shexli-venv