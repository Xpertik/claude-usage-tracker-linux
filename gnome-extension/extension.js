/* extension.js — Claude Usage Tracker for GNOME 45+
 *
 * Monitors Claude API usage and displays it in the GNOME top bar.
 * Reads OAuth credentials from ~/.claude/.credentials.json,
 * polls GET /api/oauth/usage, and shows usage breakdown in a dropdown.
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Module-level gettext reference — set in enable(), used everywhere
let _ = (s) => s; // identity fallback until enable() runs

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.anthropic.com';
const USAGE_ENDPOINT = `${API_BASE}/api/oauth/usage`;
const REFRESH_ENDPOINT = `${API_BASE}/api/oauth/token`;
const BETA_HEADER = 'oauth-2025-04-20';
const MIN_REFRESH_INTERVAL = 60; // seconds
const SHARED_CACHE_MAX_AGE = 300; // 5 minutes — consider stale after this
const PROGRESS_BAR_WIDTH = 200;
const PROGRESS_BAR_HEIGHT = 8;
const PROGRESS_BAR_RADIUS = 4;

// Navbar indicator drawing area sizes
const NAVBAR_BAR_WIDTH = 55;
const NAVBAR_BAR_HEIGHT = 10;
const NAVBAR_CIRCLE_SIZE = 20;
const NAVBAR_CIRCLE_LINE_WIDTH = 3;

// Indicator style enum values
const INDICATOR_STYLES = ['percentage', 'progress-bar', 'circle', 'compact'];
const COLOR_MODES = ['color', 'monochrome'];

// Per-metric configuration for dual indicators (session + week)
const METRIC_CONFIGS = {
    session: {
        dataKey: 'fiveHour',
        windowMs: 5 * 3600 * 1000,        // 5 hours in ms
        settingsPrefix: 'session',
        defaultLabel: 'S',
        shortId: 'S',
    },
    week: {
        dataKey: 'sevenDay',
        windowMs: 7 * 86400 * 1000,       // 7 days in ms
        settingsPrefix: 'week',
        defaultLabel: 'W',
        shortId: 'W',
    },
};

/**
 * Make a PopupMenu item display-only (no hover highlight) without dimming text.
 * Using {reactive: false} causes GNOME to apply insensitive/dimmed styling.
 * Instead, we keep reactive but disable hover tracking.
 */
function _makeInfoItem(item) {
    item.track_hover = false;
    item.can_focus = false;
    return item;
}

// Pace tiers based on projected usage
// NOTE: labels use gettext keys — translated at render time via _getPaceTier()
const PACE_TIERS = [
    {max: 30, label: 'Comfortable', styleClass: 'claude-pace-behind'},
    {max: 50, label: 'Moderate', styleClass: 'claude-pace-normal'},
    {max: 70, label: 'Active', styleClass: 'claude-pace-normal'},
    {max: 85, label: 'Heavy', styleClass: 'claude-pace-ahead'},
    {max: 95, label: 'Critical', styleClass: 'claude-pace-ahead'},
    {max: Infinity, label: 'Runaway', styleClass: 'claude-pace-ahead'},
];

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

/**
 * Read credentials from ~/.claude/.credentials.json.
 * Returns { accessToken, refreshToken, expiresAt } or null.
 */
function _readCredentials() {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null))
        return null;

    try {
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;

        const decoder = new TextDecoder('utf-8');
        const json = JSON.parse(decoder.decode(contents));

        const oauth = json.claudeAiOauth;
        if (!oauth?.accessToken)
            return null;

        return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken ?? null,
            expiresAt: oauth.expiresAt ? new Date(oauth.expiresAt) : null,
        };
    } catch (e) {
        console.error(`[Claude Tracker] Failed to read credentials: ${e.message}`);
        return null;
    }
}

/**
 * Persist updated credentials back to ~/.claude/.credentials.json.
 * Reads the existing file first to preserve other keys (e.g. mcpOAuth),
 * then updates only the claudeAiOauth section.
 */
function _writeCredentials(creds) {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
    const file = Gio.File.new_for_path(path);

    try {
        // Read existing file to preserve other keys (mcpOAuth, etc.)
        let existing = {};
        if (file.query_exists(null)) {
            const [ok, contents] = file.load_contents(null);
            if (ok) {
                const decoder = new TextDecoder('utf-8');
                existing = JSON.parse(decoder.decode(contents));
            }
        }

        // Update only the claudeAiOauth section
        existing.claudeAiOauth = {
            ...existing.claudeAiOauth,
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            expiresAt: creds.expiresAt instanceof Date
                ? creds.expiresAt.toISOString()
                : creds.expiresAt,
        };

        const payload = JSON.stringify(existing, null, 2);

        file.replace_contents(
            new TextEncoder().encode(payload),
            null,   // etag
            false,  // make_backup
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null    // cancellable
        );
    } catch (e) {
        console.error(`[Claude Tracker] Failed to write credentials: ${e.message}`);
    }
}

/**
 * Check whether the token has expired.
 */
function _isTokenExpired(creds) {
    if (!creds || !creds.expiresAt)
        return false; // can't tell — assume valid

    return new Date() >= creds.expiresAt;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/**
 * Convert an ISO timestamp to a human-readable countdown.
 * Returns "Resets in Xh Ym" for < 24h, "Resets in Xd Yh" for >= 24h.
 */
function _formatCountdown(isoString) {
    if (!isoString)
        return `${_('Resets in')} --`;

    const resetAt = new Date(isoString);
    const now = new Date();
    const diffMs = resetAt - now;

    if (diffMs <= 0)
        return _('Resets now');

    const totalMin = Math.floor(diffMs / 60000);
    const totalHours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;

    if (totalHours >= 24) {
        const days = Math.floor(totalHours / 24);
        const hours = totalHours % 24;
        return `${_('Resets in')} ${days}d ${hours}h`;
    }

    return `${_('Resets in')} ${totalHours}h ${mins}m`;
}

/**
 * Compute a pace tier label from current usage percentage.
 */
function _getPaceTier(usedPct) {
    for (const tier of PACE_TIERS) {
        if (usedPct < tier.max)
            return tier;
    }
    return PACE_TIERS[PACE_TIERS.length - 1];
}

/**
 * Parse a hex color string into [r, g, b] normalized to 0-1.
 */
function _hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3)
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];

    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b];
}

