export function quantize(rgba: Uint8ClampedArray, maxColors: number): number[][];
export function applyPalette(rgba: Uint8ClampedArray, palette: number[][]): Uint8Array;
export function GIFEncoder(): {
  writeFrame(pixels: Uint8Array, width: number, height: number, options: {
    palette: number[][];
    transparent: boolean;
    transparentIndex: number;
  }): void;
  finish(): void;
  bytes(): Uint8Array;
};
