# Snap Text Extractor

Select an area of the screen to instantly extract and copy text to the clipboard using native Optical Character Recognition (OCR). Similar to how it works on Apple.

## Features

* **Instant Text Extraction:** Select any part of your screen, and the text within that area is instantly processed and copied to your clipboard.
* **Extraction History:** Access a history of your 15 most recent text extractions from the GNOME Shell top panel menu.
* **Customizable Shortcut:** Set your own keyboard shortcut. The default is `Super + Shift + T`.
* **Visual Notifications:** Get system banner notifications when text is extracted or when you copy a previous extraction from your history.
* **Seamless GNOME Integration:** Built exclusively for GNOME Shell versions 45 through 50 using modern standard APIs.

## System Dependencies

This extension relies on standard native system tools to capture the screen and perform OCR extraction.

Before using the extension, install the required packages for your distribution.

### Ubuntu / Debian / Pop!_OS

```bash
sudo apt update
sudo apt install tesseract-ocr gnome-screenshot
```

### Fedora

```bash
sudo dnf install tesseract gnome-screenshot
```

### Arch Linux / Manjaro

```bash
sudo pacman -S tesseract tesseract-data-eng gnome-screenshot
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

1. Press your configured keyboard shortcut, or click the top panel icon and select the extraction option.
2. Click and drag over the text you want to extract from your screen.
3. The extracted text is automatically copied to your clipboard.
4. Right-click the panel icon to view your recent history and settings.

## Support & Feedback

* **Report a Bug:** [Issue Tracker](https://github.com/cwittenberg/snaptext/issues/new?template=bug_report.md)
* **Request a Feature:** [Feature Requests](https://github.com/cwittenberg/snaptext/issues/new?template=feature_request.md)
* **Support the Developer:** [Buy me a coffee](https://ko-fi.com/cwittenberg)

## License

This project is licensed under the GNU General Public License v3.0 (GPLv3). See the `LICENSE` file for full details.