// ---------------------------------------------------------------------------
// Usage data model
// ---------------------------------------------------------------------------

/**
 * Parse raw API JSON into a normalized usage object.
 * Null model fields are omitted.
 */
function _parseUsageResponse(json) {
    const usage = {
        fiveHour: null,
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
    };

    if (json.five_hour) {
        usage.fiveHour = {
            usedPct: (json.five_hour.used_percentage ?? 0) * 100,
            resetsAt: json.five_hour.resets_at ?? null,
        };
    }

    if (json.seven_day) {
        usage.sevenDay = {
            usedPct: (json.seven_day.used_percentage ?? 0) * 100,
            resetsAt: json.seven_day.resets_at ?? null,
        };
    }

    if (json.seven_day_sonnet) {
        usage.sevenDaySonnet = {
            usedPct: (json.seven_day_sonnet.used_percentage ?? 0) * 100,
            resetsAt: json.seven_day_sonnet.resets_at ?? null,
        };
    }

    if (json.seven_day_opus) {
        usage.sevenDayOpus = {
            usedPct: (json.seven_day_opus.used_percentage ?? 0) * 100,
            resetsAt: json.seven_day_opus.resets_at ?? null,
        };
    }

    if (json.extra_usage) {
        usage.extraUsage = {
            monthlyLimit: json.extra_usage.monthly_limit ?? 0,
            usedCredits: json.extra_usage.used_credits ?? 0,
        };
    }

    return usage;
}

/**
 * Parse Claude Code's statusline JSON into a normalized usage object.
 * Percentages are already 0-100 (unlike the API which returns 0-1).
 */
function _parseSharedCacheData(json) {
    const usage = {
        fiveHour: null,
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        contextWindow: null,
        model: null,
        sessionCost: null,
    };

    if (json.rate_limits?.five_hour) {
        usage.fiveHour = {
            usedPct: json.rate_limits.five_hour.used_percentage ?? 0,
            resetsAt: json.rate_limits.five_hour.resets_at
                ? new Date(json.rate_limits.five_hour.resets_at * 1000).toISOString()
                : null,
        };
    }

    if (json.rate_limits?.seven_day) {
        usage.sevenDay = {
            usedPct: json.rate_limits.seven_day.used_percentage ?? 0,
            resetsAt: json.rate_limits.seven_day.resets_at
                ? new Date(json.rate_limits.seven_day.resets_at * 1000).toISOString()
                : null,
        };
    }

    if (json.context_window) {
        usage.contextWindow = {
            usedPct: json.context_window.used_percentage ?? 0,
            totalTokens: json.context_window.context_window_size ?? 0,
        };
    }

    if (json.model) {
        usage.model = json.model.display_name ?? json.model.id ?? null;
    }

    if (json.cost) {
        usage.sessionCost = json.cost.total_cost_usd ?? 0;
    }

    return usage;
}

/**
 * Try to read Claude Code's shared cache file.
 * Returns parsed usage object or null if unavailable/stale.
 */
function _readSharedCache() {
    try {
        // Get UID via GLib.getuid() (available in GJS)
        const uidStr = String(new Gio.UnixCredentialsMessage().get_credentials().get_unix_user());

        const cachePath = `/tmp/claude-usage-data-${uidStr}.json`;
        const file = Gio.File.new_for_path(cachePath);

        if (!file.query_exists(null))
            return null;

        // Check freshness
        const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const modTime = info.get_modification_date_time();
        const now = GLib.DateTime.new_now_local();
        const ageSec = now.to_unix() - modTime.to_unix();

        if (ageSec > SHARED_CACHE_MAX_AGE)
            return null; // stale

        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;

        const decoder = new TextDecoder('utf-8');
        const json = JSON.parse(decoder.decode(contents));

        return _parseSharedCacheData(json);
    } catch (e) {
        // Fallback: try well-known path directly
        try {
            const fallbackPath = '/tmp/claude-usage-data-1000.json';
            const file = Gio.File.new_for_path(fallbackPath);
            if (!file.query_exists(null))
                return null;

            const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const modTime = info.get_modification_date_time();
            const now = GLib.DateTime.new_now_local();
            const ageSec = now.to_unix() - modTime.to_unix();

            if (ageSec > SHARED_CACHE_MAX_AGE)
                return null;

            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return null;

            const decoder = new TextDecoder('utf-8');
            const json = JSON.parse(decoder.decode(contents));
            return _parseSharedCacheData(json);
        } catch (_fallback) {
            console.log(`[Claude Tracker] Shared cache read failed: ${e.message}`);
            return null;
        }
    }
}

// ---------------------------------------------------------------------------
// Data Service — owns polling, credentials, cache, timers
// ---------------------------------------------------------------------------

