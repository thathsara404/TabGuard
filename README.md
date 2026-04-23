# TabGuard – Browser Time Limit & Eye Care Extension

> ⏱ Set active-time limits on websites, enforce away periods, and protect your eyes with built-in look-away reminders.

---

## Features

| Feature | Description |
|---|---|
| **Domain Rules** | Add any domain (e.g. `facebook.com`) with its own config |
| **Active Time Tracking** | Only counts time when the tab is **focused** |
| **Time Limit** | Set a limit in minutes; tab auto-closes when reached |
| **Custom Closure Message** | Your own message shown in the 5-second countdown overlay |
| **Away Period** | After closure, the domain is blocked for a configurable time with a live countdown |
| **Away Progress Bar** | Per-domain settings show separate session and away-period progress bars |
| **👁 Look Away Reminder** | Periodic full-screen eye-break overlay with animated exercises (20-20-20 rule) |
| **Live Popup** | Animated ring timer showing time used / remaining |
| **Session Reset** | Reset session time manually from popup or settings |
| **Import / Export** | Backup and restore all rules as JSON |
| **Cross-browser** | Chrome, Edge (MV3) · Firefox (MV2) |

---

## Installation

### Chrome / Edge (Recommended)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right toggle)
3. Click **"Load unpacked"**
4. Select the `browserext` folder (this folder)
5. The TabGuard icon will appear in your toolbar

> ✅ The `manifest.json` in the root is the **Chrome/Edge MV3** manifest.

---

### Firefox

1. Open `about:debugging` in Firefox
2. Click **"This Firefox"**
3. Click **"Load Temporary Add-on…"**
4. Navigate to the `browserext` folder and select **`manifest-firefox.json`**

> ⚠️ For permanent installation in Firefox, you need to:
> - Rename `manifest-firefox.json` → `manifest.json` (backup the original first)
> - Sign the extension via [addons.mozilla.org](https://addons.mozilla.org/developers/) or use Firefox Developer Edition with `xpinstall.signatures.required = false` in `about:config`

---

## How to Use

### 1. Open Settings
Click the TabGuard icon → **Settings** button, or right-click the icon → **Extension Options**.

### 2. Add a Domain Rule
Fill in the form:
- **Domain**: e.g. `facebook.com` (subdomains like `m.facebook.com` are matched automatically)
- **Time Limit**: Active (focused) minutes before the tab is closed
- **Away Period**: Minutes to block the domain after closure (0 = no block)
- **Closure Message**: What to show in the countdown overlay

### 3. Tracking
- The extension only tracks time when the tab is **active and focused**
- Switching tabs or minimizing the browser **pauses** tracking
- The popup shows a **live ring timer** for the current tab
- Each domain rule shows two progress bars — one for the session, one for the active away period

### 4. When the Limit is Reached
1. A full-screen overlay appears with your custom message
2. A 5-second countdown runs
3. The tab closes automatically and the session resets to **zero**
4. If an Away Period is configured, any attempt to visit that domain shows a **blocked page** with a live MM:SS countdown

### 5. Managing Sessions
- Click 🔄 on a domain in Settings or the Popup to **reset** the session timer
- Click 🔓 to **clear an active away period** early
- Toggle the switch to **pause tracking** for a domain without deleting the rule

### 6. 👁 Look Away Reminder (Eye Care)
Protect your eyes during long screen sessions:

1. Scroll to the **Look Away Reminder** section in Settings
2. **Toggle it on** using the switch in the section header
3. Set your **interval** (how often — default 20 minutes) and **duration** (how long the overlay stays — default 20 seconds)
4. Click **Save**
5. Click **👁 Preview** to test the overlay immediately on the current tab

When the reminder fires, a beautiful animated overlay appears with one of five rotating eye exercises:

| Exercise | What to do |
|---|---|
| 🏔️ **20-20-20 Rule** | Look at an object ~6 metres (20 ft) away |
| 👁️ **Intentional Blinking** | Blink rapidly 10-15× to refresh your tear film |
| 🔄 **Eye Rolling** | Roll eyes clockwise then counter-clockwise |
| ✋ **Palming** | Cup warm hands over closed eyes in darkness |
| 🎯 **Focus Shifting** | Alternate focus between a near thumb and far object |

The overlay includes:
- An **animated SVG eye** matching the exercise type
- **Step-by-step instructions** numbered 1–4
- A **depleting countdown ring** that ticks down to zero
- A **Skip** button to dismiss early

> 💡 The 20-20-20 rule is clinically recommended for reducing Computer Vision Syndrome (CVS) / digital eye strain.

---

## File Structure

```
browserext/
├── manifest.json              # Chrome / Edge (MV3)
├── manifest-firefox.json      # Firefox (MV2)
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── background/
│   ├── background.js          # Chrome/Edge service worker
│   └── background-ff.js       # Firefox event page
├── content/
│   └── content.js             # Content script (minimal)
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── settings/
    ├── settings.html
    ├── settings.css
    └── settings.js
```

---

## Privacy

- **All data is stored locally** using the browser's `storage.local` API
- **No data is ever sent to any server**
- No analytics, no tracking

---

## Permissions Explained

| Permission | Why |
|---|---|
| `tabs` | To detect which tab/domain is active |
| `storage` | To save your rules, session data, and look-away config locally |
| `scripting` | To inject the closure overlay, blocked page, and eye-break reminder |
| `alarms` | To fire the look-away reminder on a reliable periodic schedule |
| `notifications` | Reserved for future notification support |
| `<all_urls>` | To monitor all sites you've added rules for |
