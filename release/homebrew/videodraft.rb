# Formula template for videodraft-ai/homebrew-tap.
# Update url/sha256 per release (or automate with `brew bump-formula-pr`).
# The npm-backed formula pattern keeps one artifact (the npm tarball) as the
# single source of truth.
class Videodraft < Formula
  desc "Official VideoDraft CLI — AI video creation from your terminal"
  homepage "https://videodraft.ai/cli"
  url "https://registry.npmjs.org/videodraft/-/videodraft-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/videodraft --version")
  end
end
