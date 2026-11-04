// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Ingle",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Ingle", path: "Sources/Ingle")
    ]
)
