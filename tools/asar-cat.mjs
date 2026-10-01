/**
 * Read files inside an Electron `app.asar` without unpacking it.
 *
 * The DSH implementation ships inside `D:\DSH-desktop\resources\app.asar`, which
 * only the Host process can open; shell tools, ripgrep, and Node cannot traverse
 * it as a directory. ASAR is a simple concatenation — a Pickle header followed
 * by the file bodies — so a few lines of Node are enough to list, print, or
 * extract entries.
 *
 *   node tools/asar-cat.mjs list  "<substring>"
 *   node tools/asar-cat.mjs cat   "dsh/node_modules/.../README.md"
 *   node tools/asar-cat.mjs tree  "dsh/node_modules/@deepseek-ai"   # top dirs
 */
import fs from 'node:fs'
import path from 'node:path'

const ASAR = process.env.DSH_ASAR ?? 'D:\\DSH-desktop\\resources\\app.asar'
const [command, filter, out] = process.argv.slice(2)

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonSize = head.readUInt32LE(12)
const json = Buffer.alloc(jsonSize)
fs.readSync(fd, json, 0, jsonSize, 16)
const header = JSON.parse(json.toString('utf8'))
const dataStart = 8 + headerSize

function walk(node, prefix, visit) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const entry = prefix === '' ? name : `${prefix}/${name}`
    if (value.files) {
      visit(entry, value, true)
      walk(value, entry, visit)
    } else {
      visit(entry, value, false)
    }
  }
}

function read(entry) {
  const buffer = Buffer.alloc(entry.size)
  if (entry.size > 0) fs.readSync(fd, buffer, 0, entry.size, dataStart + Number(entry.offset))
  return buffer
}

function collect(predicate) {
  const hits = []
  walk(header, '', (entry, value, isDir) => {
    if (!isDir && predicate(entry)) hits.push({ entry, value })
  })
  return hits
}

if (command === 'list') {
  for (const hit of collect((entry) => filter === undefined || entry.includes(filter))) {
    console.log(`${String(hit.value.size).padStart(9)}  ${hit.entry}`)
  }
} else if (command === 'cat') {
  const [hit] = collect((entry) => entry === filter)
  if (hit === undefined) {
    console.error(`asar-cat: no entry ${JSON.stringify(filter)}`)
    process.exit(2)
  }
  process.stdout.write(read(hit.value))
} else if (command === 'extract') {
  const target = out ?? '.scratch/asar'
  let count = 0
  for (const hit of collect((entry) => entry.startsWith(filter))) {
    const destination = path.join(target, hit.entry)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, read(hit.value))
    count += 1
  }
  console.error(`asar-cat: extracted ${String(count)} files to ${target}`)
} else {
  console.log('usage: node tools/asar-cat.mjs list|cat|extract <filter> [outDir]')
  process.exit(1)
}
