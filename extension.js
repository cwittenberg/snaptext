import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
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

        // Ensure we properly clean up the timeout so we don't need a try/catch mask
        this.connect('destroy', () => {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = null;
            }
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
        
        let descText = `This extension requires native system tools to perform OCR text extraction. To get the extension working, please open your terminal application, copy and run the following command to install the required dependencies:\n`;
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
});

export default class LiveTextExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.livetext');
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._settingsChangedId = null;
        this._screenshotProcess = null;
        this._tesseractProcess = null;
        
        let icon = new St.Icon({
            icon_name: 'edit-select-text-symbolic',
            style_class: 'system-status-icon',
        });
        
        this._indicator.add_child(icon);
        this._indicator.connect('button-press-event', this._extractText.bind(this));
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        
        this._bindShortcut();
        
        // Retain the connection ID so it can be un-bound cleanly
        this._settingsChangedId = this._settings.connect('changed::shortcut-trigger', this._bindShortcut.bind(this));
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

    _getDistroInstruction(missingApp) {
        let distroId = GLib.get_os_info('ID');
        if (distroId === 'fedora') {
            return `sudo dnf install ${missingApp === 'tesseract' ? 'tesseract' : 'gnome-screenshot'}`;
        } else if (distroId === 'arch') {
            return `sudo pacman -S ${missingApp === 'tesseract' ? 'tesseract tesseract-data-eng' : 'gnome-screenshot'}`;
        }
        return `sudo apt update && sudo apt install ${missingApp === 'tesseract' ? 'tesseract-ocr' : 'gnome-screenshot'}`;
    }

    _showModalError(missingApp) {
        let command = this._getDistroInstruction(missingApp);
        let dialog = new DependencyErrorDialog(missingApp, command);
        dialog.open();
    }

    _extractText() {
        let tempImagePath = GLib.build_filenamev([GLib.get_tmp_dir(), 'live_text_capture.png']);
        
        try {
            let subprocess = new Gio.Subprocess({
                argv: ['gnome-screenshot', '-a', '-f', tempImagePath],
                flags: Gio.SubprocessFlags.NONE
            });
            
            this._screenshotProcess = subprocess;
            subprocess.init(null);
            
            subprocess.wait_async(null, (proc, res) => {
                try {
                    proc.wait_finish(res);
                    if (proc.get_successful()) {
                        this._runTesseract(tempImagePath);
                    }
                } catch (e) {
                    console.error('Live Text Extension: Screenshot process failed', e);
                } finally {
                    this._screenshotProcess = null;
                }
            });
        } catch (e) {
            console.error('Live Text Extension: Failed to launch screenshot tool', e);
            this._showModalError('gnome-screenshot');
        }
    }

    _runTesseract(imagePath) {
        try {
            let subprocess = new Gio.Subprocess({
                argv: ['tesseract', imagePath, 'stdout'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            });
            
            this._tesseractProcess = subprocess;
            subprocess.init(null);
            
            subprocess.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [ok, stdout, ] = proc.communicate_utf8_finish(res);
                    if (ok && stdout) {
                        let extractedText = stdout.trim();
                        
                        if (extractedText !== "") {
                            let clipboard = St.Clipboard.get_default();
                            clipboard.set_text(St.ClipboardType.CLIPBOARD, extractedText);
                            
                            if (this._settings.get_boolean('show-notification')) {
                                Main.notify('Text Extracted', extractedText);
                            }
                        } else {
                            if (this._settings.get_boolean('show-notification')) {
                                Main.notify('Live Text', 'No text found in selection.');
                            }
                        }
                    }
                } catch (e) {
                    console.error('Live Text Extension: Failed to read tesseract output', e);
                } finally {
                    this._tesseractProcess = null;
                }
            });
        } catch (e) {
            console.error('Live Text Extension: Failed to run tesseract', e);
            this._showModalError('tesseract');
        }
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

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        
        this._settings = null;
    }
}