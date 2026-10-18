# Clippit Says No

Clippit's browser extension. It does three things:

- **Says no to cookie popups.** Consent-O-Matic's engine and rules turn down consent popups on known
  consent managers, and Clippit's own pass (`src/clippitFallback.js`) handles the rest: the reject or
  "only necessary" button of any cookie box, else its settings with everything optional switched off,
  else it closes or hides the box. It never presses accept. All rules ship inside the extension
  (`rules/` from Consent-O-Matic, `rules-clippit/` for our own); nothing is fetched or reported anywhere.
  The toolbar popup has the on/off switch.
- **Is Clippit's hands in the browser.** It keeps a WebSocket to the Clippit app on 127.0.0.1:41178
  (`src/clippitBridge.js` ↔ `lib/bridge.mjs`), so Mark a zone can read the page under the zone without
  "Allow JavaScript from Apple Events". Turn that Safari/Chrome setting **off**: it let any app with
  Automation rights run JavaScript in your logged-in tabs.
- **Watches your localhost pages** (localhost, 127.0.0.1, *.localhost, *.test, nothing else). When a
  Claude session changed files in the project a localhost tab is served from, Clippit reloads that tab;
  when such a page throws (uncaught errors, unhandled rejections, console.error), Clippy says so and
  offers to send the error to Claude in that project. Both are switches under Browser in Clippit's menu.

The first Clippit that answers pairs with the extension (trust on first use); after that Clippit has to
prove it holds the key on every connection, or the extension does nothing it asks. "Pair with Clippit
again" in the popup starts over. On its own the extension only acts on cookie popups; everything else it
does for Clippit is either on your localhost pages or starts with something you did (marking a zone).

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
and most of `src/` are theirs; `src/clippit*.js`, `src/zoneProbe.js`, the build and the changes to the
popup, settings and background are Clippit's.
