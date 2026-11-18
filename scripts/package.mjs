import { cp, mkdir } from "node:fs/promises";

await cp("extension", "dist", { recursive: true });
await mkdir("dist/vendor", { recursive: true });
await cp("node_modules/pdf-lib/dist/pdf-lib.min.js", "dist/vendor/pdf-lib.min.js");
await cp("node_modules/pdf-lib/LICENSE.md", "dist/vendor/pdf-lib.LICENSE.md");
