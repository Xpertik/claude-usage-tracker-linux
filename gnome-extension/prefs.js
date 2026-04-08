/* prefs.js — Claude Usage Tracker Preferences (GNOME 45+ / Adw)
 *
 * Adw-based preferences window for configuring polling, thresholds,
 * display options, and Catppuccin color scheme.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function hexToRGBA(hex) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex);
    return rgba;
}

function rgbaToHex(rgba) {
    const r = Math.round(rgba.red * 255);
    const g = Math.round(rgba.green * 255);
    const b = Math.round(rgba.blue * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Color key definitions
// ---------------------------------------------------------------------------

// Color key definitions — titles/subtitles are translated at render time
const COLOR_KEYS = [
    {key: 'color-normal', titleKey: 'Normal (under 70%)', subtitleKey: 'Usage below 70%'},
    {key: 'color-warning', titleKey: 'Warning (70-90%)', subtitleKey: 'Usage between 70% and 90%'},
    {key: 'color-critical', titleKey: 'Critical (90%+)', subtitleKey: 'Usage at or above 90%'},
    {key: 'color-text', titleKey: 'Text Color', subtitleKey: 'Label text in the dropdown'},
    {key: 'color-background', titleKey: 'Background', subtitleKey: 'Dropdown panel background'},
];

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export default class ClaudeUsageTrackerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const _ = this.gettext.bind(this);

        window.set_default_size(500, 600);

        // ===================================================================
        // General page
        // ===================================================================

        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('Polling and notification settings'),
        });

        // Refresh interval
        const refreshRow = new Adw.SpinRow({
            title: _('Refresh Interval'),
            subtitle: _('How often to poll usage data (seconds)'),
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 60,
                page_increment: 300,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(refreshRow);

        // Notification threshold
        const thresholdRow = new Adw.SpinRow({
            title: _('Notification Threshold'),
            subtitle: _('Warn when usage exceeds this percentage'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
                value: settings.get_int('notify-threshold'),
            }),
        });
        settings.bind('notify-threshold', thresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(thresholdRow);

        generalPage.add(behaviorGroup);

        // ---------------------------------------------------------------
        // Per-metric indicator groups
        // ---------------------------------------------------------------

        const indicatorStyles = ['percentage', 'progress-bar', 'circle', 'compact'];
        const indicatorStyleLabels = [
            _('Percentage (icon + text)'),
            _('Progress Bar (label + bar)'),
            _('Circle (ring indicator)'),
            _('Compact (icon only)'),
        ];

        // Helper: create a metric indicator preference group
        const createMetricGroup = (title, subtitle, prefix) => {
            const group = new Adw.PreferencesGroup({title, description: subtitle});

            // Enabled toggle
            const enabledRow = new Adw.SwitchRow({
                title: _('Enabled'),
                subtitle: _('Show this indicator in the top bar'),
            });
            settings.bind(`${prefix}-indicator-enabled`, enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(enabledRow);

            // Indicator style combo
            const styleModel = new Gtk.StringList();
            for (const label of indicatorStyleLabels)
                styleModel.append(label);

            const styleRow = new Adw.ComboRow({
                title: _('Indicator Style'),
                subtitle: _('How usage is displayed in the top bar'),
                model: styleModel,
            });

            const currentStyle = settings.get_string(`${prefix}-indicator-style`);
            const styleIdx = indicatorStyles.indexOf(currentStyle);
            if (styleIdx >= 0)
                styleRow.set_selected(styleIdx);

            styleRow.connect('notify::selected', () => {
                const idx = styleRow.get_selected();
                if (idx >= 0 && idx < indicatorStyles.length)
                    settings.set_string(`${prefix}-indicator-style`, indicatorStyles[idx]);
            });

            settings.connect(`changed::${prefix}-indicator-style`, () => {
                const val = settings.get_string(`${prefix}-indicator-style`);
                const idx = indicatorStyles.indexOf(val);
                if (idx >= 0 && styleRow.get_selected() !== idx)
                    styleRow.set_selected(idx);
            });

            group.add(styleRow);

            // Show time toggle
            const showTimeRow = new Adw.SwitchRow({
                title: _('Show Time Until Reset'),
                subtitle: _('Display remaining time beside the indicator'),
            });
            settings.bind(`${prefix}-show-time`, showTimeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(showTimeRow);

            // Sensitivity: disable style/time controls when metric is off
            const updateSensitivity = () => {
                const enabled = settings.get_boolean(`${prefix}-indicator-enabled`);
                styleRow.set_sensitive(enabled);
                showTimeRow.set_sensitive(enabled);
            };
            updateSensitivity();
            settings.connect(`changed::${prefix}-indicator-enabled`, updateSensitivity);

            return group;
        };

        // Session Usage group
        generalPage.add(createMetricGroup(
            _('Session Usage'),
            _('5-hour rolling window usage'),
            'session'
        ));

        // Week Usage group
        generalPage.add(createMetricGroup(
            _('Week Usage'),
            _('Weekly token usage (all models)'),
            'week'
        ));

        // ---------------------------------------------------------------
        // Display Options (shared settings)
        // ---------------------------------------------------------------

        const displayGroup = new Adw.PreferencesGroup({
            title: _('Display Options'),
            description: _('Shared display settings'),
        });

        // Show time position marker
        const timeMarkerRow = new Adw.SwitchRow({
            title: _('Show Time Position Marker'),
            subtitle: _('Draw a vertical tick on progress bars showing elapsed time'),
        });
        settings.bind('show-time-marker', timeMarkerRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(timeMarkerRow);

        // Color Mode
        const colorModes = ['color', 'monochrome'];
        const colorModeLabels = [_('Color (themed)'), _('Monochrome (white/grey)')];
        const colorModeModel = new Gtk.StringList();
        for (const label of colorModeLabels)
            colorModeModel.append(label);

        const colorModeRow = new Adw.ComboRow({
            title: _('Color Mode'),
            subtitle: _('Color scheme for the top bar indicator'),
            model: colorModeModel,
        });

        const currentColorMode = settings.get_string('color-mode');
        const colorModeIdx = colorModes.indexOf(currentColorMode);
        if (colorModeIdx >= 0)
            colorModeRow.set_selected(colorModeIdx);

        colorModeRow.connect('notify::selected', () => {
            const idx = colorModeRow.get_selected();
            if (idx >= 0 && idx < colorModes.length)
                settings.set_string('color-mode', colorModes[idx]);
        });

        settings.connect('changed::color-mode', () => {
            const val = settings.get_string('color-mode');
            const idx = colorModes.indexOf(val);
            if (idx >= 0 && colorModeRow.get_selected() !== idx)
                colorModeRow.set_selected(idx);
        });

        displayGroup.add(colorModeRow);

        // Show extra usage / cost
        const extraUsageRow = new Adw.SwitchRow({
            title: _('Show Cost Info'),
            subtitle: _('Display the extra usage / cost section in the dropdown'),
        });
        settings.bind('show-extra-usage', extraUsageRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(extraUsageRow);

        generalPage.add(displayGroup);

        // ===================================================================
        // Colors page
        // ===================================================================

        const colorsPage = new Adw.PreferencesPage({
            title: _('Colors'),
            icon_name: 'applications-graphics-symbolic',
        });

        const colorsGroup = new Adw.PreferencesGroup({
            title: _('Color Scheme'),
            description: _('Catppuccin Mocha defaults. Click a swatch to change.'),
        });

        for (const {key, titleKey, subtitleKey} of COLOR_KEYS) {
            const row = new Adw.ActionRow({title: _(titleKey), subtitle: _(subtitleKey)});

            const colorDialog = new Gtk.ColorDialog();
            const colorButton = new Gtk.ColorDialogButton({
                dialog: colorDialog,
                rgba: hexToRGBA(settings.get_string(key)),
                valign: Gtk.Align.CENTER,
            });

            // Write hex back to GSettings when the user picks a color
            colorButton.connect('notify::rgba', () => {
                const hex = rgbaToHex(colorButton.get_rgba());
                if (hex !== settings.get_string(key))
                    settings.set_string(key, hex);
            });

            // Live-update the button when settings change externally
            settings.connect(`changed::${key}`, () => {
                const currentHex = rgbaToHex(colorButton.get_rgba());
                const newHex = settings.get_string(key);
                if (currentHex !== newHex)
                    colorButton.set_rgba(hexToRGBA(newHex));
            });

            row.add_suffix(colorButton);
            row.set_activatable_widget(colorButton);
            colorsGroup.add(row);
        }

        colorsPage.add(colorsGroup);

        // Reset to defaults button
        const resetGroup = new Adw.PreferencesGroup();

        const resetButton = new Gtk.Button({
            label: _('Reset Colors to Defaults'),
            css_classes: ['destructive-action'],
            halign: Gtk.Align.CENTER,
            margin_top: 12,
        });

        resetButton.connect('clicked', () => {
            for (const {key} of COLOR_KEYS)
                settings.reset(key);
        });

        resetGroup.add(resetButton);
        colorsPage.add(resetGroup);

        // ===================================================================
        // Add pages to window
        // ===================================================================

        window.add(generalPage);
        window.add(colorsPage);
    }
}
