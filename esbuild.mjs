import { build, context } from 'esbuild'

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
