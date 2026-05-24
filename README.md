# NameForge

**Desktop app to generate parametric 3D name plates for Bambu Lab printers.**

Generate personalized letter + name engravings, export STL/3MF, and open directly in BambuStudio — all in one click.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Version](https://img.shields.io/badge/version-1.1.1-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)
![Electron](https://img.shields.io/badge/Electron-42-47848F)

![NameForge Banner](assets/banner.png)

---

![NameForge Screenshot](assets/screenshot.png)

---

## Features

- **Parametric generation** — large initial letter + engraved name, fully customizable
- **18 fonts bundled** (Bebas Neue, Anton, Orbitron, STIX Two Math, Pacifico, Lobster…)
- **Real-time 3D preview** — Bambu Lab bed plate, accurate colors
- **Export STL or 3MF** — with optional BambuStudio slicer settings (fuzzy skin, ironing, chamfer)
- **Open directly in BambuStudio** — one click
- **🌐 FR / EN interface** — language switcher in the header, preference saved automatically
- **Auto-update** — checks for new OpenSCAD binary on launch

## Requirements

- Windows 10/11 x64
- [BambuStudio](https://bambulab.com/en/download/studio) (optional, for direct open)

## Installation

Download `NameForge Setup 1.1.1.exe` from [Releases](https://github.com/stormz85ia/NameForge/releases) and run it.

> **First launch:** NameForge will download OpenSCAD automatically (~70 MB).

## Build from source

```bash
npm install
npm run download-openscad   # downloads OpenSCAD portable into resources/openscad/
npm run dev                 # Vite + Electron dev mode
npm run dist:win            # production build → release/
```

## Stack

- Electron 42 + Vite 8 + React 19 + Tailwind 4
- Three.js 0.184 (3D preview)
- OpenSCAD 2021 (parametric model generation)
- react-i18next (FR/EN localization)
- electron-builder 26

## License

MIT — see [LICENSE](LICENSE)
