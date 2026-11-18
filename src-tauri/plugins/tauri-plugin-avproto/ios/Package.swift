// swift-tools-version:5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.
// 5.9 起 PackageDescription 才有 .iOS(.v15)（Muse 2026-11-19：5.3 清单 API
// 无 v15，CI 首跑在此红过）；应用最低系统 15.0 与此对齐。

import PackageDescription

let package = Package(
    name: "tauri-plugin-avproto",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v15),
    ],
    products: [
        // Products define the executables and libraries a package produces, and make them visible to other packages.
        .library(
            name: "tauri-plugin-avproto",
            type: .static,
            targets: ["tauri-plugin-avproto"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        // Targets are the basic building blocks of a package. A target can define a module or a test suite.
        // Targets can depend on other targets in this package, and on products in packages this package depends on.
        .target(
            name: "tauri-plugin-avproto",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
