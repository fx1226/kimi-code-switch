from __future__ import annotations
import argparse
import re
from pathlib import Path

TEMPLATE = '''class KimiCodeSwitch < Formula
  desc "Local web configuration companion for Kimi Code"
  homepage "https://github.com/fx1226/kimi-code-switch"
  url "https://github.com/fx1226/kimi-code-switch/releases/download/v{version}/kimi-code-switch-{version}-macos-arm64.tar.gz"
  sha256 "{sha256}"
  version "{version}"
  license "MIT"

  depends_on :macos
  depends_on arch: :arm64

  def install
    bin.install "kimi-code-switch"
  end

  test do
    assert_match "kimi-code-switch", shell_output("#{{bin}}/kimi-code-switch --help")
  end
end
'''

def main() -> None:
    parser = argparse.ArgumentParser(description="Render the macOS arm64 Homebrew formula.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        parser.error("version must use X.Y.Z")
    if not re.fullmatch(r"[a-f0-9]{64}", args.sha256):
        parser.error("sha256 must be a lowercase SHA256 digest")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(TEMPLATE.format(version=args.version, sha256=args.sha256), encoding="utf-8")

if __name__ == "__main__":
    main()
