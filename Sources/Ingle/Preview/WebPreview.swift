import SwiftUI
import WebKit
import PDFKit
import UniformTypeIdentifiers

// Safety for previews (HTML runs code):
// - every tab has its own WKWebView with a non-persistent data store, so nothing is kept or shared;
// - a content rule list blocks every http(s)/ws(s)/ftp/file request, and every response carries a CSP that only
//   allows this app's own scheme, so a page can't call home or load trackers (and works offline);
// - files are served through `ingle-preview://` from the file's own folder only (the renderer's files come from
//   the app), so a page can't read anything else on the Mac;
// - no pop-ups, no message bridge for HTML pages (the renderer gets a tiny one: open a link, tick a box).

enum PreviewScheme {
    static let name = "ingle-preview"
    /// The renderer page (Support/preview, copied into Ingle.app by build.sh).
    static let app = "ingle-preview://app/"
    /// The previewed file's folder.
    static let file = "ingle-preview://file/"

    static var rendererFolder: URL {
        if let res = Bundle.main.resourceURL?.appendingPathComponent("Preview"),
           FileManager.default.fileExists(atPath: res.appendingPathComponent("index.html").path) { return res }
        // `swift run` from the repository: use the source folder.
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Support/preview")
    }

    static let rendererCSP = "default-src 'none'; script-src ingle-preview:; style-src ingle-preview: 'unsafe-inline'; img-src ingle-preview: data: blob:; font-src ingle-preview: data:; media-src ingle-preview:"
    /// Pages may use their own inline scripts and styles, but only this scheme (no network).
    static let pageCSP = "default-src ingle-preview: data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'"
}

/// Serves `ingle-preview://app/…` from the renderer folder and `ingle-preview://file/…` from one folder, never above it.
final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    private let folder: URL

    init(folder: URL) {
        self.folder = folder.standardizedFileURL.resolvingSymlinksInPath()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let host = url.host else { return fail(task) }
        let rel: String = String((url.path.removingPercentEncoding ?? url.path).drop(while: { $0 == "/" }))
        let root: URL = host == "app" ? PreviewScheme.rendererFolder.standardizedFileURL.resolvingSymlinksInPath() : folder
        guard host == "app" || host == "file" else { return fail(task) }
        let target: URL = root.appendingPathComponent(rel).standardizedFileURL.resolvingSymlinksInPath()
        guard target.path.hasPrefix(root.path + "/"), var data = try? Data(contentsOf: target) else { return fail(task, status: 404) }
        if host == "app" && rel == "index.html" {
            let page: String = String(decoding: data, as: UTF8.self)
                .replacingOccurrences(of: "{{CSP}}", with: PreviewScheme.rendererCSP)
                .replacingOccurrences(of: "{{ROOT}}", with: PreviewScheme.app)
            data = Data(page.utf8)
        }
        let type: String = UTType(filenameExtension: target.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let text: Bool = type.hasPrefix("text/") || type.contains("javascript") || type.contains("json") || type.contains("xml")
        let headers: [String: String] = [
            "Content-Type": text ? type + "; charset=utf-8" : type,
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
            "Content-Security-Policy": host == "app" ? PreviewScheme.rendererCSP : PreviewScheme.pageCSP,
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)
            ?? URLResponse(url: url, mimeType: type, expectedContentLength: data.count, textEncodingName: nil)
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, status: Int = 400) {
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: status == 404 ? NSURLErrorFileDoesNotExist : NSURLErrorBadURL))
    }
}

/// The compiled "block the network" rule list, shared by every preview.
@MainActor
enum PreviewRules {
    private static var compiled: WKContentRuleList?
    private static var waiting: [CheckedContinuation<WKContentRuleList?, Never>] = []
    private static var compiling = false

    /// Content-blocker regexes have no "|", so one rule per scheme.
    static let json = """
    [{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}}]
    """

