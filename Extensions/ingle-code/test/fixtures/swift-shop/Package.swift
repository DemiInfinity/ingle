// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Shop",
    targets: [
        .target(name: "Shop", path: "Sources/Shop"),
        .testTarget(name: "ShopTests", dependencies: ["Shop"], path: "Tests/ShopTests"),
    ]
)
