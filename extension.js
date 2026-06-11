import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';

const DependencyErrorDialog = GObject.registerClass(
    class DependencyErrorDialog extends ModalDialog.ModalDialog {
        _init(missingApp, installCmd) {
            super._init();
            
            this._timeoutId = null;
            this.connect('destroy', () => {
                if (this._timeoutId) {
                    GLib.source_remove(this._timeoutId);
                    this._timeoutId = null;
                }
            });
            
            this.connect('closed', () => {
                this.destroy();
            });
            
            let mainBox = new St.BoxLayout({
                vertical: true,
                style: 'padding: 24px; spacing: 18px; width: 480px;'
            });
            
            let titleLabel = new St.Label({
                text: `Missing System Dependency: ${missingApp}`,
                style: 'font-size: 14pt; font-weight: bold; color: #ff5555;'
            });
            mainBox.add_child(titleLabel);
            
            let descText = `This extension requires native system tools to perform OCR text extraction. To get the extension working, open your terminal and run the command below to install the base dependencies.\n\nTip: Tesseract will automatically detect and use ANY language packs you have installed on your system! Simply install additional languages (e.g., tesseract-ocr-deu, tesseract-ocr-chi-sim) via your package manager to enable them.`;
            let descLabel = new St.Label({
                text: descText,
            });
            descLabel.clutter_text.line_wrap = true;
            mainBox.add_child(descLabel);
            
            let codeLayout = new St.BoxLayout({
                vertical: false,
                style: 'spacing: 12px; background-color: rgba(255,255,255,0.08); padding: 12px; border-radius: 8px;'
            });
            
            let codeLabel = new St.Label({
                text: installCmd,
                style: 'font-family: monospace; font-weight: bold;',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true
            });
            codeLabel.clutter_text.line_wrap = true;
            
            let copyButton = new St.Button({
                style_class: 'button',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 8px; border-radius: 6px;'
            });
            
            let copyIcon = new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: 16
            });
            copyButton.set_child(copyIcon);
            
            copyButton.connect('clicked', () => {
                let clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, installCmd);
                
                copyIcon.icon_name = 'object-select-symbolic';
                
                if (this._timeoutId) {
                    GLib.source_remove(this._timeoutId);
                    this._timeoutId = null;
                }
                
                this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                    this._timeoutId = null;
                    copyIcon.icon_name = 'edit-copy-symbolic';
                    return GLib.SOURCE_REMOVE;
                });
            });
            
            codeLayout.add_child(codeLabel);
            codeLayout.add_child(copyButton);
            mainBox.add_child(codeLayout);
            
            this.contentLayout.add_child(mainBox);
            
            this.setButtons([{
                label: 'Dismiss',
                action: () => this.close(),
                key: Clutter.KEY_Escape
            }]);
        }
    }
);

