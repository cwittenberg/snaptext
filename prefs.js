import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function createLinkButton(title, uri, styleClass = null) {
    const button = new Gtk.Button({
        label: title,
        valign: Gtk.Align.CENTER
    });
    if (styleClass) {
        button.add_css_class(styleClass);
    }
    button.connect('clicked', () => {
        Gio.app_info_launch_default_for_uri(uri, null);
    });
    return button;
}

export default class LiveTextPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.livetext');

        // Single Unified Page Design
        const page = new Adw.PreferencesPage({
            title: 'Live Text Configuration',
            icon_name: 'preferences-system-symbolic'
        });

        // --- SECTION 1: SMALL HEADER / DESCRIPTION ---
        const groupHeader = new Adw.PreferencesGroup();
        const descLabel = new Gtk.Label({
            label: 'Instantly extract and copy text to your clipboard from anywhere on the screen.',
            justify: Gtk.Justification.CENTER,
            wrap: true,
            margin_top: 12,
            margin_bottom: 12
        });
        descLabel.add_css_class('dim-label');
        groupHeader.add(descLabel);
        page.add(groupHeader);

        // --- SECTION 2: SETTINGS & SHORTCUTS ---
        const groupSettings = new Adw.PreferencesGroup({
            title: 'Behavior & Shortcuts'
        });

        // Notification Toggle Row
        const notificationRow = new Adw.ActionRow({
            title: 'Show Extracted Text Notification',
            subtitle: 'Displays a system banner containing your copied text context.'
        });
        const toggleNotification = new Gtk.Switch({
            active: settings.get_boolean('show-notification'),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('show-notification', toggleNotification, 'active', Gio.SettingsBindFlags.DEFAULT);
        notificationRow.add_suffix(toggleNotification);
        notificationRow.activatable_widget = toggleNotification;
        groupSettings.add(notificationRow);

        // Shortcut Text Configuration Row
        const shortcutRow = new Adw.ActionRow({
            title: 'Keyboard Shortcut Trigger',
            subtitle: 'Click to set shortcut. Press Esc to cancel, Backspace to disable.'
        });
        
        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            accelerator: settings.get_strv('shortcut-trigger')[0] || '',
            valign: Gtk.Align.CENTER
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
                shortcutLabel.set_disabled_text('Press keys...');
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
                shortcutLabel.set_disabled_text('Disabled');
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

        // --- SECTION 3: ABOUT & CREATOR INFO ---
        const groupAbout = new Adw.PreferencesGroup({
            title: 'Developer Details'
        });

        const authorRow = new Adw.ActionRow({ title: 'Author', subtitle: 'Christian Wittenberg' });
        const versionRow = new Adw.ActionRow({ title: 'Version', subtitle: '1.0.0 (Production Release)' });

        groupAbout.add(authorRow);
        groupAbout.add(versionRow);
        page.add(groupAbout);

        // --- SECTION 4: LINK UTILITIES ---
        const groupLinks = new Adw.PreferencesGroup();
        const linkBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            margin_top: 16,
            margin_bottom: 16
        });

        linkBox.append(createLinkButton('Buy me a coffee 💙☕', 'https://ko-fi.com/cwittenberg', 'suggested-action'));
        linkBox.append(createLinkButton('Report a Bug 🪲', 'https://github.com/cwittenberg/omnipanel/issues/new?template=bug_report.md'));
        linkBox.append(createLinkButton('Request a Feature 💡', 'https://github.com/cwittenberg/omnipanel/issues/new?template=feature_request.md'));

        groupLinks.add(linkBox);
        page.add(groupLinks);

        window.add(page);
    }
}