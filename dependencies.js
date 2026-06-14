import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

const COPY_ICON_RESET_MS = 2000;

function checkDependencies() {
    let missing = [];

    if (!GLib.find_program_in_path('gnome-screenshot')) {
        missing.push('gnome-screenshot');
    }
    
    if (!GLib.find_program_in_path('zbarimg')) {
        missing.push('zbarimg');
    }

    if (!GLib.find_program_in_path('tesseract')) {
        missing.push('tesseract');
    }

    if (!GLib.find_program_in_path('mogrify') || !GLib.find_program_in_path('identify')) {
        missing.push('imagemagick');
    }

    return missing;
}

function getCombinedInstallCommand(missingApps) {
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

    let packages = [];

    if (isFedoraLike) {
        if (missingApps.includes('gnome-screenshot')) packages.push('gnome-screenshot');
        if (missingApps.includes('zbarimg')) packages.push('zbar');
        if (missingApps.includes('tesseract')) packages.push('tesseract tesseract-langpack-eng');
        if (missingApps.includes('imagemagick')) packages.push('ImageMagick');
        
        if (packages.length > 0) {
            return `sudo dnf install ${packages.join(' ')}`;
        }
    }

    if (isArchLike) {
        if (missingApps.includes('gnome-screenshot')) packages.push('gnome-screenshot');
        if (missingApps.includes('zbarimg')) packages.push('zbar');
        if (missingApps.includes('tesseract')) packages.push('tesseract tesseract-data-eng');
        if (missingApps.includes('imagemagick')) packages.push('imagemagick');
        
        if (packages.length > 0) {
            return `sudo pacman -S ${packages.join(' ')}`;
        }
    }

    if (isDebianLike) {
        if (missingApps.includes('gnome-screenshot')) packages.push('gnome-screenshot');
        if (missingApps.includes('zbarimg')) packages.push('zbar-tools');
        if (missingApps.includes('tesseract')) packages.push('tesseract-ocr tesseract-ocr-eng');
        if (missingApps.includes('imagemagick')) packages.push('imagemagick');
        
        if (packages.length > 0) {
            return `sudo apt update && sudo apt install ${packages.join(' ')}`;
        }
    }

    return '# Install the missing dependencies using your distribution package manager:\n# ' + missingApps.join(', ');
}

const DependencyErrorDialog = GObject.registerClass(
    class DependencyErrorDialog extends ModalDialog.ModalDialog {
        _init(missingApps, installCmd) {
            super._init();

            this._copyIconTimeoutId = 0;
            this.connectObject('closed', () => this.destroy(), this);

            let box = new St.BoxLayout({
                vertical: true,
                style: 'padding: 24px; spacing: 18px; width: 520px;',
            });

            let titleText = missingApps.length > 1 
                ? _('Missing dependencies: %s').replace('%s', missingApps.join(', '))
                : _('Missing dependency: %s').replace('%s', missingApps[0]);

            let title = new St.Label({
                text: titleText,
                style: 'font-size: 14pt; font-weight: bold; color: #ff5555;',
            });
            title.clutter_text.line_wrap = true;
            box.add_child(title);

            let descText = _('Please install the required packages and try again to enable all features.');
            let description = new St.Label({
                text: descText,
            });
            description.clutter_text.line_wrap = true;
            box.add_child(description);

            // Create a styled table to explain package purposes
            let tableBox = new St.BoxLayout({
                vertical: true,
                style: 'spacing: 8px; background-color: rgba(128,128,128,0.1); padding: 12px; border-radius: 8px;',
            });

            const packageDescriptions = {
                'gnome-screenshot': _('Captures the selected area of your screen.'),
                'tesseract': _('The core OCR engine that reads text from images.'),
                'imagemagick': _('Improves image contrast and quality for better OCR.'),
                'zbarimg': _('Detects and decodes QR codes from the screen.')
            };

            missingApps.forEach(app => {
                let row = new St.BoxLayout({
                    vertical: false,
                    style: 'spacing: 12px;'
                });
                
                let nameLabel = new St.Label({
                    text: app,
                    style: 'font-weight: bold; width: 140px;'
                });
                
                let descLabel = new St.Label({
                    text: packageDescriptions[app] || _('Required dependency.'),
                });
                descLabel.clutter_text.line_wrap = true;
                descLabel.x_expand = true; // Let the description fill available space
                
                row.add_child(nameLabel);
                row.add_child(descLabel);
                tableBox.add_child(row);
            });
            
            box.add_child(tableBox);

            // Add instruction text underneath the table
            let terminalInstruction = new St.Label({
                text: _('Open a Terminal and run the following command to install the missing dependencies from the official repositories:'),
            });
            terminalInstruction.clutter_text.line_wrap = true;
            box.add_child(terminalInstruction);

            // Install command box
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

export function getMissingAppsErrorDialog() {
    let missingApps = checkDependencies();
    if (missingApps.length === 0) {
        return null;
    }
    const installCmd = getCombinedInstallCommand(missingApps);
    return new DependencyErrorDialog(missingApps, installCmd);
}