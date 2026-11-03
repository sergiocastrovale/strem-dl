# strem-dl

Browse any [Stremio addon](https://github.com/Stremio/stremio-addon-sdk) as a directory tree, down to its stream links, and save the video. It doesn't play anything and isn't affiliated with Stremio. Only download what you have the right to.

## Web or desktop

| | Web | Desktop |
|---|---|---|
| Tabs, search, favorites, watchlist | Yes | Yes |
| Addons without CORS headers | Fail | Work |
| Double-clicking a link | Opens it in a new tab | Downloads it |
| Downloads, queue, resume | No | Yes |
| Ticking folders and links | Copies their links | Queues them |
| Video from streams and embed pages | No, and a notice says so | Yes |
| Setup | None | yt-dlp and ffmpeg, on first launch |
| Saved in | Local storage | SQLite (`strem-dl.db`) |

A web page can't see what other pages load, run programs or save to disk, so app-driven video downloads need the desktop app. Both look the same: controls a browser can't use stay in place, disabled.

## Installation

### Web

```bash
pnpm install
pnpm dev    # http://localhost:1420
pnpm build  # static site in dist/
```

### Desktop

```bash
pnpm install
pnpm tauri dev    # run from source
pnpm tauri:wsl    # same, hiding WSL's harmless "Dropped Escape call" GPU message
pnpm tauri build  # packages in src-tauri/target/release/bundle/
```

Build on the OS you're targeting.

| Platform | Tools | Packages |
|---|---|---|
| Linux | See below | `.AppImage`, `.deb`, `.rpm` |
| Windows | See below. Use a Windows drive, not WSL | `-setup.exe`, `.msi` |
| macOS | `xcode-select --install`, then `brew install node pnpm rust` | `.dmg`, `.app` |

Debian or Ubuntu, plus [Rust](https://rustup.rs):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
```

Windows, (in PowerShell):

```powershell
winget install OpenJS.NodeJS.LTS pnpm.pnpm Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
rustup default stable
```

**Tests**: `pnpm test`, and `cargo test` in `src-tauri`.

## Releasing

1. With everything committed, run `pnpm version patch` (or `minor`, `major`, or an exact number like `1.2.3`). It sets the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, commits them and tags `vX.Y.Z`. Then `git push --follow-tags`.
2. Go to **Actions > Release > Run workflow**, choose the branch, and tick the systems to build.
3. It runs the tests, then builds for each system and attaches the packages to a draft release for that version. Check the draft, then publish it, which creates the tag.

If a system fails, run it again with only that one ticked: its packages join the same draft. A published release can only be added to from its own tag, which you can pick instead of a branch.

The packages aren't signed, so Windows SmartScreen warns about them. macOS blocks the app until its quarantine flag is removed, with `xattr -cr /Applications/strem-dl.app`.

## First launch (desktop)

The setup will guide you through the libraries you need for the downloader to work:

- **yt-dlp** saves video streams.
- **ffmpeg** joins video and audio into one file.

These will be installed in:

| | App data, including `bin/` for the programs | Database and settings |
|---|---|---|
| Linux | `~/.local/share/com.stremdl.app/` | `~/.config/com.stremdl.app/` |
| Windows | `%APPDATA%\com.stremdl.app\` | Same |
| macOS | `~/Library/Application Support/com.stremdl.app/` | Same |

You can opt to install later via Settings page.

## Usage

Paste an addon URL and press Enter, for example `https://v3-channels.strem.io`. A missing `/manifest.json` or scheme is assumed (`https://`, or `http://` for localhost and IP addresses), and the field shows the completed address in grey: **Tab** or **→** fills it in. You can open up to 10 tabs simultaneously. Picking a favorite or watchlist item opens its tab and puts its address in the field.

Browse each addon as a **list**, a tree you can open in place, or as **thumbnails**, one folder at a time with its posters. A folder holding only files, like a season's episodes, lists them instead. Tick boxes carry over between them. Press **/** to search, and **Esc** to clear the search or the selection. Hover over a link in the list for what its addon says about the video.

Downloads depend on the type of link:

| Link | What happens |
|---|---|
| File | Downloads directly |
| HLS or DASH | Saved with yt-dlp and ffmpeg |
| Page | yt-dlp tries first, then a hidden window starts the player and notes what it loads |
| Magnet | Opens in your torrent app |

If a hidden window finds nothing in about 20 seconds, the page appears so you can press play. Close it if the link was just a website. If a video link expires mid-download, the app finds it again once and continues.

Those windows run other people's code, ads included. They use a separate temporary profile, block pop-ups and downloads, and can only report a video address.

On the Downloads page, double-click an unfinished download to pause or start it, or a finished one to open its folder.

### Bulk and sources (desktop)

Tick folders or links and press **Download**. Addons often list a title on several hosts, so **Each title** chooses what to queue:

- **First copy**: the one listed first.
- **Best quality**: the highest resolution, then the biggest file.
- **Smallest file**: the smallest. Copies that don't state a size are the last resort.
- **All copies**: all of them.

A link you tick by itself is always queued. **Download** shows how many files that makes, with a **+** when part of the selection isn't loaded yet.

If a source saves no video, the app tries the title's other sources by itself, and **Sources tried** in the row's details says why each failed. A source that stopped partway stays **Failed** so **Resume** can continue it. Pages in bulk never open a window: if nothing else works, the row fails, and **Resume** retries with the page showing.

## Limitations

- DRM-protected video and live streams can't be saved.
- Hosts that need a login or cookies fail.
- Hosts can change their players at any time, which may break finding the video.
- Fedora needs H.264 for GStreamer from RPM Fusion.
- Catalogs that need the addon's own search stay locked.
