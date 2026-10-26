// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "GroundControlMenu",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "GroundControlMenu", targets: ["GroundControlMenu"]),
  ],
  targets: [
    .executableTarget(
      name: "GroundControlMenu",
      path: "Sources/GroundControlMenu"
    ),
  ]
)
