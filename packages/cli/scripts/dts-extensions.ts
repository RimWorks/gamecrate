import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'dist', 'types')
const SPECIFIER = /(\bfrom\s*['"])(\.[^'"]*?)(['"])/g

async function files(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path)))
    else if (entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

let rewritten = 0
for (const path of await files(ROOT)) {
  const before = await readFile(path, 'utf8')
  const after = before.replace(SPECIFIER, (whole, open: string, spec: string, close: string) =>
    spec.endsWith('.js') ? whole : `${open}${spec}.js${close}`,
  )
  if (after !== before) {
    await writeFile(path, after)
    rewritten += 1
  }
}
console.log(`dts extensions: rewrote ${rewritten} files`)
