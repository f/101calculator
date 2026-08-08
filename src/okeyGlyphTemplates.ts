export type OkeyGlyphTemplate = {
  digit: number;
  pixels: Uint8Array;
};

// Compact 16 × 24 silhouettes from the embossed Original Rummy tile face.
// They complement generic OCR for the heavy, rounded numerals used by this set.
const ENCODED_TEMPLATES: Array<[number, string]> = [
  [1, 'AADgA+AD/Af8J/wn/CfgJ+An4AeAB4AHgB+AH4AfgB+AH4AfAB8AHwAfAD8APwAA'],
  [2, 'AAAAAAAAAADwA/AD+A/+Dz4ePhwAHAAeAB+AH8AP4AfwP/B/9n/2fwAAAAAAAAAA'],
  [1, 'AADgB+AH/Af8B/wH/B+AH4AfgB+AH4AfgB+AH4AfAB8AHwAfAB8APwA/AD8APwAA'],
  [2, 'AAAAAPAD8AP4B/4P/h8+Px48HjwAPAA8AD+AH8APwA/gB/h/+H/4f/B/AAAAAAAA'],
  [1, 'AACAB4AH4Af8D/wP/A/wD4APgA+AD4APAA8ADwAPAB8AHwAfAB8AHwAfAB8AHgAA'],
  [2, 'AAAAAAAA8APwA/gH/g/+Hz4eADwAPAAeAB+AD8AH4AP4P/h/8H8AOAAAAAAAAAAA'],
  [9, 'AAAAAOAD4AP4D/gf/j8+OD54Png+eH58+H/wf8B7wHsAeAB88D/wH/APAAAAAAAA'],
  [1, 'AADAD8AP+A/4D/gP+A/AD8APwA8ADwAPAA8ADwAPAA8ADwAPAB8AHwAfAB8ADwAA'],
  [0, 'AAAAAOAP4A/wH/g/+H9+fH58fnB+cH5wfnB+cHhweHB4cPh9+H3wf/A/gB8AAAAA'],
  [1, 'AAAADwAP4A/4D/gP+A8ADwAPAA8ADwAPAB8AHwAfAB8AHwAfAB8AHwAfAB8AHwAA'],
  [1, 'AADAD8AP+A/4D/gP+A8ADwAPAA8ADwAPAA8ADwAPAA8AHwAfAB8AHwAfAB8AHwAA'],
  [1, 'AADAD8AP+A/4D/gP+A/AD8APwA/AD8APwA/AD8APwA/AB8AHwAfAB8AHwAfABwAA'],
  [3, 'AADAA8AD+B/+P/4//n8+fAB8AHwAfMA/wD/APwB/AHwAfAB8Pj/+P/4//h/4BwAA'],
  [1, 'AAAAHwAfwB/4H/gf+B/4H8APwA/AD8APwA/AD8APwA/AD8APwA/AD8APwA/ADwAA'],
  [4, 'AAAAAIA/gD+AP+A/8D/wP/A++D54Ph4+Hj4efv5//n/+f/5/AB8AHwAfAAAAAAAA'],
  [1, 'AADAD8AP+A/4D/gP+A/AB8AHwAfAB8AHwAfAB8AH4AfgB+AH4AfgB+AH4AfgBwAA'],
  [3, 'AAAAAIAPgA/wP/g/+H94fHh8AHwAPoA/gD+APwA/AD4APh4+Hj7+H/4f+AMAAAAA'],
  [5, 'AAAAAAAA/h/+H/4f/h94AHgA+A/4D/gf+D8AeAB4AHgAeOB/8D/wP4APAAAAAAAA'],
  [6, 'AAAAAAAA8A/wD/gP/g8+AD4A/gf+B/4f/j8+OD54OHg4eHh48D/gP4APAAAAAAAA'],
  [7, 'AAAAAAAA/n/+f/5//n/+fwA8ADwAPAAfAB8AH4APgA+AD4APwAfAB4ADAAAAAAAA'],
  [8, 'AAAAAAAA4APgA/gP/h8+HD48Pjw+PPgf+D8+OD54Png+eHg4+D/wP8APAAAAAAAA'],
  [9, 'AAAAAAAA8AfwB/gf/j8+PD44Png+eH58+H/wf8B7AHgAeAA88D/wH/APAAAAAAAA'],
  [1, 'AAAADwAP4B/4H/gf+B8AHwAfAB8AHwAfAB8AHwAfAB8AHwAfAB8AHwAfAB8ADgAA'],
  [0, 'AAAAAPAP8A/+H/4/fj5+Ph58HnwefB58HnwefB58fnz+f/5/+D/wH4ADAAAAAAAA'],
  [1, 'AADAB8AH4Af4B/gH+AfAB8AHwAfAB8AHwAfAD8APwA/AD8APwA/AD8APwA8ABwAA'],
  [0, 'AADwB/AH+D/+f/5/fnw+eD54Png+eD54Png+eD54Png+eP58+H/4f/A/wAcAAAAA'],
  [6, 'AAAAAOB/4H/wf/h/+AD4AH4A/h/+P/5//n9+fH5wfnD4fPh8+H/wP4APAAAAAAAA'],
  [1, 'AAAADwAPwA/4D/gP+A/4D/gPwA/AD8APwA/AD8APwA/AB8AHwAfAB8AHwAfABwAA'],
  [1, 'AAAADwAP4A/4D/gP+A/AD8APwA/AD8APwA/AD8APwAfAB8AHwAfAB8AHwAfABwAA'],
  [8, 'AAAAAAAOAA7gP/B/8H34cPhweHD4fPh8+Hz4fHhwHnAecPh8+Hz4P/Af4AMAAAAA'],
];

const decodeTemplate = ([digit, encoded]: [number, string]): OkeyGlyphTemplate => {
  const packed = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const pixels = new Uint8Array(16 * 24);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (packed[index >> 3] >> (index & 7)) & 1;
  }
  return { digit, pixels };
};

export const OKEY_GLYPH_TEMPLATES = ENCODED_TEMPLATES.map(decodeTemplate);