    static func get() async -> WKContentRuleList? {
        if let compiled { return compiled }
        return await withCheckedContinuation { c in
            waiting.append(c)
            guard !compiling else { return }
            compiling = true
            WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "ingle-preview-no-network", encodedContentRuleList: json) { list, error in
                MainActor.assumeIsolated {
                    if let error { NSLog("Ingle preview rules: %@", error.localizedDescription) }
                    compiled = list
                    compiling = false
                    let all = waiting
                    waiting = []
                    all.forEach { $0.resume(returning: list) }
                }
            }
        }
    }
}

/// Keeps each tab's web view alive while you switch tabs (so it doesn't reload), until the tab closes.
@MainActor
enum WebPreviewCache {
    private static var controllers: [UUID: PreviewWebController] = [:]

    static func controller(for tab: PreviewTab) -> PreviewWebController {
        if let c = controllers[tab.id] { return c }
        let c = PreviewWebController(tab: tab)
        controllers[tab.id] = c
        return c
    }

    static func drop(_ id: UUID) {
        controllers.removeValue(forKey: id)?.tearDown()
    }
}

/// Avoids the retain cycle WKUserContentController → handler → web view.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: PreviewWebController?
    init(_ target: PreviewWebController) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { target?.received(message.body) }
    }
}

@MainActor
final class PreviewWebController: NSObject, WKNavigationDelegate, WKUIDelegate {
    let tab: PreviewTab
    let webView: WKWebView
    private let renderer: Bool
    private var ready = false
    private var shown: (stamp: Int, js: Bool)?
    private(set) var blocked: String?

    init(tab: PreviewTab) {
        self.tab = tab
        self.renderer = tab.kind.usesRenderer
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(PreviewSchemeHandler(folder: tab.folder), forURLScheme: PreviewScheme.name)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isElementFullscreenEnabled = false
        config.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        if renderer { config.userContentController.add(WeakMessageHandler(self), name: "ingle") }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isInspectable = true   // Develop → Ingle in Safari, or right-click → Inspect Element
        // The renderer paints the Ember background itself; HTML pages keep the usual white.
        if renderer { webView.setValue(false, forKey: "drawsBackground") }
        Task { [weak self] in
            let rules: WKContentRuleList? = await PreviewRules.get()
            guard let self else { return }
            guard let rules else {
                self.blocked = "Previews are off: Ingle couldn’t set up its network block."
                tab.problem = self.blocked
                return
            }
            self.webView.configuration.userContentController.add(rules)
            self.load()
        }
    }

    func tearDown() {
        webView.stopLoading()
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
    }

    private var pageURL: URL {
        if renderer { return URL(string: PreviewScheme.app + "index.html")! }
        let name: String = tab.name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tab.name
        return URL(string: PreviewScheme.file + name)!
    }

