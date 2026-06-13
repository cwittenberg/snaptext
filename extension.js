import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';

const HISTORY_LIMIT = 15; //todo: add option in a later version with a slider to configure this.
const HISTORY_LABEL_LIMIT = 40;
const COPY_ICON_RESET_MS = 2000;

function notifyError(msg) {
    console.error(`[SnapText] ${msg}`);
    Main.notify(_('Snap Text Error'), msg);
}

function isProbablyCancelled(error) {
    let message = String(error).toLowerCase();
    return message.includes('cancelled') || message.includes('canceled');
}

//used to show to the user how to install the Tesseract deps, if unavailable. 
function installCommandFor(appName) {
    const distroId = (GLib.get_os_info('ID') || '').toLowerCase();
    const distroLike = (GLib.get_os_info('ID_LIKE') || '').toLowerCase().split(/\s+/);

    const isFedoraLike = distroId === 'fedora' || distroLike.includes('fedora');
    const isArchLike = distroId === 'arch' || distroLike.includes('arch');
    const isDebianLike =
        distroId === 'debian' ||
        distroId === 'ubuntu' ||
        distroId === 'pop' ||
        distroLike.includes('debian') ||
        distroLike.includes('ubuntu');

    if (appName === 'tesseract') {
        if (isFedoraLike) {
            return 'sudo dnf install tesseract tesseract-langpack-eng';
        }

        if (isArchLike) {
            return 'sudo pacman -S tesseract tesseract-data-eng';
        }

        if (isDebianLike) {
            return 'sudo apt update && sudo apt install tesseract-ocr tesseract-ocr-eng';
        }

        return '# Install Tesseract OCR and the English language data using your distribution package manager.';
    }

    if (isFedoraLike) {
        return 'sudo dnf install gnome-screenshot';
    }

    if (isArchLike) {
        return 'sudo pacman -S gnome-screenshot';
    }

    if (isDebianLike) {
        return 'sudo apt update && sudo apt install gnome-screenshot';
    }

    return '# Install gnome-screenshot using your distribution package manager.';
}

const DependencyErrorDialog = GObject.registerClass( //fancy dialog to show how to install tesseract.
    class DependencyErrorDialog extends ModalDialog.ModalDialog {
        _init(appName, installCmd) {
            super._init();

            this._copyIconTimeoutId = 0;
            this.connectObject('closed', () => this.destroy(), this);

            let box = new St.BoxLayout({
                vertical: true,
                style: 'padding: 24px; spacing: 18px; width: 480px;',
            });

            let title = new St.Label({
                text: _('Missing dependency: %s').replace('%s', appName),
                style: 'font-size: 14pt; font-weight: bold; color: #ff5555;',
            });
            box.add_child(title);

            let description = new St.Label({
                text: appName === 'tesseract'
                    ? _('Install Tesseract and at least one language package.')
                    : _('Install gnome-screenshot and try again.'),
            });
            description.clutter_text.line_wrap = true;
            box.add_child(description);

            let commandBox = new St.BoxLayout({
                vertical: false,
                style: 'spacing: 12px; background-color: rgba(255,255,255,0.08); padding: 12px; border-radius: 8px;',
            });

            let commandLabel = new St.Label({
                text: installCmd,
                style: 'font-family: monospace; font-weight: bold;',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            commandLabel.clutter_text.line_wrap = true;
            commandBox.add_child(commandLabel);

            let copyButton = new St.Button({
                style_class: 'button',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 8px; border-radius: 6px;',
            });

            let copyIcon = new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: 16,
            });
            copyButton.set_child(copyIcon);

            copyButton.connectObject('clicked', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, installCmd);
                copyIcon.icon_name = 'object-select-symbolic';

                this._clearCopyIconTimeout();
                this._copyIconTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPY_ICON_RESET_MS, () => {
                    this._copyIconTimeoutId = 0;
                    copyIcon.icon_name = 'edit-copy-symbolic';
                    return GLib.SOURCE_REMOVE;
                });
            }, this);

            commandBox.add_child(copyButton);
            box.add_child(commandBox);
            this.contentLayout.add_child(box);

            this.setButtons([{
                label: _('Dismiss'),
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            }]);
        }

        _clearCopyIconTimeout() {
            if (!this._copyIconTimeoutId) {
                return;
            }

            GLib.source_remove(this._copyIconTimeoutId);
            this._copyIconTimeoutId = 0;
        }

        destroy() {
            this._clearCopyIconTimeout();
            this.disconnectObject(this);
            super.destroy();
        }
    }
);

