#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Building macos-wifi-scan..."
swiftc -framework CoreWLAN -framework Foundation -O -o macos-wifi-scan main.swift
echo "Done. Binary: ./macos-wifi-scan"