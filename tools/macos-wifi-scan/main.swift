#!/usr/bin/env swift

import Foundation
import CoreWLAN
import CryptoKit

// MARK: - Network Model

struct WiFiNetwork: Codable {
    let ssid: String
    let rssi: Int
    let noise: Int
    let channel: Int
    let bssid: String
}

// MARK: - Pseudo-BSSID Generator

func sha256PseudoBSSID(ssid: String, channel: Int) -> String {
    let input = "\(ssid):\(channel)"
    guard let data = input.data(using: .utf8) else {
        return "000000000000"
    }
    let hash = SHA256.hash(data: data)
    let hashString = hash.map { String(format: "%02x", $0) }.joined()
    return String(hashString.prefix(12))
}

// MARK: - JSON Helpers

func escapeJSON(_ s: String) -> String {
    return s
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
}

func networkToJSON(_ n: WiFiNetwork) -> String {
    return [
        "  {",
        "    \"ssid\": \"\(escapeJSON(n.ssid))\",",
        "    \"rssi\": \(n.rssi),",
        "    \"noise\": \(n.noise),",
        "    \"channel\": \(n.channel),",
        "    \"bssid\": \"\(n.bssid)\"",
        "  }"
    ].joined(separator: "\n")
}

func printJSONArray(_ networks: [WiFiNetwork]) {
    print("[")
    for (i, n) in networks.enumerated() {
        print(networkToJSON(n), terminator: i == networks.count - 1 ? "\n" : ",\n")
    }
    print("]")
}

func printJSONObject(_ dict: [String: Any]) {
    let pairs = dict.map { key, value -> String in
        if let s = value as? String {
            return "  \"\(key)\": \"\(escapeJSON(s))\""
        } else if let b = value as? Bool {
            return "  \"\(key)\": \(b)"
        } else if let n = value as? Int {
            return "  \"\(key)\": \(n)"
        }
        return "  \"\(key)\": null"
    }
    print("{\n" + pairs.joined(separator: ",\n") + "\n}")
}

// MARK: - WiFi Scanner

@available(macOS 10.15, *)
func performScan() -> [WiFiNetwork]? {
    let client = CWWiFiClient.shared()
    guard let interface = client.interface() else {
        return nil
    }

    let networks: Set<CWNetwork>
    do {
        // Pass nil SSID to scan all visible networks
        networks = try interface.scanForNetworks(withSSID: nil)
    } catch {
        return nil
    }

    return networks.map { network in
        let bssid: String
        if let rawBSSID = network.bssid, !rawBSSID.isEmpty {
            bssid = rawBSSID
        } else {
            let ssidStr = network.ssid ?? "unknown"
            let ch = network.wlanChannel?.channelNumber ?? 0
            bssid = sha256PseudoBSSID(ssid: ssidStr, channel: ch)
        }
        return WiFiNetwork(
            ssid: network.ssid ?? "",
            rssi: Int(network.rssiValue),
            noise: Int(network.noiseMeasurement),
            channel: network.wlanChannel?.channelNumber ?? 0,
            bssid: bssid
        )
    }
}

// MARK: - Connected Network

@available(macOS 10.15, *)
func getConnectedNetwork() -> WiFiNetwork? {
    let client = CWWiFiClient.shared()
    guard let interface = client.interface() else {
        return nil
    }

    let currentSSID = interface.ssid()
    guard let currentSSID = currentSSID, !currentSSID.isEmpty else {
        return nil
    }

    guard let cached = interface.cachedScanResults() else {
        return nil
    }

    guard let network = cached.first(where: { $0.ssid == currentSSID }) else {
        return nil
    }

    let bssid: String
    if let rawBSSID = network.bssid, !rawBSSID.isEmpty {
        bssid = rawBSSID
    } else {
        bssid = sha256PseudoBSSID(ssid: currentSSID, channel: network.wlanChannel?.channelNumber ?? 0)
    }

    return WiFiNetwork(
        ssid: currentSSID,
        rssi: Int(network.rssiValue),
        noise: Int(network.noiseMeasurement),
        channel: network.wlanChannel?.channelNumber ?? 0,
        bssid: bssid
    )
}

// MARK: - Main

let args = CommandLine.arguments

if args.contains("--probe") {
    if #available(macOS 10.15, *) {
        let client = CWWiFiClient.shared()
        if client.interface() != nil {
            print("{\"available\": true}")
            exit(0)
        }
    }
    print("{\"available\": false}")
    exit(1)
}

if args.contains("--connected") {
    if #available(macOS 10.15, *) {
        if let network = getConnectedNetwork() {
            printJSONObject([
                "ssid": network.ssid,
                "rssi": network.rssi,
                "noise": network.noise,
                "channel": network.channel,
                "bssid": network.bssid
            ])
            exit(0)
        }
    }
    print("null")
    exit(1)
}

// Default: output all visible networks
if #available(macOS 10.15, *) {
    if let networks = performScan() {
        printJSONArray(networks)
        exit(0)
    } else {
        print("[]")
        exit(1)
    }
} else {
    print("[]")
    exit(1)
}
