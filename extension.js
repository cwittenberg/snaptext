import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import { OcrProcessor } from './ocr.js';
import { checkDependencies, getCombinedInstallCommand, DependencyErrorDialog } from './dependencies.js';

const HISTORY_LIMIT = 15;
const HISTORY_LABEL_LIMIT = 40;

export default class SnapTextExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        
        this._activeProcesses = new Set();
        this._errorDialog = null;
        this._notifSource = null;
        this._cancellable = new Gio.Cancellable();
        
        this._translateToggle = null;

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
                        this._notifyError(`Text extraction failed: ${error}`);
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

    _logDebug(msg, isError = false) {
        if (this._settings && this._settings.get_boolean('enable-debug')) {
            if (isError) {
                console.error(`[SnapText Debug] ${msg}`);
            } else {
                console.log(`[SnapText Debug] ${msg}`);
            }
        }
    }

    _notifyError(msg) {
        this._logDebug(`Error: ${msg}`, true);
        Main.notify(_('Snap Text Error'), msg);
    }

    _onSettingsChanged(_settings, key) {
        if (key === 'shortcut-trigger') {
            this._bindShortcut();
            return;
        }

        if (key === 'keep-history' || key === 'history-list') {
            if (this._indicator && this._indicator.menu.isOpen) {
                this._buildMenu();
            }
            return;
        }

        if (key === 'translate-text') {
            if (this._translateToggle) {
                this._translateToggle.setToggleState(this._settings.get_boolean('translate-text'));
            }
        }
    }

    _buildMenu() {
        if (!this._indicator || !this._settings) {
            return;
        }

        this._indicator.menu.removeAll();

        let keepHistory = this._settings.get_boolean('keep-history');

        if (keepHistory) {
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

        let isTranslating = this._settings.get_boolean('translate-text');
        this._translateToggle = new PopupMenu.PopupSwitchMenuItem(_('Auto-Translate Text'), isTranslating);
        this._translateToggle.connectObject('toggled', (item, state) => {
            this._settings.set_boolean('translate-text', state);
        }, this);
        this._indicator.menu.addMenuItem(this._translateToggle);

        if (keepHistory) {
            let clearItem = new PopupMenu.PopupImageMenuItem(_('Clear History'), 'user-trash-symbolic');
            clearItem.connectObject('activate', () => {
                this._settings.set_strv('history-list', []);
            }, this);
            this._indicator.menu.addMenuItem(clearItem);
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

    _bindShortcut() {
        Main.wm.removeKeybinding('shortcut-trigger');
        
        Main.wm.addKeybinding(
            'shortcut-trigger',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                this._logDebug('Shortcut triggered.');
                this._extractTextAsync().catch(error => {
                    if (!this._isCancelled()) {
                        this._notifyError(`Text extraction failed: ${error}`);
                    }
                });
            }
        );
    }

    _showMissingDependencies(missingApps) {
        if (this._errorDialog) {
            this._errorDialog.disconnectObject(this);
            this._errorDialog.destroy();
            this._errorDialog = null;
        }

        const installCmd = getCombinedInstallCommand(missingApps);
        this._errorDialog = new DependencyErrorDialog(missingApps, installCmd);
        this._errorDialog.connectObject('destroy', () => {
            this._errorDialog = null;
        }, this);

        this._errorDialog.open();
    }

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
            this._logDebug(`Notification failed: ${error}`, true);
            try {
                Main.notify(String(title ?? '').trim(), String(body ?? '').trim());
            } catch (fallbackError) {
                this._logDebug(`Fallback notification failed: ${fallbackError}`, true);
            }
        }
    }

    _isCancelled() {
        return !this._cancellable || this._cancellable.is_cancelled();
    }

    _stopActiveProcesses() {
        for (let process of this._activeProcesses) {
            process.force_exit();
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
                    if (!this._isCancelled()) {
                        this._notifyError(`Process wait failed: ${error}`);
                    }
                    resolve(false);
                }
            });
        });
    }

    async _translateText(text) {
        if (!this._settings.get_boolean('translate-text') || !text) {
            return text;
        }

        let targetLang = this._settings.get_string('translate-target').trim();

        if (!targetLang) {
            let sysLangs = GLib.get_language_names();
            let locale = sysLangs[0] || 'en';
            targetLang = locale.split('.')[0].split('_')[0];
        }

        this._logDebug(`Translating text to: ${targetLang}`);

        let url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;

        try {
            let session = new Soup.Session();
            let message = Soup.Message.new('GET', url);
            
            let bytes = await new Promise((resolve, reject) => {
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (sess, res) => {
                    try {
                        resolve(sess.send_and_read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            if (message.get_status() === Soup.Status.OK) {
                let decoder = new TextDecoder('utf-8');
                let responseText = decoder.decode(bytes.get_data());
                let json = JSON.parse(responseText);
                
                let translated = "";
                for (let block of json[0]) {
                    if (block[0]) {
                        translated += block[0];
                    }
                }
                return translated;
            }
        } catch (error) {
            if (!this._isCancelled()) {
                this._logDebug(`Translation failed: ${error}`, true);
                this._showNotification(_('Translation Error'), _('Could not connect to Google Translate.'));
            }
        }

        return text;
    }

    async _extractTextAsync() {
        this._logDebug('Starting extraction flow...');

        this._stopActiveProcesses();

        let missingDeps = checkDependencies();
        if (missingDeps.length > 0) {
            this._logDebug(`Missing dependencies found: ${missingDeps.join(', ')}`);
            this._showMissingDependencies(missingDeps);
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
            this._logDebug(`Temporary image path created: ${imagePath}`);
        } catch (error) {
            this._notifyError(`Could not create temporary screenshot file: ${error}`);
            return;
        }

        try {
            this._logDebug('Spawning gnome-screenshot...');
            let screenshot = Gio.Subprocess.new(
                ['gnome-screenshot', '-a', '-f', imagePath],
                Gio.SubprocessFlags.NONE
            );

            this._activeProcesses.add(screenshot);
            let gotScreenshot = await this._waitForProcess(screenshot);
            this._activeProcesses.delete(screenshot);

            this._logDebug(`gnome-screenshot completed. Success: ${gotScreenshot}`);

            if (gotScreenshot && !this._isCancelled()) {
                const ocrProcessor = new OcrProcessor(this._cancellable, this._activeProcesses, (msg) => this._notifyError(msg), this._logDebug.bind(this));
                let result = await ocrProcessor.processImage(imagePath);
                
                if (!this._isCancelled() && result !== null && result.text) {
                    let text = result.text;
                    this._logDebug(`Final OCR text length: ${text.length}`);
                    
                    if (result.isQr && /^https?:\/\/[^\s]+$/i.test(text.trim())) {
                        if (this._settings.get_boolean('qr-auto-open')) {
                            try {
                                Gio.AppInfo.launch_default_for_uri(text.trim(), null);
                            } catch (e) {
                                this._logDebug(`Could not launch URI: ${e}`, true);
                            }
                        }
                    } else if (text.trim().length > 0 && this._settings.get_boolean('translate-text')) {
                        text = await this._translateText(text);
                    }

                    this._handleExtractedText(text);
                } else {
                    this._logDebug('OCR process returned null or empty text.');
                }
            } else if (!this._isCancelled()) {
                this._logDebug('gnome-screenshot exited without taking a screenshot. It was either cancelled or failed to grab the display.', true);
            }

        } catch (error) {
            if (!this._isCancelled()) {
                this._notifyError(`Text extraction failed: ${error}`);
            }
        } finally {
            if (stream) {
                try {
                    stream.close(null);
                } catch (error) {
                    this._logDebug(`Could not close temporary screenshot file: ${error}`, true);
                }
            }
            if (imagePath && GLib.file_test(imagePath, GLib.FileTest.EXISTS)) {
                try {
                    GLib.unlink(imagePath);
                } catch (error) {
                    this._logDebug(`Could not remove temporary screenshot file: ${error}`, true);
                }
            }
        }
    }

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

        if (this._translateToggle) {
            this._translateToggle.destroy();
            this._translateToggle = null;
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