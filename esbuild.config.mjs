import esbuild from "esbuild";

const isProduction = process.argv.includes("production");
const isWatch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "browser",
  format: "cjs",
  sourcemap: !isProduction,
  target: "es2018",
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
  logLevel: "info"
});

if (isWatch) {
  await context.watch();
  console.log("Watching for changes...");
} else {
  await context.rebuild();
  await context.dispose();
}
