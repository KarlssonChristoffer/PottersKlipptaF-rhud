# Clippit Says No

Clippit's browser extension: it says no to cookie popups for you, in Safari and Chromium browsers.

- Consent-O-Matic's engine and its rules (`rules/`) turn down consent popups from known consent managers.
- On pages no rule knows, Clippit's own pass (`src/clippitFallback.js`) looks for the reject or "only
  necessary" button of a cookie box; else it opens the box's settings, switches every optional purpose off
  and saves; else it closes or hides the box and lets the page scroll again. It never presses accept.
- All rules ship inside the extension. Nothing is fetched from anyone's server, and nothing is reported.
  (You can still add a rule list by URL in the settings page, if you want one.)
- The toolbar popup has the on/off switch, and a per-site switch.

It doesn't talk to the Clippit app; you can use it without Clippit running.

## Build

```
cd extension
npm install
npm run build          # build/safari and build/chromium
```

Clippy's face becomes the icon when Clippit's frames have been decoded (`npm run setup` in the Clippit
folder); otherwise it keeps Consent-O-Matic's icon.

## Install

**Chrome, Brave, Edge, Arc:** `chrome://extensions` → Developer mode → Load unpacked → `extension/build/chromium`.

**Safari 26 or later, no Xcode:** Safari → Settings → Advanced → "Show features for web developers";
then Settings → Developer → "Add Temporary Extension…" → pick `extension/build/safari`. Safari drops a
temporary extension when it quits, so you add it again after that.

**Safari, to keep it installed:** needs Xcode (free in the App Store). Then

```
xcrun safari-web-extension-packager extension/build/safari --project-location extension/xcode \
  --app-name "Clippit Says No" --bundle-identifier se.karlsson.clippit.saysno --macos-only --no-open --force
xcodebuild -project "extension/xcode/Clippit Says No/Clippit Says No.xcodeproj" -scheme "Clippit Says No (macOS)" \
  -configuration Release CONFIGURATION_BUILD_DIR="$PWD/extension/xcode/build" build
open "extension/xcode/build/Clippit Says No.app"
```

and turn it on in Safari → Settings → Extensions. Without a developer account the app is unsigned, so
Safari also needs Develop → "Allow Unsigned Extensions" (once per Safari launch).

## Credits

Built on [Consent-O-Matic](https://github.com/cavi-au/Consent-O-Matic) by Janus Bager Kristensen and Rolf
Bagge, CAVI, Aarhus University, under the MIT license (`LICENSE-Consent-O-Matic`). The rules in `rules/`
and most of `src/` are theirs; `src/clippitFallback.js`, the build and the changes to the popup, settings
and background are Clippit's.
