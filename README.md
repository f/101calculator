# Yüzbir

Camera-first, mobile web calculator for 101 Okey. It reads the numbered ink on each tile on-device, places the result on a virtual two-row ıstaka, and proposes a legal per arrangement that reaches 101 when possible while leaving as few tiles out as possible. Recognition is restricted to Okey values 1–13 and the star stone.

Before calculating, choose the printed Okey for the hand (for example, Mavi 3). Both that tile and the star can fill any missing position in a proposed run or set. The virtual stones show each wildcard's assigned value after applying the proposal.

## Live site

Every push to `main` is tested, built, and deployed through GitHub Actions at [blog.fka.dev/101calculator](https://blog.fka.dev/101calculator/).

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Camera access works on localhost; deployed copies must use HTTPS.

On a phone, rotate to landscape so the full two-row ıstaka and compact score drawer stay visible together. The installed web app supports both portrait and landscape. JPEG, PNG, HEIC, and HEIF photos can also be scanned locally with **Fotoğraftan oku**.

After a scan you can:

- drag stones to reorder them;
- tap any stone to change its number, color, or star status;
- add a missed stone or delete a false detection;
- apply and undo the best proposed per arrangement.

Useful deterministic views:

- `/?demo=1` shows the completed interactive 101 hand without requesting a camera.
- `/?ocrtest=1` runs that hand through the real segmentation and OCR pipeline.

## Verification

```bash
npm test
npm run build
npm audit
```

The optimizer covers runs, color-distinct sets, star and selected-Okey wildcard assignments, disjoint physical stones, least-leftover planning, and the exact-101 boundary. Recognition combines tile-font templates with a bundled English numeral model; camera frames and imported photos are processed in the browser and are never uploaded.

## Current boundary

The automatic recognizer is a practical OCR-based release, not a trained Okey-tile vision model. Different tile typefaces, glare, occlusion, or severe perspective can still need correction on the virtual ıstaka. A production accuracy pass should add representative photos from several physical tile sets and a small dedicated tile classifier.
