// extension.js
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
import { getMissingAppsErrorDialog } from './dependencies.js';

const HISTORY_LIMIT = 15;
const HISTORY_LABEL_LIMIT = 40;

export default class SnapTextExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        
        this._activeProcesses = new Set();
        this._errorDialog = null;
        this._notifSource = null;
        this._cancellable = new Gio.Cancellable();
        this._extractTimeoutId = null;
        this._translateToggle = null;
        this._historySection = null;
        this._soupSession = new Soup.Session();
        
        // Use a standard PanelMenu.Button
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.add_child(new St.Icon({
            gicon: Gio.FileIcon.new(this.dir.get_child('trayicon.svg')),
            style_class: 'system-status-icon',
        }));

        // Intercept events in the CAPTURE phase to preempt GNOME's default behavior
        this._indicator.connectObject('captured-event', (_actor, event) => {
            let type = event.type();
            
            if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.BUTTON_RELEASE) {
                return Clutter.EVENT_PROPAGATE;
            }

            let button = event.get_button();

            if (button === 1 || button === 3) {
                if (type === Clutter.EventType.BUTTON_RELEASE) {
                    if (button === 1) {
                        // Left Click: Close menu if open, trigger extraction
                        if (this._indicator.menu.isOpen) {
                            this._indicator.menu.close();
                        }
                        this._triggerExtraction();
                    } else if (button === 3) {
                        // Right Click: Build and toggle menu
                        this._buildMenu();
                        this._indicator.menu.toggle();
                    }
                }
                
                // Stop propagation on BOTH press and release so PanelMenu.Button never sees it
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }, this);

        this._buildMenu();

        this._settings.connectObject('changed', this._onSettingsChanged.bind(this), this);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._bindShortcut();
    }

    _triggerExtraction() {
        if (this._extractTimeoutId) {
            GLib.source_remove(this._extractTimeoutId);
            this._extractTimeoutId = null;
        }

        // Allow the compositor to completely release the pointer grab before snapping
        this._extractTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._extractTimeoutId = null;
            this._extractTextAsync().catch(error => {
                if (!this._isCancelled()) {
                    this._notifyError(`Text extraction failed: ${error}`);
                }
            });
            return GLib.SOURCE_REMOVE;
        });
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
        
        if (key === 'history-list') {
            // Dynamically update just the history list without destroying the menu
            this._populateHistory();
            return;
        }
        
        if (key === 'keep-history') {
            // Layout fundamentally changes, safe to rebuild but close menu first to prevent glitches
            if (this._indicator && this._indicator.menu.isOpen) {
                this._indicator.menu.close();
            }
            this._buildMenu();
            return;
        }
        
        if (key === 'translate-text') {
            let isTranslating = this._settings.get_boolean('translate-text');
            if (this._translateToggle && this._translateToggle.state !== isTranslating) {
                this._translateToggle.setToggleState(isTranslating);
            }
        }
    }

    _populateHistory() {
        if (!this._historySection || !this._settings) {
            return;
        }

        this._historySection.removeAll();
        let history = this._settings.get_strv('history-list');

        if (history.length === 0) {
            this._historySection.addMenuItem(new PopupMenu.PopupMenuItem(_('No history yet'), {
                reactive: false,
            }));
        } else {
            for (let text of history) {
                this._historySection.addMenuItem(this._historyMenuItem(text));
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
            this._historySection = new PopupMenu.PopupMenuSection();
            this._indicator.menu.addMenuItem(this._historySection);
            this._populateHistory();
            this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        } else {
            this._historySection = null;
        }

        let isTranslating = this._settings.get_boolean('translate-text');
        this._translateToggle = new PopupMenu.PopupSwitchMenuItem(_('Auto-Translate Text'), isTranslating);

        this._translateToggle.connectObject('toggled', (item, state) => {
            this._settings.set_boolean('translate-text', state);
        }, this);
        
        // Override activate to prevent the menu from instantly closing when toggled
        this._translateToggle.activate = function(event) {
            this.toggle();
        };
        
        this._indicator.menu.addMenuItem(this._translateToggle);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Base non-reactive row for the action buttons
        let actionsRow = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        
        let buttonBox = new St.BoxLayout({
            style: 'spacing: 12px; padding: 4px;',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        if (keepHistory) {
            let clearBtn = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    icon_size: 16
                }),
                can_focus: true,
                reactive: true,
                x_expand: true,
            });

            clearBtn.connectObject('clicked', () => {
                this._settings.set_strv('history-list', []);
            }, this);
            
            buttonBox.add_child(clearBtn);
        }

        let settingsBtn = new St.Button({
            style_class: 'button',
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                icon_size: 16
            }),
            can_focus: true,
            reactive: true,
            x_expand: true,
        });

        settingsBtn.connectObject('clicked', () => {
            this._indicator.menu.close();
            this.openPreferences();
        }, this);
        
        buttonBox.add_child(settingsBtn);
        
        actionsRow.add_child(buttonBox);
        this._indicator.menu.addMenuItem(actionsRow);
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
                this._triggerExtraction();
            }
        );
    }

    _showMissingDependencies(dialog) {
        if (this._errorDialog) {
            this._errorDialog.disconnectObject(this);
            this._errorDialog.destroy();
            this._errorDialog = null;
        }

        this._errorDialog = dialog;
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
    }

    _isCancelled(cancellable = this._cancellable) {
        return !cancellable || cancellable.is_cancelled();
    }

    _stopActiveProcesses() {
        for (let process of this._activeProcesses) {
            process.force_exit();
        }
        this._activeProcesses.clear();
    }

    async _waitForProcess(process, cancellable = this._cancellable) {
        return new Promise(resolve => {
            process.wait_async(cancellable, (proc, result) => {
                try {
                    proc.wait_finish(result);
                    resolve(proc.get_successful());
                } catch (error) {
                    if (!this._isCancelled(cancellable)) {
                        this._notifyError(`Process wait failed: ${error}`);
                    }
                    resolve(false);
                }
            });
        });
    }

    async _translateText(text, cancellable = this._cancellable) {
        if (!this._settings.get_boolean('translate-text') || !text || !this._soupSession) {
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
            let message = Soup.Message.new('GET', url);
            
            let bytes = await new Promise((resolve, reject) => {
                this._soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
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
            if (!this._isCancelled(cancellable)) {
                this._logDebug(`Translation failed: ${error}`, true);
                this._showNotification(_('Translation Error'), _('Could not connect to Google Translate.'));
            }
        }

        return text;
    }

    async _extractTextAsync() {
        this._logDebug('Starting extraction flow...');
        
        // Abort any previously running extraction flow
        if (this._cancellable) {
            this._cancellable.cancel();
        }
        
        // Create a new cancellation token for this specific execution
        let currentCancellable = new Gio.Cancellable();
        this._cancellable = currentCancellable;

        this._stopActiveProcesses();

        let errorDialog = getMissingAppsErrorDialog();
        if (errorDialog) {
            this._logDebug(`Missing dependencies found.`);
            this._showMissingDependencies(errorDialog);
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
            if (!this._isCancelled(currentCancellable)) {
                this._notifyError(`Could not create temporary screenshot file: ${error}`);
            }
            return;
        }

        try {
            this._logDebug('Spawning gnome-screenshot...');
            let screenshot = Gio.Subprocess.new(
                ['gnome-screenshot', '-a', '-f', imagePath],
                Gio.SubprocessFlags.NONE
            );
            
            this._activeProcesses.add(screenshot);
            let gotScreenshot = await this._waitForProcess(screenshot, currentCancellable);
            this._activeProcesses.delete(screenshot);
            
            this._logDebug(`gnome-screenshot completed. Success: ${gotScreenshot}`);

            if (gotScreenshot && !this._isCancelled(currentCancellable)) {
                const ocrProcessor = new OcrProcessor(currentCancellable, this._activeProcesses, (msg) => this._notifyError(msg), this._logDebug.bind(this));
                let result = await ocrProcessor.processImage(imagePath);
                
                if (!this._isCancelled(currentCancellable) && result !== null && result.text) {
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
                        text = await this._translateText(text, currentCancellable);
                    }

                    // Final check to prevent overlapping executions from pasting
                    if (!this._isCancelled(currentCancellable)) {
                        this._handleExtractedText(text);
                    }
                } else {
                    this._logDebug('OCR process returned null or empty text.');
                }
            } else if (!this._isCancelled(currentCancellable)) {
                this._logDebug('gnome-screenshot exited without taking a screenshot. It was either cancelled or failed to grab the display.', true);
            }
        } catch (error) {
            if (!this._isCancelled(currentCancellable)) {
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
                if (GLib.unlink(imagePath) !== 0) {
                    this._logDebug(`Could not remove temporary screenshot file`, true);
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
        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }

        if (this._extractTimeoutId) {
            GLib.source_remove(this._extractTimeoutId);
            this._extractTimeoutId = null;
        }
        
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

        if (this._historySection) {
            this._historySection.destroy();
            this._historySection = null;
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