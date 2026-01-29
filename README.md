# VacuumTubeUWP

<p>
    <a href="https://github.com/TBNRBERRY/VacuumTubeUWP/stargazers">
      <img alt="Stars" title="Stars" src="https://img.shields.io/github/stars/TBNRBERRY/VacuumTubeUWP?style=shield&label=%E2%AD%90%20Stars&branch=main&kill_cache=1%22" />
    </a>
    <a href="https://github.com/TBNRBERRY/VacuumTubeUWP/releases/latest">
      <img alt="Latest Release" title="Latest Release" src="https://img.shields.io/github/v/release/TBNRBERRY/VacuumTubeUWP?style=shield&label=%F0%9F%9A%80%20Release">
    </a>
    <a href="hxxps://klausenbusk.github.io/flathub-stats/#ref=TBNRBERRY/VacuumTubeUWP&interval=infinity&downloadType=installs%2Bupdates">
      <img alt="Flathub Downloads" title="Flathub Downloads" src="hxxps://img.shields.io/badge/dynamic/json?color=informational&label=Downloads&logo=flathub&logoColor=white&query=%24.installs_total&url=https%3A%2F%2Fflathub.org%2Fapi%2Fv2%2Fstats%2Frocks.shy.VacuumTube">
    </a>
    <a href="https://github.com/TBNRBERRY/VacuumTubeUWP/blob/master/LICENSE">
      <img alt="License" title="License" src="https://img.shields.io/github/license/TBNRBERRY/VacuumTubeUWP?label=%F0%9F%93%9C%20License" />
    </a>
</p>

VacuumTubeUWP is an unofficial project (modeled after VacuumTube) of YouTube Leanback (the console and Smart TV version of YouTube) for Xbox (Sideloaded in Dev Mode), with a built-in adblocker and minor enhancements.

## What exactly is this?

It is **not** a custom client, YouTube Leanback is an official interface. This project simply encompasses it and makes it usable as a standalone desktop application.

YouTube Leanback is just an HTML5 app, and so you *can* just use it in your browser by going to https://www.youtube.com/tv, but they intentionally block browsers unless it's one of their console or TV apps.

You can technically bypass this by spoofing your user agent, but it isn't the same experience you'd get on a console or TV as it doesn't support controllers outside of the official app, and it's just a much more involved process to get it working.

VacuumTubeUWP solves all of this by wrapping it in WebView2 using C#, pretending to be the YouTube app, implementing controller support, and overall making it a much better experience than just spoofing your user agent.

If there's anything that you think makes it look lazy or half-baked, open an issue! The goal is to make it feel as official as possible, while also providing niceties like ad blocking, DeArrow and userstyles.

## Installing `Edit Documentation TODO`

### Windows

If you don't know the difference, pick the Installer.

- [Installer](hxxps://github.com/shy1132/VacuumTube/releases/latest/download/VacuumTube-Setup.exe) 
- Portable:
  - [x64 / amd64](hxxps://github.com/shy1132/VacuumTube/releases/latest/download/VacuumTube-x64-Portable.zip)
  - [Arm® 64](hxxps://github.com/shy1132/VacuumTube/releases/latest/download/VacuumTube-arm64-Portable.zip)
 
## Settings

VacuumTubeUWP has some settings that you can change, which can be changed by opening the `"Secret Menu"` by pressing down the `Right Thumbstick` on your controller.

- Ad Block
  - Seamlessly blocks video and feed ads, not subject to YouTube's methods of preventing blockers
- Sponsorblock
  - Automatically skips sponsored segments in videos based on a [community-contributed database](https://sponsor.ajay.app/). 
- DeArrow
  - Replaces titles and thumbnails with more accurate, less sensationalized versions from a public crowdsourced database
- Return Dislikes
  - Uses community data from the [Return YouTube Dislike API](returnyoutubedislike.com) to show rough dislike counts
- Remove Super Resolution
  - Removes \"Super resolution\" (AI upscaled) qualities from low quality videos
- Hide Shorts
  - Hides YouTube Shorts from the homepage
- Force H.264
  - Forces YouTube to only stream videos in the H.264 codec (like [h264ify](https://github.com/erkserkserks/h264ify))
- Hardware Decoding
  - Uses your GPU to decode videos when possible
- Low Memory Mode
  - Tells YouTube to enable it's low memory mode
- Custom CSS (Userstyles)
  - Enables injection of custom CSS styles. See the section below for more information

## Custom CSS (Userstyles) `Edit Documentation TODO`

You can apply custom styles to VacuumTube by first enabling it in the settings, and then creating `.css` files in the userstyles folder. They can then be managed in VacuumTube settings. You can access the developer tools by pressing **Ctrl+Shift+I**, which are extremely helpful when writing custom CSS.

## Building from Source `Edit Documentation TODO`

Builds will be created in the dist/ folder

```sh
git clone https://github.com/TBNRBERRY/VacuumTubeUWP
cd VacuumTubeUWP

# Install Dependencies
npm i

# Run without packaging
npm run start

# Or package builds for your operating system
npm run windows:build
```

### Thanks:


- [shy1132](https://github.com/shy1132) of [VacuumTube](https://github.com/shy1132/VacuumTube) for the JavaScript preload scripts that I utilized and modified

