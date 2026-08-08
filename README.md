# Yüzbir

Camera-first, mobile web calculator for 101 Okey. It finds light-colored tiles in the rack area, reads each number and ink color on-device, separates melds by their physical gaps, validates them, and overlays every per sum plus the valid total.

## Live site

Every push to `main` is tested, built, and deployed through GitHub Actions at [f.github.io/101calculator](https://f.github.io/101calculator/).

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Camera access works on localhost; deployed copies must use HTTPS.

Useful deterministic views:

- `/?demo=1` shows the completed interactive 101 hand without requesting a camera.
- `/?ocrtest=1` runs that hand through the real segmentation and OCR pipeline.

## Verification

```bash
npm test
npm run build
npm audit
```

The score engine covers runs, color-distinct sets, invalid meld exclusion, two-row grouping, and the exact-101 boundary. Recognition uses a bundled English numeral model; camera frames are processed in the browser and are never uploaded.

## Current boundary

The automatic recognizer is a practical OCR-based first release, not a trained Okey-tile vision model. Different tile typefaces, glare, severe perspective, or jokers can need the built-in tap-to-correct control. A production accuracy pass should add representative photos from several physical tile sets and a small dedicated tile classifier.
