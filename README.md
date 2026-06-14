# Snap Text Extractor

GNOME Extension enabling the user to select an area of the screen to instantly extract and copy text to the clipboard using native Optical Character Recognition (OCR). Similar to how it works on MacOS.

## Screenshots
Tray extension - that allows you to keep history of snapped texts:
<img width="685" height="538" alt="Screenshot from 2026-06-14 09-58-25" src="https://github.com/user-attachments/assets/4a286975-2ada-4b0a-a6ef-b329acea276a" />

When Text is extracted from a snap and copied to Clipboard, it can also notify you of what has been recognized:
<img width="1885" height="1274" alt="Screenshot from 2026-06-14 09-55-52" src="https://github.com/user-attachments/assets/a4e3a388-2a3c-4bc9-bc0a-6ebe9eec3eee" />

Settings screen:
<img width="1524" height="1396" alt="Screenshot from 2026-06-14 09-58-39" src="https://github.com/user-attachments/assets/f2d42453-6744-4579-abfe-2cacc7c700a5" />

Advanced settings, also offering instant Translate capability:
<img width="1524" height="1396" alt="Screenshot from 2026-06-14 09-58-45" src="https://github.com/user-attachments/assets/114f1f77-517f-4f2d-a08c-3ad59475b339" />


## Features

* **Instant Text Extraction:** Select any part of your screen, and the text within that area is instantly processed and copied to your clipboard.
* **Smart OCR Preprocessing:** Utilizes ImageMagick to maximize Text Recognition accuracy by automatically converting to grayscale, maximizing contrast, upscaling small screen snips, and smartly negating colors for Dark Mode UIs.
* **Multi-Pass OCR Routing:** Dynamically adjusts Page Segmentation Modes (PSM) based on aspect ratio, executing primary and fallback OCR passes to determine the most accurate text based on confidence and garbage ratios.
* **QR Code Detection:** Instantly detects and decodes QR codes using `zbar`, with an optional setting to automatically open HTTP/HTTPS links.
* **Auto-Translation (Experimental):** Automatically translates extracted text to your target language using Google Translate.
* **Extraction History:** Access a history of your 15 most recent text extractions from the GNOME Shell top panel menu.
* **Customizable Shortcut:** Set your own keyboard shortcut. The default is `Super + Shift + T`.
* **Visual Notifications:** Get system banner notifications when text is extracted or when you copy a previous extraction from your history.
* **Seamless GNOME Integration:** Built exclusively for GNOME Shell versions 45 through 50 using modern standard APIs.

## System Dependencies

This extension relies on standard native system tools to capture the screen, decode QR codes, preprocess images, and perform OCR extraction.

Before using the extension, install the required packages for your distribution.

### Ubuntu / Debian / Pop!_OS

```bash
sudo apt update
sudo apt install gnome-screenshot tesseract-ocr tesseract-ocr-eng zbar-tools imagemagick

```

### Fedora

```bash
sudo dnf install gnome-screenshot tesseract tesseract-langpack-eng zbar ImageMagick

```

### Arch Linux / Manjaro

```bash
sudo pacman -S gnome-screenshot tesseract tesseract-data-eng zbar imagemagick

```

## Installation

### Method 1: Local Build

1. Clone the repository or download the source files.
2. Run the provided build script:

```bash
   ./build.sh

```

3. Restart GNOME Shell:
* **Wayland:** Log out and log back in.
* **X11:** Press `Alt + F2`, type `r`, and press `Enter`.


4. Enable the extension using the GNOME Extensions app or run:

```bash
   gnome-extensions enable snaptext@cwittenberg
```

## Usage

1. Press your configured keyboard shortcut, or left-click the top panel icon to instantly trigger extraction.
2. Click and drag over the text you want to extract from your screen.
3. The extracted text is automatically copied to your clipboard.
4. Right-click the panel icon to view your recent history, toggle auto-translate, and access settings.

## TODO

* Language selection. Extension simply uses all available languages in Tesseract. User must be able to turn them on/off
* History length. Would be nice to have a slider to determine how much history to keep track of
* Math recognition. No good Tesseract library exists yet that could do so, as a consequence plugin cannot properly recognize math.

## Support & Feedback

* **Report a Bug:** [Issue Tracker](https://github.com/cwittenberg/snaptext/issues/new?template=bug_report.md)
* **Request a Feature:** [Feature Requests](https://github.com/cwittenberg/snaptext/issues/new?template=feature_request.md)
* **Support the Developer:** [Buy me a coffee ☕](https://ko-fi.com/cwittenberg)

## License

This project is licensed under the GNU General Public License v3.0 (GPLv3). See the `LICENSE` file for full details.
