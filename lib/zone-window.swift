// clippit-window <pid>: the title and frame of that app's front-most window on screen, as
// "x,y,width,height<TAB>title". Reads the window list, so it needs Screen Recording (which Mark a zone
// already has for its screenshot), not Accessibility. Built once by lib/zone.mjs with swiftc.

import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) else { exit(1) }
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {                                     // front to back
  guard (w[kCGWindowOwnerPID as String] as? Int) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
        let b = w[kCGWindowBounds as String] as? [String: Double],
        (b["Width"] ?? 0) > 80, (b["Height"] ?? 0) > 60 else { continue }
  let title = (w[kCGWindowName as String] as? String) ?? ""
  print("\(Int(b["X"] ?? 0)),\(Int(b["Y"] ?? 0)),\(Int(b["Width"] ?? 0)),\(Int(b["Height"] ?? 0))\t\(title)")
  exit(0)
}
exit(2)