    private func load() {
        ready = false
        shown = (tab.stamp, tab.javaScript)
        webView.load(URLRequest(url: pageURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
    }

    /// Called when SwiftUI redraws: re-render or reload if the file (or the JavaScript switch) changed.
    func update() {
        guard blocked == nil, let shown else { return }
        if renderer {
            if ready && shown.stamp != tab.stamp { render() }
        } else if shown.stamp != tab.stamp || shown.js != tab.javaScript {
            load()
        }
    }

    private func render() {
        shown = (tab.stamp, tab.javaScript)
        let lang: String = tab.url.pathExtension.lowercased()
        let payload: [String: Any] = [
            "kind": tab.kind.rawValue, "name": tab.name, "text": tab.kind.isText && tab.kind != .svg ? tab.text : "",
            "base": PreviewScheme.file, "lang": lang, "editable": FileManager.default.isWritableFile(atPath: tab.url.path),
            "chrome": "mac", "stamp": String(tab.stamp),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let json: String = String(decoding: data, as: UTF8.self)
        webView.evaluateJavaScript("inglePreview.render(\(json))", completionHandler: nil)
    }

    /// Messages from the renderer page (never from HTML pages, which have no handler).
    func received(_ body: Any) {
        guard let msg = body as? [String: Any], let type = msg["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            render()
        case "toggle":
            guard let index = msg["index"] as? Int, let checked = msg["checked"] as? Bool else { return }
            tab.toggleTask(index, checked: checked)
        case "open":
            guard let href = msg["href"] as? String else { return }
            openLink(href)
        default:
            break
        }
    }

    /// A clicked link: local files open in a new tab; web links only open in your browser if you say so.
    private func openLink(_ href: String) {
        if let url = URL(string: href), let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) {
            let alert = NSAlert()
            alert.messageText = "Open this link in your browser?"
            alert.informativeText = href
            alert.addButton(withTitle: "Open")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
            return
        }
        guard let file = PreviewStore.resolve(href, base: tab.folder) else { return }
        Preview.open(file)
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        preferences.allowsContentJavaScript = renderer || tab.javaScript
        guard let url = action.request.url else { return decisionHandler(.cancel, preferences) }
        let scheme: String = url.scheme?.lowercased() ?? ""
        let main: Bool = action.targetFrame?.isMainFrame ?? true
        if !main {
            // Frames inside a page: its own files, or inline content. Never the network.
            decisionHandler(["ingle-preview", "about", "data", "blob"].contains(scheme) ? .allow : .cancel, preferences)
            return
        }
        if scheme == PreviewScheme.name && sameDocument(url, pageURL) {
            decisionHandler(.allow, preferences)
            return
        }
        decisionHandler(.cancel, preferences)
        // A link the user clicked in an HTML page: a local file opens in a new tab, the web asks first.
        guard action.navigationType == .linkActivated else { return }
        if scheme == PreviewScheme.name, url.host == "file" {
            let rel: String = String((url.path.removingPercentEncoding ?? url.path).drop(while: { $0 == "/" }))
            Preview.open(tab.folder.appendingPathComponent(rel))
        } else {
            openLink(url.absoluteString)
        }
    }

    private func sameDocument(_ a: URL, _ b: URL) -> Bool {
        var x = URLComponents(url: a, resolvingAgainstBaseURL: false)
        var y = URLComponents(url: b, resolvingAgainstBaseURL: false)
        x?.fragment = nil; x?.query = nil
        y?.fragment = nil; y?.query = nil
        return x?.url == y?.url
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil   // no pop-ups
    }

}

/// A tab's web view in SwiftUI (the view itself is kept by WebPreviewCache).
struct PreviewWebView: NSViewRepresentable {
    let tab: PreviewTab
    /// Read here so SwiftUI redraws when they change.
    let stamp: Int
    let javaScript: Bool

    func makeNSView(context: Context) -> NSView {
        let box = NSView()
        attach(to: box)
        return box
    }

    func updateNSView(_ box: NSView, context: Context) {
        attach(to: box)
        WebPreviewCache.controller(for: tab).update()
    }

    private func attach(to box: NSView) {
        let web: WKWebView = WebPreviewCache.controller(for: tab).webView
        guard web.superview !== box else { return }
        web.removeFromSuperview()
        box.subviews.forEach { $0.removeFromSuperview() }
        web.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: box.leadingAnchor), web.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            web.topAnchor.constraint(equalTo: box.topAnchor), web.bottomAnchor.constraint(equalTo: box.bottomAnchor),
        ])
    }
}

/// PDFs, with PDFKit.
struct PreviewPDFView: NSViewRepresentable {
    let url: URL
    let stamp: Int

    final class Coordinator { var stamp = -1 }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.backgroundColor = NSColor(Ember.bg)
        return v
    }

    func updateNSView(_ v: PDFView, context: Context) {
        guard context.coordinator.stamp != stamp || v.document?.documentURL != url else { return }
        context.coordinator.stamp = stamp
        v.document = PDFDocument(url: url)
    }
}

