import { cp, mkdir } from "node:fs/promises";

await cp("extension", "dist", { recursive: true });
await mkdir("dist/vendor", { recursive: true });
await cp("node_modules/gifenc/dist/gifenc.esm.js", "dist/vendor/gifenc.esm.js");
await cp("node_modules/gifenc/LICENSE.md", "dist/vendor/gifenc.LICENSE.md");
await cp("node_modules/pdf-lib/dist/pdf-lib.min.js", "dist/vendor/pdf-lib.min.js");
await cp("node_modules/pdf-lib/LICENSE.md", "dist/vendor/pdf-lib.LICENSE.md");

const avif = "node_modules/@jsquash/avif";
await mkdir("dist/vendor/avif", { recursive: true });
for (const file of ["codec/enc/avif_enc.js", "codec/enc/avif_enc.wasm", "meta.js", "LICENSE"]) {
  await cp(`${avif}/${file}`, `dist/vendor/avif/${file.split("/").pop()}`);
}
