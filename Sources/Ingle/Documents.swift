import Foundation
import AppKit
import PDFKit
import Vision
import ImageIO
import UniformTypeIdentifiers

// MARK: - Documents → text

/// Turns documents into plain text the model can read: PDF, Word, RTF, OpenDocument, HTML, spreadsheets and text.
enum DocumentReader {
    static let limit = 60_000

    static func isImage(_ url: URL) -> Bool {
        guard let type = UTType(filenameExtension: url.pathExtension.lowercased()) else { return false }
        return type.conforms(to: .image)
    }

    /// Text of any supported document, or nil if it isn't readable as text.
    static func text(at url: URL) -> String? {
        let ext = url.pathExtension.lowercased()
        var out: String?
        switch ext {
        case "pdf":
            out = pdf(url)
        case "docx", "doc", "rtf", "rtfd", "odt", "html", "htm", "webarchive", "wordml":
            out = attributed(url)
        case "xlsx":
            out = xlsx(url)
        case "pages", "numbers", "key":
            out = iwork(url)
        default:
            if let t = try? String(contentsOf: url, encoding: .utf8) { out = t }
            else if let t = try? String(contentsOf: url, encoding: .isoLatin1), !looksBinary(url) { out = t }
        }
        guard var text = out?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        if text.count > limit { text = String(text.prefix(limit)) + "\n…(trimmed — the document is longer)" }
        return text
    }

    private static func pdf(_ url: URL) -> String? {
        guard let doc = PDFDocument(url: url) else { return nil }
        var pages: [String] = []
        for i in 0..<doc.pageCount {
            if let s = doc.page(at: i)?.string, !s.isEmpty { pages.append("— Page \(i + 1) —\n" + s) }
        }
        if pages.isEmpty { return "(This PDF has \(doc.pageCount) pages but no text layer — it may be scanned. Attach it as an image to read it.)" }
        return "PDF, \(doc.pageCount) pages\n\n" + pages.joined(separator: "\n\n")
    }

    private static func attributed(_ url: URL) -> String? {
        (try? NSAttributedString(url: url, options: [:], documentAttributes: nil))?.string
    }

    /// Minimal .xlsx reader: shared strings + the first few sheets as tab-separated rows.
    private static func xlsx(_ url: URL) -> String? {
        func entry(_ name: String) -> String? { unzip(url, name) }
        let shared: [String] = {
            guard let xml = entry("xl/sharedStrings.xml") else { return [] }
            return matches(#"<si>(.*?)</si>"#, in: xml).map { si in
                matches(#"<t[^>]*>(.*?)</t>"#, in: si).joined().xmlUnescaped
            }
        }()
        var sheets: [String] = []
        for n in 1...5 {
            guard let xml = entry("xl/worksheets/sheet\(n).xml") else { break }
            var rows: [String] = []
            for row in matches(#"<row[^>]*>(.*?)</row>"#, in: xml).prefix(2000) {
                var cells: [String] = []
                for cell in matchGroups(#"<c([^>]*)>(.*?)</c>"#, in: row) {
                    let attrs = cell[0], inner = cell[1]
                    let value = matches(#"<v>(.*?)</v>"#, in: inner).first
                        ?? matches(#"<t[^>]*>(.*?)</t>"#, in: inner).first ?? ""
                    if attrs.contains("t=\"s\""), let i = Int(value), i < shared.count { cells.append(shared[i]) }
                    else { cells.append(value.xmlUnescaped) }
                }
                rows.append(cells.joined(separator: "\t"))
            }
            sheets.append("— Sheet \(n) —\n" + rows.joined(separator: "\n"))
        }
        return sheets.isEmpty ? nil : sheets.joined(separator: "\n\n")
    }

    /// Pages/Numbers/Keynote: newer files are zip bundles; try the built-in preview text, else ask for a PDF.
    private static func iwork(_ url: URL) -> String? {
        if let pdfData = unzipData(url, "QuickLook/Preview.pdf"), let doc = PDFDocument(data: pdfData) {
            let text = (0..<doc.pageCount).compactMap { doc.page(at: $0)?.string }.joined(separator: "\n\n")
            if !text.isEmpty { return text }
        }
        return "(Couldn't read this \(url.pathExtension) file directly. Export it as PDF (File ▸ Export To ▸ PDF) and attach that.)"
    }

    private static func unzip(_ url: URL, _ entry: String) -> String? {
        unzipData(url, entry).flatMap { String(data: $0, encoding: .utf8) }
    }

    private static func unzipData(_ url: URL, _ entry: String) -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        p.arguments = ["-p", url.path, entry]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 && !data.isEmpty ? data : nil
    }

    private static func looksBinary(_ url: URL) -> Bool {
        guard let h = try? FileHandle(forReadingFrom: url) else { return true }
        defer { try? h.close() }
        let head = (try? h.read(upToCount: 4096)) ?? Data()
        return head.contains(0)
    }

    private static func matches(_ pattern: String, in s: String) -> [String] {
        matchGroups(pattern, in: s).compactMap { $0.last }
    }

    private static func matchGroups(_ pattern: String, in s: String) -> [[String]] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { m in
            (1..<m.numberOfRanges).map { i in
                let r = m.range(at: i)
                return r.location == NSNotFound ? "" : ns.substring(with: r)
            }
        }
    }
}

private extension String {
    var xmlUnescaped: String {
        self.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}

// MARK: - Images (HEIC, PNG, JPEG, …)

/// Images are converted to JPEG (≤ 1600 px) and kept in Application Support/Ingle/images, so chats.json stays small.
enum ImageStore {
    static var folder: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Ingle/images", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Converts any image ImageIO can read (including HEIC) and saves it. Returns the stored file name.
    static func importImage(from url: URL, maxPixel: Int = 1600) -> String? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return store(src, maxPixel: maxPixel)
    }

    static func importImage(data: Data, maxPixel: Int = 1600) -> String? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return store(src, maxPixel: maxPixel)
    }

    private static func store(_ src: CGImageSource, maxPixel: Int) -> String? {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,   // respects iPhone rotation
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let name = UUID().uuidString + ".jpg"
        let out = folder.appendingPathComponent(name)
        guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? name : nil
    }

    static func url(_ name: String) -> URL { folder.appendingPathComponent(name) }

    static func base64(_ name: String) -> String? { (try? Data(contentsOf: url(name)))?.base64EncodedString() }

    static func nsImage(_ name: String) -> NSImage? { NSImage(contentsOf: url(name)) }

    /// Reads the text in an image with the Vision framework (for models that can't see images).
    static func recognizeText(_ name: String) async -> String {
        guard let src = CGImageSourceCreateWithURL(url(name) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return "" }
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = true
                try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
                let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                continuation.resume(returning: lines.joined(separator: "\n"))
            }
        }
    }
}

// MARK: - Attachments from files

extension Attachment {
    /// Makes an attachment from any file: images are converted (HEIC too), documents and code become text.
    static func from(_ url: URL) -> Attachment? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if DocumentReader.isImage(url) {
            guard let name = ImageStore.importImage(from: url) else { return nil }
            return Attachment(name: url.lastPathComponent, text: "", imageFile: name)
        }
        guard let text = DocumentReader.text(at: url) else { return nil }
        return Attachment(name: url.lastPathComponent, text: text)
    }
}
