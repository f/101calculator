import { createDemoTiles } from './domain';

const INK = {
  red: '#d83d3d',
  blue: '#2677d8',
  black: '#191c1c',
  yellow: '#d99520',
};

/** A deterministic camera-like fixture used by the ?ocrtest=1 smoke test. */
export function createSyntheticRackCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 900;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Sentetik ıstaka oluşturulamadı.');

  context.fillStyle = '#163424';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const demo = createDemoTiles();
  const tileWidth = 46;
  const tileHeight = 94;
  const tileGap = 6;
  const groupGap = 30;
  const totalWidth = tileWidth * demo.length + tileGap * 7 + groupGap * 2;
  let x = (canvas.width - totalWidth) / 2;
  const y = 302;

  demo.forEach((tile, index) => {
    if (index > 0 && tile.groupIndex !== demo[index - 1].groupIndex) x += groupGap;
    context.fillStyle = '#eee3cd';
    context.fillRect(x, y, tileWidth, tileHeight);
    context.strokeStyle = '#b5a78f';
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, y + 0.5, tileWidth - 1, tileHeight - 1);
    context.fillStyle = INK[tile.color];
    context.font = '700 42px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(tile.number), x + tileWidth / 2, y + tileHeight / 2 - 2);
    x += tileWidth + tileGap;
  });

  return canvas;
}
