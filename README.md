# Yüzbir

Camera-first, mobile web calculator for 101 Okey. It reads the numbered ink on each tile on-device, separates melds by their physical gaps, validates them, and overlays every per sum plus the valid total. Output is restricted to Okey values 1–13 and the star wildcard; a star's value is inferred from its surrounding set or run.

## Live site

Every push to `main` is tested, built, and deployed through GitHub Actions at [blog.fka.dev/101calculator](https://blog.fka.dev/101calculator/).

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Camera access works on localhost; deployed copies must use HTTPS.

On a phone, rotate to landscape so the full two-row rack fits inside the guide. The installed web app supports both portrait and landscape. JPEG, PNG, HEIC, and HEIF photos can also be scanned locally with **Fotoğraftan oku**.

Useful deterministic views:

- `/?demo=1` shows the completed interactive 101 hand without requesting a camera.
- `/?ocrtest=1` runs that hand through the real segmentation and OCR pipeline.

## Verification

```bash
npm test
npm run build
npm audit
```

The score engine covers runs, color-distinct sets, inferred star values, invalid meld exclusion, two-row grouping, and the exact-101 boundary. Recognition combines tile-font templates with a bundled English numeral model; camera frames and imported photos are processed in the browser and are never uploaded.

## Current boundary

The automatic recognizer is a practical OCR-based release, not a trained Okey-tile vision model. Different tile typefaces, glare, occlusion, or severe perspective can still need the built-in tap-to-correct control. A production accuracy pass should add representative photos from several physical tile sets and a small dedicated tile classifier.