export default class SnapTextExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._settingsChangedId = null;
        this._screenshotProcess = null;
        this._tesseractProcess = null;
        this._errorDialog = null;

        let icon = new St.Icon({
            icon_name: 'edit-select-text-symbolic',
            style_class: 'system-status-icon',
        });

        this._indicator.add_child(icon);

        this._indicator.connect('button-press-event', (actor, event) => {
            let button = event.get_button();
            
            if (button === 1) { 
                if (this._indicator.menu.isOpen) {
                    this._indicator.menu.close();
                }
                this._extractText();
                return Clutter.EVENT_STOP; 
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._indicator.connect('button-release-event', (actor, event) => {
            let button = event.get_button();
            
            if (button === 3) { 
                this._buildMenu();
                this._indicator.menu.toggle();
                return Clutter.EVENT_STOP; 
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._buildMenu();
        this._settingsChangedId = this._settings.connect('changed', this._onSettingsChanged.bind(this));

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._bindShortcut();
    }

    _onSettingsChanged(settings, key) {
        if (key === 'shortcut-trigger') {
            this._bindShortcut();
        } else if (key === 'keep-history' || key === 'history-list') {
            this._buildMenu();
        }
    }

    _buildMenu() {
        this._indicator.menu.removeAll();
        let keepHistory = this._settings.get_boolean('keep-history');

        if (keepHistory) {
            let history = this._settings.get_strv('history-list');
            if (history.length > 0) {
                for (let text of history) {
                    let displayLabel = text.replace(/\n/g, ' ').trim();
                    if (displayLabel.length > 40) {
                        displayLabel = displayLabel.substring(0, 37) + '...';
                    }
                    let menuItem = new PopupMenu.PopupMenuItem(displayLabel);
                    menuItem.connect('activate', () => {
                        let clipboard = St.Clipboard.get_default();
                        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
                        if (this._settings.get_boolean('show-notification')) {
                            Main.notify('Text Copied from History', text);
                        }
                    });
                    this._indicator.menu.addMenuItem(menuItem);
                }
            } else {
                this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem('No history yet', { reactive: false }));
            }
            this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        let settingsItem = new PopupMenu.PopupImageMenuItem('Settings', 'preferences-system-symbolic');
        settingsItem.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(settingsItem);
    }

    _bindShortcut() {
        Main.wm.removeKeybinding('shortcut-trigger');
        Main.wm.addKeybinding(
            'shortcut-trigger',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this._extractText.bind(this)
        );
    }

    _showModalError(missingApp) {
        if (this._errorDialog) {
            this._errorDialog.destroy();
            this._errorDialog = null;
        }

        let distroId = GLib.get_os_info('ID');
        let installCmd = '';

        if (distroId === 'fedora') {
            installCmd = `sudo dnf install ${missingApp === 'tesseract' ? 'tesseract' : 'gnome-screenshot'}`;
        } else if (distroId === 'arch') {
            installCmd = `sudo pacman -S ${missingApp === 'tesseract' ? 'tesseract tesseract-data-eng' : 'gnome-screenshot'}`;
        } else {
            installCmd = `sudo apt update && sudo apt install ${missingApp === 'tesseract' ? 'tesseract-ocr tesseract-ocr-eng' : 'gnome-screenshot'}`;
        }

        this._errorDialog = new DependencyErrorDialog(missingApp, installCmd);
        this._errorDialog.connect('destroy', () => {
            this._errorDialog = null;
        });
        this._errorDialog.open();
    }

    _extractText() {
        // Ensure any hung processes from previous extractions are terminated
        if (this._screenshotProcess) {
            this._screenshotProcess.force_exit();
            this._screenshotProcess = null;
        }

        if (this._tesseractProcess) {
            this._tesseractProcess.force_exit();
            this._tesseractProcess = null;
        }

        if (!GLib.find_program_in_path('gnome-screenshot')) {
            this._showModalError('gnome-screenshot');
            return;
        }

        let tempImagePath;
        try {
            // Generate a secure, unique temporary file
            let [file, stream] = Gio.File.new_tmp('snaptext-XXXXXX.png');
            tempImagePath = file.get_path();
            stream.close(null);
        } catch (e) {
            console.error('Snap Text Extension: Failed to create secure temporary file', e);
            return;
        }

        this._screenshotProcess = Gio.Subprocess.new(
            ['gnome-screenshot', '-a', '-f', tempImagePath],
            Gio.SubprocessFlags.NONE
        );

        this._screenshotProcess.wait_async(null, (proc, res) => {
            this._screenshotProcess = null;
            proc.wait_finish(res);

            if (proc.get_successful()) {
                this._runTesseract(tempImagePath);
            } else {
                GLib.unlink(tempImagePath);
            }
        });
    }

    _runTesseract(imagePath) {
        if (!GLib.find_program_in_path('tesseract')) {
            this._showModalError('tesseract');
            GLib.unlink(imagePath);
            return;
        }
        
        let listProc = Gio.Subprocess.new(
            ['tesseract', '--list-langs'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );

        listProc.communicate_utf8_async(null, null, (proc, res) => {
            let combinedLangs = 'eng';
            
            try {
                let [, stdout] = proc.communicate_utf8_finish(res);
                
                if (proc.get_successful() && stdout) {
                    let lines = stdout.split('\n').map(l => l.trim());
                    
                    let startIndex = lines.findIndex(l => l.startsWith('List of'));
                    let validLangs = [];
                    
                    if (startIndex !== -1) {
                        for (let i = startIndex + 1; i < lines.length; i++) {
                            let lang = lines[i];
                            // Exclude specific console messages or invalid characters
                            if (lang && lang !== 'osd' && /^[a-zA-Z0-9_]+$/.test(lang)) {
                                validLangs.push(lang);
                            }
                        }
                    }
                    
                    if (validLangs.length > 0) {
                        combinedLangs = validLangs.join('+');
                    }
                }
            } catch (e) {
                console.error('Snap Text Extension: Failed to parse installed languages', e);
            }

            this._tesseractProcess = Gio.Subprocess.new(
                ['tesseract', imagePath, 'stdout', '-l', combinedLangs],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );

            this._tesseractProcess.communicate_utf8_async(null, null, (tProc, tRes) => {
                this._tesseractProcess = null;
                try {
                    let [, tStdout] = tProc.communicate_utf8_finish(tRes);

                    if (tProc.get_successful()) {
                        let extractedText = tStdout ? tStdout.trim() : "";

                        if (extractedText) {
                            let clipboard = St.Clipboard.get_default();
                            clipboard.set_text(St.ClipboardType.CLIPBOARD, extractedText);

                            if (this._settings.get_boolean('keep-history')) {
                                let history = this._settings.get_strv('history-list');
                                history = history.filter(item => item !== extractedText);
                                history.unshift(extractedText);
                                if (history.length > 15) {
                                    history.length = 15;
                                }
                                this._settings.set_strv('history-list', history);
                            }
                            if (this._settings.get_boolean('show-notification')) {
                                Main.notify('Text Extracted', extractedText);
                            }
                        } else {
                            if (this._settings.get_boolean('show-notification')) {
                                Main.notify('Snap Text', 'No text found in selection.');
                            }
                        }
                    }
                } catch (e) {
                    console.error('Snap Text Extension: Text extraction process failed', e);
                } finally {
                    GLib.unlink(imagePath);
                }
            });
        });
    }

    disable() {
        Main.wm.removeKeybinding('shortcut-trigger');

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._screenshotProcess) {
            this._screenshotProcess.force_exit();
            this._screenshotProcess = null;
        }

        if (this._tesseractProcess) {
            this._tesseractProcess.force_exit();
            this._tesseractProcess = null;
        }

        if (this._errorDialog) {
            this._errorDialog.destroy();
            this._errorDialog = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }
}