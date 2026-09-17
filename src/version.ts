/** The app version, or "dev" where Vite did not inject one (Node scripts, unit tests). */
export const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
