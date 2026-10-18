// clippit-ocr <image>: the text macOS Vision sees in an image, one line per text run:
// "x y w h<TAB>text", the box as fractions of the image with the origin at the top left.
// Built once by lib/zone.mjs with swiftc into Clippit's config folder.

import AppKit
import Vision

guard CommandLine.arguments.count > 1,
      let image = NSImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["sv-SE", "en-US", "de-DE", "fr-FR", "es-ES"]
do { try VNImageRequestHandler(cgImage: cg).perform([request]) } catch {
  FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
  exit(1)
}
for o in request.results ?? [] {
  guard let c = o.topCandidates(1).first else { continue }
  let b = o.boundingBox
  print(String(format: "%.3f %.3f %.3f %.3f", b.minX, 1 - b.maxY, b.width, b.height) + "\t" + c.string)
}