class ClaudeDataService {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.getSettings();
        this._session = new Soup.Session();
        this._credentials = null;
        this._lastUsage = null;
        this._isRefreshing = false;
        this._pollTimerId = null;
        this._countdownTimerId = null;
        this._listeners = [];
        this._settingsSignals = [];
    }

    // --- Public API ---

    get lastUsage() {
        return this._lastUsage;
    }

    subscribe(callback) {
        this._listeners.push(callback);
    }

    unsubscribe(callback) {
        this._listeners = this._listeners.filter(fn => fn !== callback);
    }

    start() {
        this._startPolling();
        this._startCountdownTimer();
    }

    stop() {
        this._stopPolling();
        this._stopCountdownTimer();

        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

        this._listeners = [];
        this._session = null;
    }

    // --- Notification ---

    _notifyListeners() {
        for (const fn of this._listeners)
            fn(this._lastUsage);
    }

    // --- Settings helper ---

    _connectSetting(signal, callback) {
        const id = this._settings.connect(signal, callback);
        this._settingsSignals.push(id);
    }

    // --- Polling lifecycle ---

    _startPolling() {
        this._poll();
        this._schedulePoll();
        this._connectSetting('changed::refresh-interval', () => this._restartPolling());
    }

    _stopPolling() {
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }
    }

    _restartPolling() {
        this._stopPolling();
        this._schedulePoll();
    }

    _schedulePoll() {
        let interval = this._settings.get_int('refresh-interval');
        if (interval < MIN_REFRESH_INTERVAL)
            interval = MIN_REFRESH_INTERVAL;

        this._pollTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    // --- Countdown timer — triggers listener updates every 60s ---

    _startCountdownTimer() {
        this._countdownTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this._notifyListeners();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopCountdownTimer() {
        if (this._countdownTimerId) {
            GLib.source_remove(this._countdownTimerId);
            this._countdownTimerId = null;
        }
    }

    // --- API communication ---

    async _poll() {
        // Primary: try shared cache from Claude Code statusline
        const cached = _readSharedCache();
        if (cached) {
            this._lastUsage = cached;
            this._notifyListeners();
            return;
        }

        // Fallback: call API directly
        this._credentials = _readCredentials();

        if (!this._credentials) {
            if (this._lastUsage) {
                // Notify with stale flag
                this._notifyListeners();
            } else {
                this._lastUsage = null;
                this._notifyListeners();
            }
            return;
        }

        // Lazy refresh: check expiry before calling
        if (_isTokenExpired(this._credentials)) {
            const refreshed = await this._refreshToken();
            if (!refreshed) {
                this._lastUsage = null;
                this._notifyListeners();
                return;
            }
        }

        try {
            const data = await this._fetchUsage();
            this._lastUsage = data;
            this._notifyListeners();
        } catch (e) {
            // On 401 attempt one refresh
            if (e.statusCode === 401 && !this._isRefreshing) {
                const refreshed = await this._refreshToken();
                if (refreshed) {
                    try {
                        const data = await this._fetchUsage();
                        this._lastUsage = data;
                        this._notifyListeners();
                        return;
                    } catch (_retryErr) {
                        // fall through to error display
                    }
                }
            }

            // Keep lastUsage as-is (stale) or null — listeners will handle
            this._notifyListeners();
        }
    }

    /**
     * Fetch usage data from the Anthropic API.
     * Returns parsed usage object.
     * Throws on HTTP error with a .statusCode property.
     */
    _fetchUsage() {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', USAGE_ENDPOINT);
            message.request_headers.append('Authorization', `Bearer ${this._credentials.accessToken}`);
            message.request_headers.append('anthropic-beta', BETA_HEADER);

            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();

                        if (status !== Soup.Status.OK) {
                            const err = new Error(`HTTP ${status}`);
                            err.statusCode = status;
                            reject(err);
                            return;
                        }

                        const decoder = new TextDecoder('utf-8');
                        const json = JSON.parse(decoder.decode(bytes.get_data()));
                        resolve(_parseUsageResponse(json));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Refresh the access token using the refresh token.
     * Returns true on success, false on failure.
     */
    async _refreshToken() {
        if (this._isRefreshing)
            return false;

        if (!this._credentials?.refreshToken) {
            console.warn('[Claude Tracker] No refresh token available');
            return false;
        }

        this._isRefreshing = true;

        try {
            const result = await new Promise((resolve, reject) => {
                const message = Soup.Message.new('POST', REFRESH_ENDPOINT);
                message.request_headers.set_content_type('application/json', null);

                const body = JSON.stringify({
                    grant_type: 'refresh_token',
                    refresh_token: this._credentials.refreshToken,
                });
                message.set_request_body_from_bytes(
                    'application/json',
                    new GLib.Bytes(new TextEncoder().encode(body))
                );

                this._session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (session, res) => {
                        try {
                            const bytes = session.send_and_read_finish(res);
                            const status = message.get_status();

                            if (status !== Soup.Status.OK) {
                                reject(new Error(`Refresh failed: HTTP ${status}`));
                                return;
                            }

                            const decoder = new TextDecoder('utf-8');
                            resolve(JSON.parse(decoder.decode(bytes.get_data())));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // Update credentials in memory and on disk
            this._credentials.accessToken = result.access_token ?? result.accessToken;
            this._credentials.expiresAt = result.expires_at
                ? new Date(result.expires_at)
                : result.expiresAt
                    ? new Date(result.expiresAt)
                    : null;

            if (result.refresh_token ?? result.refreshToken)
                this._credentials.refreshToken = result.refresh_token ?? result.refreshToken;

            _writeCredentials(this._credentials);
            return true;
        } catch (e) {
            console.error(`[Claude Tracker] Token refresh failed: ${e.message}`);
            return false;
        } finally {
            this._isRefreshing = false;
        }
    }
}

// ---------------------------------------------------------------------------
// Progress Bar (St.DrawingArea + Cairo)
// ---------------------------------------------------------------------------

class ClaudeProgressBar extends St.DrawingArea {
    static {
        GObject.registerClass(this);
    }

    _init(params = {}) {
        super._init({
            style_class: 'claude-progress-container',
            width: PROGRESS_BAR_WIDTH,
            height: PROGRESS_BAR_HEIGHT,
            ...params,
        });

        this._percentage = 0;
        this._fillColor = '#89b4fa';
        this._bgColor = '#313244';

        this.connect('repaint', () => this._onRepaint());
    }

    setProgress(pct, fillColor, bgColor) {
        this._percentage = Math.max(0, Math.min(100, pct));
        this._fillColor = fillColor;
        this._bgColor = bgColor;
        this.queue_repaint();
    }

    _onRepaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const radius = PROGRESS_BAR_RADIUS;

        // Background rounded rect
        const [bgR, bgG, bgB] = _hexToRgb(this._bgColor);
        cr.setSourceRGB(bgR, bgG, bgB);
        _drawRoundedRect(cr, 0, 0, width, height, radius);
        cr.fill();

        // Fill rounded rect
        const fillWidth = (this._percentage / 100) * width;
        if (fillWidth > 0) {
            const [fR, fG, fB] = _hexToRgb(this._fillColor);
            cr.setSourceRGB(fR, fG, fB);
            _drawRoundedRect(cr, 0, 0, Math.max(fillWidth, radius * 2), height, radius);
            cr.fill();
        }

        cr.$dispose();
    }
}

/**
 * Draw a rounded rectangle path on a Cairo context.
 */
function _drawRoundedRect(cr, x, y, w, h, r) {
    const degrees = Math.PI / 180.0;
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -90 * degrees, 0);
    cr.arc(x + w - r, y + h - r, r, 0, 90 * degrees);
    cr.arc(x + r, y + h - r, r, 90 * degrees, 180 * degrees);
    cr.arc(x + r, y + r, r, 180 * degrees, 270 * degrees);
    cr.closePath();
}

// ---------------------------------------------------------------------------
// Indicator (PanelMenu.Button subclass)
// ---------------------------------------------------------------------------

class ClaudeMetricIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this); // eslint-disable-line no-undef
    }

    /**
     * @param {Object} metricConfig - Entry from METRIC_CONFIGS (session or week)
     * @param {ClaudeDataService} dataService - Shared data service instance
     * @param {Extension} ext - Extension instance for settings / gettext
     */
    _init(metricConfig, dataService, ext) {
        super._init(0.5, _('Claude Usage Tracker'), false);

        this._ext = ext;
        this._settings = ext.getSettings();
        this._metricConfig = metricConfig;
        this._prefix = metricConfig.settingsPrefix;
        this._dataService = dataService;
        this._lastUsage = null;
        this._lastMetric = null; // metric-specific data (e.g. usage.fiveHour)
        this._lastPct = 0;
        this._progressBars = [];
        this._settingsSignals = [];
        this._stale = false;

        // --- Top bar layout ---
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._box.add_style_class_name(`claude-indicator-${this._prefix}`);

        // Icon (used by 'percentage' and 'compact' styles)
        this._icon = new St.Icon({
            icon_name: 'dialog-information-symbolic',
            style_class: 'claude-indicator-icon system-status-icon',
        });
        this._box.add_child(this._icon);

        // Metric label (used by 'progress-bar' style) — shows defaultLabel (5H / 7D)
        this._navbarLabel = new St.Label({
            text: metricConfig.defaultLabel,
            style_class: 'claude-indicator-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._navbarLabel);

        // Vertical container for bar + remaining time (used by 'progress-bar')
        this._barGroup = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Horizontal progress bar drawing area
        this._navbarBar = new St.DrawingArea({
            style_class: 'claude-navbar-bar',
            width: NAVBAR_BAR_WIDTH,
            height: NAVBAR_BAR_HEIGHT,
        });
        this._navbarBar.connect('repaint', () => this._onNavbarBarRepaint());
        this._barGroup.add_child(this._navbarBar);

        // Remaining time label below bar (e.g. "S(<2H)")
        this._remainingLabel = new St.Label({
            text: '',
            style_class: 'claude-remaining-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._remainingLabel.visible = false;
        this._barGroup.add_child(this._remainingLabel);

        this._box.add_child(this._barGroup);

        // Circle ring drawing area (used by 'circle' style)
        this._navbarCircle = new St.DrawingArea({
            style_class: 'claude-navbar-circle',
            width: NAVBAR_CIRCLE_SIZE,
            height: NAVBAR_CIRCLE_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._navbarCircle.connect('repaint', () => this._onNavbarCircleRepaint());
        this._box.add_child(this._navbarCircle);

        // Percentage text label (used by all styles except 'compact')
        this._label = new St.Label({
            text: '---%',
            style_class: 'claude-indicator-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._label);

        // Remaining time label beside indicator (non-bar styles)
        this._remainingLabelInline = new St.Label({
            text: '',
            style_class: 'claude-remaining-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._remainingLabelInline.visible = false;
        this._box.add_child(this._remainingLabelInline);

        this.add_child(this._box);

        // --- Dropdown placeholder ---
        this._statusItem = _makeInfoItem(new PopupMenu.PopupMenuItem(_('Loading...')));
        this.menu.addMenuItem(this._statusItem);

        // --- Listen for per-metric settings changes ---
        this._connectSetting(`changed::${this._prefix}-indicator-style`, () => this._updateIndicatorStyle());
        this._connectSetting(`changed::${this._prefix}-show-time`, () => this._refreshUI());
        // Backward compat: also listen to legacy keys
        this._connectSetting('changed::compact-mode', () => this._updateIndicatorStyle());
        this._connectSetting('changed::color-mode', () => this._refreshUI());
        this._connectSetting('changed::show-extra-usage', () => this._refreshUI());
        this._connectSetting('changed::show-time-marker', () => {
            if (this._navbarBar.visible)
                this._navbarBar.queue_repaint();
        });

        // Color settings — live-update on change
        const colorKeys = ['color-normal', 'color-warning', 'color-critical', 'color-text', 'color-background'];
        for (const key of colorKeys)
            this._connectSetting(`changed::${key}`, () => this._refreshUI());

        // Subscribe to data service updates
        this._onDataUpdate = (usage) => this._handleDataUpdate(usage);
        this._dataService.subscribe(this._onDataUpdate);

        // Initial state
        this._updateIndicatorStyle();
    }

    /**
     * Helper to connect a GSettings signal and track it for cleanup.
     */
    _connectSetting(signal, callback) {
        const id = this._settings.connect(signal, callback);
        this._settingsSignals.push(id);
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    destroy() {
        this._dataService.unsubscribe(this._onDataUpdate);

        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

        this._progressBars = [];
        this._dataService = null;
        super.destroy();
    }

    // -----------------------------------------------------------------------
    // Data service callback
    // -----------------------------------------------------------------------

    /**
     * Called by ClaudeDataService whenever usage data changes (poll or countdown).
     */
    _handleDataUpdate(usage) {
        if (usage) {
            this._lastUsage = usage;
            this._lastMetric = usage[this._metricConfig.dataKey] || null;
            this._updateUI(usage);
        } else if (this._lastUsage) {
            this._updateUI(this._lastUsage, true /* stale */);
        } else {
            this._showError(_('No data — start Claude Code or run `claude` to authenticate'));
        }
    }

    /**
     * Re-render UI from last known data (for countdown updates and color changes).
     */
    _refreshUI() {
        if (this._lastUsage)
            this._updateUI(this._lastUsage);
    }

    // -----------------------------------------------------------------------
    // UI updates
    // -----------------------------------------------------------------------

    _updateUI(usage, stale = false) {
        // Extract this metric's data
        const metric = usage[this._metricConfig.dataKey] || null;
        const pct = metric ? Math.round(metric.usedPct) : 0;
        this._lastPct = pct;
        this._lastMetric = metric;

        if (!metric) {
            this._label.set_text('N/A');
            this._remainingLabel.visible = false;
            this._remainingLabelInline.visible = false;
        } else {
            this._label.set_text(`${pct}%`);
            this._updateRemainingLabel(metric.resetsAt);
        }

        // Color the label and navbar elements based on usage level and color mode
        const indicatorColor = this._getIndicatorColor(pct);
        this._label.set_style(`color: ${indicatorColor};`);
        this._navbarLabel.set_style(`color: ${indicatorColor};`);

        // Reset icon to normal state
        this._icon.set_icon_name('dialog-information-symbolic');

        // Repaint custom drawing areas if visible
        if (this._navbarBar.visible)
            this._navbarBar.queue_repaint();
        if (this._navbarCircle.visible)
            this._navbarCircle.queue_repaint();

        // Rebuild the dropdown
        this.menu.removeAll();
        this._progressBars = [];

        // --- Title (metric-specific) ---
        const metricTitle = this._metricConfig.dataKey === 'fiveHour'
            ? _('Session Usage (5H)')
            : _('Weekly Usage (7D)');
        this._addSection(metricTitle);

        if (stale) {
            this._addStaleWarning();
        }

        // --- Model info (only on session indicator) ---
        if (this._prefix === 'session' && usage.model) {
            const modelItem = _makeInfoItem(new PopupMenu.PopupMenuItem(`${_('Model:')} ${usage.model}`));
            this.menu.addMenuItem(modelItem);
        }

        // --- Context Window (only on session indicator) ---
        if (this._prefix === 'session' && usage.contextWindow) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addUsageBlock(
                _('Context Window'),
                usage.contextWindow.usedPct,
                null // no reset for context
            );
        }

        // --- This metric's usage block ---
        if (metric) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const blockTitle = this._metricConfig.dataKey === 'fiveHour'
                ? _('5-Hour Usage')
                : _('7-Day Usage');
            this._addUsageBlock(blockTitle, metric.usedPct, metric.resetsAt);
        } else {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const blockTitle = this._metricConfig.dataKey === 'fiveHour'
                ? _('5-Hour Usage')
                : _('7-Day Usage');
            this._addUnavailableBlock(blockTitle);
        }

        // --- Extra Usage / Cost (only on session indicator) ---
        if (this._prefix === 'session' && usage.extraUsage && this._settings.get_boolean('show-extra-usage')) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addCostBlock(usage.extraUsage);
        }

        // --- Session Cost (only on session indicator) ---
        if (this._prefix === 'session' && usage.sessionCost !== null && usage.sessionCost !== undefined && usage.sessionCost > 0) {
            if (!usage.extraUsage || !this._settings.get_boolean('show-extra-usage'))
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const sessionCostItem = _makeInfoItem(new PopupMenu.PopupMenuItem(
                `${_('Session:')} $${usage.sessionCost.toFixed(2)}`
            ));
            this.menu.addMenuItem(sessionCostItem);
        }

        // --- Pace Indicator (for this metric) ---
        if (metric) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addPaceBlock(metric.usedPct);
        }

        // --- Settings ---
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem(`\u2699 ${_('Settings')}`);
        settingsItem.connect('activate', () => {
            this._ext.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    /**
     * Format remaining time as "<NH" / "<NM" (rounded up).
     * Returns null if time should not be shown.
     */
    _formatRemainingTime(resetsAt) {
        if (!resetsAt) return null;
        const diffMs = new Date(resetsAt) - Date.now();
        if (diffMs <= 0) return 'now';

        const totalMins = diffMs / 60000;
        const totalHours = diffMs / 3600000;

        if (totalHours >= 1) {
            const rounded = Math.ceil(totalHours);
            return `<${rounded}H`;
        } else if (totalMins >= 1) {
            const rounded = Math.ceil(totalMins);
            return `<${rounded}M`;
        }
        return '<1M';
    }

    /**
     * Update the remaining time labels.
     * In progress-bar: shows "S(<2H)" below the bar (_remainingLabel inside _barGroup).
     * In other styles: shows "<2H" beside the indicator (_remainingLabelInline).
     */
    _updateRemainingLabel(resetsAt) {
        let showTime = false;
        try {
            showTime = this._settings.get_boolean(`${this._prefix}-show-time`);
        } catch (_e) { /* key may not exist */ }

        if (!showTime || !resetsAt) {
            this._remainingLabel.visible = false;
            this._remainingLabelInline.visible = false;
            return;
        }

        const timeText = this._formatRemainingTime(resetsAt);
        if (!timeText) {
            this._remainingLabel.visible = false;
            this._remainingLabelInline.visible = false;
            return;
        }

        const style = this._getEffectiveStyle();
        if (style === 'progress-bar') {
            // Below bar: "S(<2H)"
            this._remainingLabel.text = `${this._metricConfig.shortId}(${timeText})`;
            this._remainingLabel.visible = true;
            this._remainingLabelInline.visible = false;
        } else {
            // Beside indicator: "<2H"
            this._remainingLabelInline.text = timeText;
            this._remainingLabelInline.visible = true;
            this._remainingLabel.visible = false;
        }
    }

    /**
     * Add a full usage block: label + percentage, progress bar, reset countdown.
     */
    _addUsageBlock(title, usedPct, resetsAt) {
        const color = this._getColorForPct(usedPct);
        const bgColor = this._settings.get_string('color-background');

        // Title + percentage row
        const headerItem = _makeInfoItem(new PopupMenu.PopupBaseMenuItem());
        const headerBox = new St.BoxLayout({
            x_expand: true,
            style: 'padding: 0 8px;',
        });

        const titleLabel = new St.Label({
            text: title,
            style_class: 'claude-usage-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(titleLabel);

        const pctLabel = new St.Label({
            text: `${usedPct.toFixed(1)}%`,
            style_class: 'claude-usage-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        pctLabel.set_style(`color: ${color};`);
        headerBox.add_child(pctLabel);

        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        // Progress bar
        const barItem = _makeInfoItem(new PopupMenu.PopupBaseMenuItem());
        const progressBar = new ClaudeProgressBar();
        progressBar.setProgress(usedPct, color, bgColor);
        this._progressBars.push(progressBar);
        barItem.add_child(progressBar);
        this.menu.addMenuItem(barItem);

        // Reset countdown (skip when there is no reset, e.g. context window)
        if (resetsAt) {
            const resetItem = _makeInfoItem(new PopupMenu.PopupMenuItem(
                _formatCountdown(resetsAt)
            ));
            this.menu.addMenuItem(resetItem);
        }
    }

    /**
     * Add an unavailable block for null model data.
     */
    _addUnavailableBlock(title) {
        const headerItem = _makeInfoItem(new PopupMenu.PopupBaseMenuItem());
        const headerBox = new St.BoxLayout({
            x_expand: true,
            style: 'padding: 0 8px;',
        });

        const titleLabel = new St.Label({
            text: title,
            style_class: 'claude-usage-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(titleLabel);

        const valueLabel = new St.Label({
            text: '--',
            style_class: 'claude-usage-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(valueLabel);

        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        const unavailItem = _makeInfoItem(new PopupMenu.PopupMenuItem(_('(not available)')));
        this.menu.addMenuItem(unavailItem);
    }

    /**
     * Add cost / extra usage block.
     */
    _addCostBlock(extraUsage) {
        const costText = `${_('Cost:')} $${extraUsage.usedCredits.toFixed(2)} / $${extraUsage.monthlyLimit.toFixed(2)}`;
        const costItem = _makeInfoItem(new PopupMenu.PopupMenuItem(costText));
        this.menu.addMenuItem(costItem);
    }

    /**
     * Add pace indicator block.
     */
    _addPaceBlock(usedPct) {
        const tier = _getPaceTier(usedPct);
        const paceItem = _makeInfoItem(new PopupMenu.PopupMenuItem(
            `${_('Pace:')} ${_(tier.label)}`
        ));
        paceItem.label.add_style_class_name(tier.styleClass);
        this.menu.addMenuItem(paceItem);
    }

    /**
     * Add stale data warning banner.
     */
    _addStaleWarning() {
        const staleItem = _makeInfoItem(new PopupMenu.PopupMenuItem(`\u26a0 ${_('Data may be stale')}`));
        this.menu.addMenuItem(staleItem);
    }

    _addSection(title) {
        const item = _makeInfoItem(new PopupMenu.PopupMenuItem(title));
        item.label.add_style_class_name('claude-section-header');
        this.menu.addMenuItem(item);
    }

    _getColorForPct(pct) {
        if (pct >= 90)
            return this._settings.get_string('color-critical');
        else if (pct >= 70)
            return this._settings.get_string('color-warning');
        else
            return this._settings.get_string('color-normal');
    }

    _showError(msg) {
        this._label.set_text('\u26a0');
        this._label.set_style(`color: ${this._settings.get_string('color-warning')};`);
        this._icon.set_icon_name('dialog-warning-symbolic');

        this.menu.removeAll();
        this._progressBars = [];

        this._addSection(_('Claude Usage Tracker'));

        // Determine specific error message
        let errorText = msg;
        if (msg.includes('No token'))
            errorText = `\u26a0 ${_('No credentials')}`;
        else if (msg.includes('re-auth') || msg.includes('Re-auth'))
            errorText = `\u26a0 ${_('Re-auth needed')}`;
        else if (msg.includes('Offline') || msg.includes('network'))
            errorText = `\u26a0 ${_('Offline')}`;
        else if (msg.includes('API error') || msg.includes('HTTP'))
            errorText = `\u26a0 ${_('API Error')}`;

        const item = _makeInfoItem(new PopupMenu.PopupMenuItem(errorText));
        this.menu.addMenuItem(item);

        // Show stale data if available
        if (this._lastUsage) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const staleNote = _makeInfoItem(new PopupMenu.PopupMenuItem(_('Showing last known data:')));
            this.menu.addMenuItem(staleNote);
            // Re-render last data below the error
            this._renderUsageData(this._lastUsage, true);
        }

        // Settings at the bottom
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const errSettingsItem = new PopupMenu.PopupMenuItem(`\u2699 ${_('Settings')}`);
        errSettingsItem.connect('activate', () => {
            this._ext.openPreferences();
        });
        this.menu.addMenuItem(errSettingsItem);
    }

    /**
     * Render usage data blocks (used by _showError for stale data).
     * Shows only this metric's data.
     */
    _renderUsageData(usage, stale = false) {
        const metric = usage[this._metricConfig.dataKey];
        if (metric) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const blockTitle = this._metricConfig.dataKey === 'fiveHour'
                ? _('5-Hour Usage')
                : _('7-Day Usage');
            this._addUsageBlock(blockTitle, metric.usedPct, metric.resetsAt);
        }
    }

    /**
     * Resolve the effective indicator style, considering backward compat
     * with the deprecated compact-mode boolean and per-metric keys.
     */
    _getEffectiveStyle() {
        // Try per-metric key first (e.g. session-indicator-style, week-indicator-style)
        let style;
        try {
            style = this._settings.get_string(`${this._prefix}-indicator-style`);
        } catch (_e) {
            // Fall back to global key if per-metric key doesn't exist yet
            style = this._settings.get_string('indicator-style');
        }

        // If indicator-style is still default and compact-mode is enabled, honor it
        if (style === 'percentage' && this._settings.get_boolean('compact-mode'))
            return 'compact';
        return style;
    }

    /**
     * Show/hide top bar widgets based on the active indicator style.
     */
    _updateIndicatorStyle() {
        const style = this._getEffectiveStyle();

        // Hide everything first
        this._icon.visible = false;
        this._navbarLabel.visible = false;
        this._barGroup.visible = false;
        this._navbarCircle.visible = false;
        this._label.visible = false;
        this._remainingLabel.visible = false;
        this._remainingLabelInline.visible = false;

        switch (style) {
        case 'percentage':
            this._icon.visible = true;
            this._label.visible = true;
            break;
        case 'progress-bar':
            this._barGroup.visible = true;
            break;
        case 'circle':
            this._navbarLabel.visible = true;
            this._navbarCircle.visible = true;
            this._label.visible = true;
            break;
        case 'compact':
            this._icon.visible = true;
            break;
        }

        // Update remaining label visibility based on show-time setting
        if (this._lastMetric?.resetsAt) {
            this._updateRemainingLabel(this._lastMetric.resetsAt);
        }

        // Force repaint of custom drawing areas
        if (this._barGroup.visible)
            this._navbarBar.queue_repaint();
        if (this._navbarCircle.visible)
            this._navbarCircle.queue_repaint();
    }

    /**
     * Get the indicator color, respecting color-mode setting.
     * In monochrome mode, returns white.
     */
    _getIndicatorColor(pct) {
        const colorMode = this._settings.get_string('color-mode');
        if (colorMode === 'monochrome')
            return '#ffffff';
        return this._getColorForPct(pct);
    }

    /**
     * Cairo repaint handler for the horizontal navbar progress bar.
     */
    _onNavbarBarRepaint() {
        const cr = this._navbarBar.get_context();
        const [width, height] = this._navbarBar.get_surface_size();
        const radius = height / 2;
        const pct = this._lastPct;

        const colorMode = this._settings.get_string('color-mode');
        let bgR, bgG, bgB, fgR, fgG, fgB;

        if (colorMode === 'monochrome') {
            [bgR, bgG, bgB] = [1.0, 1.0, 1.0];
            [fgR, fgG, fgB] = [1.0, 1.0, 1.0];
        } else {
            const fgColor = this._getColorForPct(pct);
            [fgR, fgG, fgB] = _hexToRgb(fgColor);
            [bgR, bgG, bgB] = _hexToRgb(fgColor);
        }

        // Background track (rounded rect)
        cr.setSourceRGBA(bgR, bgG, bgB, 0.3);
        _drawRoundedRect(cr, 0, 0, width, height, radius);
        cr.fill();

        // Fill (rounded rect)
        const fillWidth = Math.max(height, width * pct / 100);
        if (pct > 0) {
            cr.setSourceRGBA(fgR, fgG, fgB, 1.0);
            _drawRoundedRect(cr, 0, 0, fillWidth, height, radius);
            cr.fill();
        }

        // Time position marker (vertical line showing elapsed time)
        try {
            const showMarker = this._settings.get_boolean('show-time-marker');
            const resetsAt = this._lastMetric?.resetsAt;
            if (showMarker && resetsAt) {
                const remainMs = new Date(resetsAt) - Date.now();
                const elapsedFrac = 1 - Math.max(0, Math.min(1, remainMs / this._metricConfig.windowMs));
                const markerX = elapsedFrac * width;

                if (colorMode === 'monochrome') {
                    cr.setSourceRGBA(0.3, 0.3, 0.3, 0.9);
                } else {
                    cr.setSourceRGBA(1, 1, 1, 0.8);
                }
                cr.setLineWidth(1);
                cr.moveTo(markerX, 1);
                cr.lineTo(markerX, height - 1);
                cr.stroke();
            }
        } catch (_e) {
            // show-time-marker setting may not exist yet
        }

        cr.$dispose();
    }

    /**
     * Cairo repaint handler for the circular ring indicator.
     */
    _onNavbarCircleRepaint() {
        const cr = this._navbarCircle.get_context();
        const [width, height] = this._navbarCircle.get_surface_size();
        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(cx, cy) - 2;
        const lineWidth = NAVBAR_CIRCLE_LINE_WIDTH;
        const pct = this._lastPct;

        const colorMode = this._settings.get_string('color-mode');
        let bgR, bgG, bgB, fgR, fgG, fgB;

        if (colorMode === 'monochrome') {
            [bgR, bgG, bgB] = [1.0, 1.0, 1.0];
            [fgR, fgG, fgB] = [1.0, 1.0, 1.0];
        } else {
            const fgColor = this._getColorForPct(pct);
            [fgR, fgG, fgB] = _hexToRgb(fgColor);
            [bgR, bgG, bgB] = _hexToRgb(fgColor);
        }

        // Background ring
        cr.setSourceRGBA(bgR, bgG, bgB, 0.3);
        cr.setLineWidth(lineWidth);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Progress arc (starts from top, clockwise)
        if (pct > 0) {
            cr.setSourceRGBA(fgR, fgG, fgB, 1.0);
            cr.setLineWidth(lineWidth);
            cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (2 * Math.PI * pct / 100));
            cr.stroke();
        }

        cr.$dispose();
    }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default class ClaudeUsageTrackerExtension extends Extension {
    enable() {
        _ = this.gettext.bind(this);
        this._settings = this.getSettings();
        this._settingsSignals = [];

        // --- Migration: copy old indicator-style to per-metric keys on first run ---
        this._migrateOldSettings();

        // --- Create shared data service ---
        this._dataService = new ClaudeDataService(this);

        // --- Create indicators based on enabled settings ---
        this._sessionIndicator = null;
        this._weekIndicator = null;

        if (this._settings.get_boolean('session-indicator-enabled'))
            this._createSessionIndicator();

        if (this._settings.get_boolean('week-indicator-enabled'))
            this._createWeekIndicator();

        // --- Dynamic enable/disable via settings changes ---
        this._connectSetting('changed::session-indicator-enabled', () => {
            if (this._settings.get_boolean('session-indicator-enabled')) {
                if (!this._sessionIndicator)
                    this._createSessionIndicator();
            } else {
                this._destroySessionIndicator();
            }
        });

        this._connectSetting('changed::week-indicator-enabled', () => {
            if (this._settings.get_boolean('week-indicator-enabled')) {
                if (!this._weekIndicator)
                    this._createWeekIndicator();
            } else {
                this._destroyWeekIndicator();
            }
        });

        // --- Start polling AFTER indicators are subscribed ---
        this._dataService.start();
    }

    disable() {
        // Disconnect settings signals
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

        // Stop and destroy the data service
        this._dataService?.stop();
        this._dataService = null;

        // Destroy both indicators (if they exist)
        this._sessionIndicator?.destroy();
        this._sessionIndicator = null;

        this._weekIndicator?.destroy();
        this._weekIndicator = null;

        this._settings = null;
        _ = (s) => s; // reset to identity
    }

    // --- Indicator creation/destruction helpers ---

    _createSessionIndicator() {
        this._sessionIndicator = new ClaudeMetricIndicator(
            METRIC_CONFIGS.session, this._dataService, this
        );
        Main.panel.addToStatusArea(`${this.uuid}-session`, this._sessionIndicator);

        // If data service already has data, push it immediately
        if (this._dataService.lastUsage)
            this._sessionIndicator._handleDataUpdate(this._dataService.lastUsage);
    }

    _destroySessionIndicator() {
        if (this._sessionIndicator) {
            this._sessionIndicator.destroy();
            this._sessionIndicator = null;
        }
    }

    _createWeekIndicator() {
        this._weekIndicator = new ClaudeMetricIndicator(
            METRIC_CONFIGS.week, this._dataService, this
        );
        Main.panel.addToStatusArea(`${this.uuid}-week`, this._weekIndicator);

        // If data service already has data, push it immediately
        if (this._dataService.lastUsage)
            this._weekIndicator._handleDataUpdate(this._dataService.lastUsage);
    }

    _destroyWeekIndicator() {
        if (this._weekIndicator) {
            this._weekIndicator.destroy();
            this._weekIndicator = null;
        }
    }

    // --- Settings helper ---

    _connectSetting(signal, callback) {
        const id = this._settings.connect(signal, callback);
        this._settingsSignals.push(id);
    }

    // --- Migration ---

    /**
     * One-time migration from old `indicator-style` to per-metric keys.
     * If `session-indicator-style` has no user-set value but `indicator-style` does,
     * copy the old value to both per-metric keys.
     */
    _migrateOldSettings() {
        try {
            const sessionStyleValue = this._settings.get_user_value('session-indicator-style');
            if (sessionStyleValue !== null)
                return; // already set by user — no migration needed

            const oldStyleValue = this._settings.get_user_value('indicator-style');
            if (oldStyleValue === null)
                return; // old key was never customized — use schema defaults

            // Copy old style to both per-metric keys
            const oldStyle = this._settings.get_string('indicator-style');
            this._settings.set_string('session-indicator-style', oldStyle);
            this._settings.set_string('week-indicator-style', oldStyle);
        } catch (_e) {
            // Migration is best-effort — don't break enable()
            console.log(`[Claude Tracker] Settings migration skipped: ${_e.message}`);
        }
    }
}