export default class SnapTextExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        
        this._activeProcesses = new Set();
        this._errorDialog = null;
        this._notifSource = null;
        this._cancellable = new Gio.Cancellable();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.add_child(new St.Icon({
            gicon: Gio.FileIcon.new(this.dir.get_child('trayicon.svg')),
            style_class: 'system-status-icon',
        }));

        this._indicator.connectObject(
            'button-press-event', (_actor, event) => {
                if (event.get_button() !== 1) {
                    return Clutter.EVENT_PROPAGATE;
                }

                if (this._indicator.menu.isOpen) {
                    this._indicator.menu.close();
                }

                this._extractTextAsync().catch(error => {
                    if (!this._isCancelled()) {
                        notifyError(`Text extraction failed: ${error}`);
                    }
                });

                return Clutter.EVENT_STOP;
            },
            'button-release-event', (_actor, event) => {
                if (event.get_button() !== 3) {
                    return Clutter.EVENT_PROPAGATE;
                }

                this._buildMenu();
                this._indicator.menu.toggle();
                return Clutter.EVENT_STOP;
            },
            this
        );

        this._buildMenu();
        this._settings.connectObject('changed', this._onSettingsChanged.bind(this), this);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._bindShortcut();
    }

    _onSettingsChanged(_settings, key) {
        if (key === 'shortcut-trigger') {
            this._bindShortcut();
            return;
        }

        if (key === 'keep-history' || key === 'history-list') {
            this._buildMenu();
        }
    }

    _buildMenu() {
        if (!this._indicator || !this._settings) {
            return;
        }

        this._indicator.menu.removeAll();

        if (this._settings.get_boolean('keep-history')) {
            let history = this._settings.get_strv('history-list');

            if (history.length === 0) {
                this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('No history yet'), {
                    reactive: false,
                }));
            } else {
                for (let text of history) {
                    this._indicator.menu.addMenuItem(this._historyMenuItem(text));
                }
            }

            this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        let settingsItem = new PopupMenu.PopupImageMenuItem(_('Settings'), 'preferences-system-symbolic');
        settingsItem.connectObject('activate', () => this.openPreferences(), this);
        this._indicator.menu.addMenuItem(settingsItem);
    }

    _historyMenuItem(text) {
        let label = text.replace(/\s+/g, ' ').trim();
        if (label.length > HISTORY_LABEL_LIMIT) {
            label = `${label.substring(0, HISTORY_LABEL_LIMIT - 3)}...`;
        }

        let item = new PopupMenu.PopupMenuItem(label);
        item.connectObject('activate', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);

            if (this._settings?.get_boolean('show-notification')) {
                this._showNotification(_('Text copied'), text);
            }
        }, this);

        return item;
    }

    _bindShortcut() {   //besides the icon, super easy to  use a hotkey also.
        Main.wm.removeKeybinding('shortcut-trigger');   
        Main.wm.addKeybinding(
            'shortcut-trigger',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._extractTextAsync().catch(error => {
                    if (!this._isCancelled()) {
                        notifyError(`Text extraction failed: ${error}`);
                    }
                });
            }
        );
    }

    // User may not know how to installs the deps, added a dialog explaining how to install (more userfriendly that way). 
    _showMissingDependency(appName) {
        if (this._errorDialog) {
            this._errorDialog.disconnectObject(this);
            this._errorDialog.destroy();
            this._errorDialog = null;
        }

        this._errorDialog = new DependencyErrorDialog(appName, installCommandFor(appName));
        this._errorDialog.connectObject('destroy', () => {
            this._errorDialog = null;
        }, this);
        this._errorDialog.open();
    }

    //load the icon
    _notificationIcon() {
        return Gio.FileIcon.new(this.dir.get_child('trayicon.svg'));
    }

    _getNotificationSource() {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'SnapText',
                icon: this._notificationIcon(),
            });
            this._notifSource.connectObject('destroy', () => {
                this._notifSource = null;
            }, this);
            Main.messageTray.add(this._notifSource);
        }

        return this._notifSource;
    }

    _showNotification(title, body) {
        try {
            let titleText = String(title ?? '').trim();
            let bodyText = String(body ?? '').trim();

            if (!titleText && !bodyText) {
                return;
            }

            let source = this._getNotificationSource();
            let notification = new MessageTray.Notification({
                source,
                title: titleText,
                body: bodyText,
                urgency: MessageTray.Urgency.NORMAL,
            });

            source.addNotification(notification);
        } catch (error) {
            console.error(`[SnapText] Notification failed: ${error}`);

            try {
                Main.notify(String(title ?? '').trim(), String(body ?? '').trim());
            } catch (fallbackError) {
                console.error(`[SnapText] Fallback notification failed: ${fallbackError}`);
            }
        }
    }

    _isCancelled() {
        return !this._cancellable || this._cancellable.is_cancelled();
    }

    _stopActiveProcesses() {
        for (let process of this._activeProcesses) {
            try {
                process.force_exit();
            } catch (error) {
                if (!isProbablyCancelled(error)) {
                    notifyError(`Could not stop process: ${error}`);
                }
            }
        }

        this._activeProcesses.clear();
    }

    async _waitForProcess(process) {
        return new Promise(resolve => {
            process.wait_async(this._cancellable, (proc, result) => {
                try {
                    proc.wait_finish(result);
                    resolve(proc.get_successful());
                } catch (error) {
                    if (!this._isCancelled() && !isProbablyCancelled(error)) {
                        notifyError(`Process wait failed: ${error}`);
                    }
                    resolve(false);
                }
            });
        });
    }

    async _readProcess(process) {
        return new Promise(resolve => {
            process.communicate_utf8_async(null, this._cancellable, (proc, result) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(result);
                    resolve({ ok: proc.get_successful(), stdout });
                } catch (error) {
                    if (!this._isCancelled() && !isProbablyCancelled(error)) {
                        notifyError(`Process output read failed: ${error}`);
                    }
                    resolve({ ok: false, stdout: '' });
                }
            });
        });
    }

    //utilizes gnome-screenshot to grab the selected area. Saved to a tmp file and then used for OCR with tesseract.
    //simple but super effective.
    async _extractTextAsync() {
        this._stopActiveProcesses();

        if (!GLib.find_program_in_path('gnome-screenshot')) {
            this._showMissingDependency('gnome-screenshot');
            return;
        }

        let imagePath = null;
        let stream = null;

        try {
            let file;
            [file, stream] = Gio.File.new_tmp('snaptext-XXXXXX.png');
            imagePath = file.get_path();
            stream.close(null);
            stream = null;
        } catch (error) {
            notifyError(`Could not create temporary screenshot file: ${error}`);
            return;
        }

        try {
            let screenshot = Gio.Subprocess.new(
                ['gnome-screenshot', '-a', '-f', imagePath],
                Gio.SubprocessFlags.NONE
            );

            this._activeProcesses.add(screenshot);
            let gotScreenshot = await this._waitForProcess(screenshot);
            this._activeProcesses.delete(screenshot);

            if (gotScreenshot && !this._isCancelled()) {
                await this._runTesseractAsync(imagePath);
            }
        } catch (error) {
            if (!this._isCancelled()) {
                notifyError(`Text extraction failed: ${error}`);
            }
        } finally {
            if (stream) {
                try {
                    stream.close(null);
                } catch (error) {
                    notifyError(`Could not close temporary screenshot file: ${error}`);
                }
            }

            if (imagePath && GLib.file_test(imagePath, GLib.FileTest.EXISTS)) {
                try {
                    GLib.unlink(imagePath);
                } catch (error) {
                    notifyError(`Could not remove temporary screenshot file: ${error}`);
                }
            }
        }
    }

    async _runTesseractAsync(imagePath) {
        if (!GLib.find_program_in_path('tesseract')) {
            this._showMissingDependency('tesseract');
            return;
        }

        let languages = await this._availableTesseractLanguages();
        if (this._isCancelled()) {
            return;
        }

        let ocr = Gio.Subprocess.new(
            ['tesseract', imagePath, 'stdout', '-l', languages],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );

        this._activeProcesses.add(ocr);
        let result = await this._readProcess(ocr);
        this._activeProcesses.delete(ocr);

        if (!result.ok || this._isCancelled()) {
            return;
        }

        this._handleExtractedText(result.stdout?.trim() ?? '');
    }


    //Simply query all available languages - for maximum hit rate/accuracy
    //Alternative would be to let user configure in settings - but I think this is cleaner.
    //Tesserat unfortunately does not have a simple way to get it out - so thats why output parsing of subprocess call is needed.
    async _availableTesseractLanguages() {
        let fallback = 'eng';

        try {
            let listLangs = Gio.Subprocess.new(
                ['tesseract', '--list-langs'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );

            this._activeProcesses.add(listLangs);
            let result = await this._readProcess(listLangs);
            this._activeProcesses.delete(listLangs);

            if (!result.ok || !result.stdout) {
                return fallback;
            }

            let langs = [];
            let lines = result.stdout.split('\n').map(line => line.trim());
            let headerIndex = lines.findIndex(line => line.startsWith('List of'));

            for (let i = headerIndex + 1; i > 0 && i < lines.length; i++) {
                let lang = lines[i];
                if (lang && lang !== 'osd' && /^[a-zA-Z0-9_]+$/.test(lang)) {
                    langs.push(lang);
                }
            }

            return langs.length > 0 ? langs.join('+') : fallback;
        } catch (error) {
            if (!this._isCancelled()) {
                notifyError(`Could not read Tesseract languages: ${error}`);
            }
            return fallback;
        }
    }

    // Take the extracted text and now stamp it on the clipboard. 
    // Added history tracking for easy access, just like clipboard history :) 
    _handleExtractedText(text) {
        if (!text) {
            if (this._settings?.get_boolean('show-notification')) {
                this._showNotification(_('Snap Text'), _('No text found.'));
            }
            return;
        }

        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);

        if (this._settings?.get_boolean('keep-history')) {
            let history = this._settings.get_strv('history-list');
            history = history.filter(item => item !== text);
            history.unshift(text);
            history.length = Math.min(history.length, HISTORY_LIMIT);
            this._settings.set_strv('history-list', history);
        }

        if (this._settings?.get_boolean('show-notification')) {
            this._showNotification(_('Text extracted'), text);
        }
    }

    disable() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        Main.wm.removeKeybinding('shortcut-trigger');

        if (this._settings) {
            this._settings.disconnectObject(this);
        }

        this._stopActiveProcesses();

        if (this._errorDialog) {
            this._errorDialog.disconnectObject(this);
            this._errorDialog.destroy();
            this._errorDialog = null;
        }

        if (this._indicator) {
            this._indicator.disconnectObject(this);
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._notifSource) {
            this._notifSource.disconnectObject(this);
            this._notifSource.destroy();
            this._notifSource = null;
        }

        this._settings = null;
    }
}