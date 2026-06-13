import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

//fancy button helper to open link
function createLinkButton(title, uri, styleClass = null) {
    const label = new Gtk.Label({
        label: title,
        wrap: true,
        justify: Gtk.Justification.CENTER
    });
    
    const button = new Gtk.Button({
        child: label,
        valign: Gtk.Align.CENTER,
        hexpand: true
    });
    
    if (styleClass) {
        button.add_css_class(styleClass);
    }
    
    button.connect('clicked', () => {
        Gio.app_info_launch_default_for_uri(uri, null);
    });
    
    return button;
}

export default class SnapTextPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Snap Text Configuration'),
            icon_name: 'preferences-system-symbolic'
        });
        
        const groupHeader = new Adw.PreferencesGroup();
        const descLabel = new Gtk.Label({
            label: _('Instantly extract and copy text to your clipboard from anywhere on the screen.'),
            justify: Gtk.Justification.CENTER,
            wrap: true,
            margin_top: 5,
            margin_bottom: 5,
            css_classes: ['dim-label']
        });
        groupHeader.add(descLabel);
        page.add(groupHeader);
        
        const groupSettings = new Adw.PreferencesGroup({
            title: _('Behavior & Shortcuts')
        });
        
        const notificationRow = new Adw.ActionRow({
            title: _('Show Extracted Text Notification'),
            subtitle: _('Displays a system banner containing your copied text context.'),
            title_lines: 0,
            subtitle_lines: 0
        });
        const toggleNotification = new Gtk.Switch({
            active: settings.get_boolean('show-notification'),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('show-notification', toggleNotification, 'active', Gio.SettingsBindFlags.DEFAULT);
        notificationRow.add_suffix(toggleNotification);
        notificationRow.activatable_widget = toggleNotification;
        groupSettings.add(notificationRow);
        
        const historyRow = new Adw.ActionRow({
            title: _('Enable Extraction History'),
            subtitle: _('Keep a history of up to 15 recent extractions in the context menu.'),
            title_lines: 0,
            subtitle_lines: 0
        });
        const toggleHistory = new Gtk.Switch({
            active: settings.get_boolean('keep-history'),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('keep-history', toggleHistory, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyRow.add_suffix(toggleHistory);
        historyRow.activatable_widget = toggleHistory;
        groupSettings.add(historyRow);
        
        const enableShortcutRow = new Adw.ActionRow({
            title: _('Enable Keyboard Shortcut'),
            subtitle: _('Allow triggering extraction via a keyboard shortcut.'),
            title_lines: 0,
            subtitle_lines: 0
        });
        const toggleShortcut = new Gtk.Switch({
            active: settings.get_boolean('enable-shortcut'),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('enable-shortcut', toggleShortcut, 'active', Gio.SettingsBindFlags.DEFAULT);
        enableShortcutRow.add_suffix(toggleShortcut);
        enableShortcutRow.activatable_widget = toggleShortcut;
        groupSettings.add(enableShortcutRow);

        const shortcutRow = new Adw.ActionRow({
            title: _('Keyboard Shortcut Trigger'),
            subtitle: _('Click to set shortcut. Press Esc to cancel, Backspace to disable.'),
            title_lines: 0,
            subtitle_lines: 0
        });
        
        settings.bind('enable-shortcut', shortcutRow, 'sensitive', Gio.SettingsBindFlags.GET);
        
        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            accelerator: settings.get_strv('shortcut-trigger')[0] || '',
            valign: Gtk.Align.CENTER
        });
        
        // according to GNOME guidelines: default hotkey is not allowed on extension enablement. I set it only when the switch is enabled.
        toggleShortcut.connect('notify::active', () => {
            if (toggleShortcut.active) {
                let current = settings.get_strv('shortcut-trigger');
                if (!current || current.length === 0 || current[0] === '') {
                    settings.set_strv('shortcut-trigger', ['<Super><Shift>t']);
                    shortcutLabel.set_accelerator('<Super><Shift>t');
                }
            }
        });

        const shortcutButton = new Gtk.Button({
            child: shortcutLabel,
            valign: Gtk.Align.CENTER
        });
        
        let isRecording = false;
        shortcutButton.connect('clicked', () => {
            if (isRecording) {
                isRecording = false;
                shortcutButton.remove_css_class('suggested-action');
                shortcutLabel.set_accelerator(settings.get_strv('shortcut-trigger')[0] || '');
            } else {
                isRecording = true;
                shortcutButton.add_css_class('suggested-action');
                shortcutLabel.set_accelerator('');
                shortcutLabel.set_disabled_text(_('Press keys...'));
            }
        });
        
        const keyController = new Gtk.EventControllerKey();
        keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        window.add_controller(keyController);
        
        keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            if (!isRecording) return false;
            
            if (keyval === Gdk.KEY_Escape) {
                isRecording = false;
                shortcutButton.remove_css_class('suggested-action');
                shortcutLabel.set_accelerator(settings.get_strv('shortcut-trigger')[0] || '');
                return true;
            }
            
            if (keyval === Gdk.KEY_BackSpace) {
                isRecording = false;
                settings.set_strv('shortcut-trigger', ['']);
                shortcutButton.remove_css_class('suggested-action');
                shortcutLabel.set_accelerator('');
                shortcutLabel.set_disabled_text(_('Disabled'));
                return true;
            }
            
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            if (Gtk.accelerator_valid(keyval, mask)) {
                let accelName = Gtk.accelerator_name(keyval, mask);
                settings.set_strv('shortcut-trigger', [accelName]);
                isRecording = false;
                shortcutButton.remove_css_class('suggested-action');
                shortcutLabel.set_accelerator(accelName);
                return true;
            }
            
            return true;
        });

        shortcutRow.add_suffix(shortcutButton);
        shortcutRow.activatable_widget = shortcutButton;
        groupSettings.add(shortcutRow);

        page.add(groupSettings);
        
        // Group Links (Buttons) moved above Developer Details
        const groupLinks = new Adw.PreferencesGroup();
        
        const linkBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            homogeneous: true,
            halign: Gtk.Align.CENTER,
            margin_top: 16,
            margin_bottom: 16
        });
        
        // GitHub repo links :
        linkBox.append(createLinkButton(_('Buy me a coffee ☕'), 'https://ko-fi.com/cwittenberg', 'suggested-action'));
        linkBox.append(createLinkButton(_('Report a Bug 🐛'), 'https://github.com/cwittenberg/snaptext/issues/new?template=bug_report.md'));
        linkBox.append(createLinkButton(_('Request a Feature 💡'), 'https://github.com/cwittenberg/snaptext/issues/new?template=feature_request.md'));
        
        groupLinks.add(linkBox);
        page.add(groupLinks);
   
        const groupAbout = new Adw.PreferencesGroup({
            title: _('Developer Details')
        });
        groupAbout.add(new Adw.ActionRow({ title: _('Author'), subtitle: 'Christian Wittenberg', title_lines: 0, subtitle_lines: 0 }));
        groupAbout.add(new Adw.ActionRow({ title: _('Version'), subtitle: '1.0.0 (Production Release)', title_lines: 0, subtitle_lines: 0 }));
        page.add(groupAbout);
        
        window.add(page);
    }
}