import { createRequire } from "node:module";

export const { version } = createRequire(import.meta.url)(
  "../package.json",
) as {
  version: string;
};
