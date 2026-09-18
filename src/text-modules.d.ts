// Ambient module shims for the raw-text imports settingsDefaults.ts uses -
// esbuild.config.mjs's `loader` maps these extensions to "text", so the
// bundled value is just the file's contents as a string.

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.base" {
  const content: string;
  export default content;
}
