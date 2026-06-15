import { readFile, stat } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'

// EPUB → readable passages. An EPUB is a zip: META-INF/container.xml points at the OPF;
// the OPF's <spine> is the reading order of XHTML files; each is stripped to paragraphs
// and chunked so no passage exceeds Aura's per-call limit (the chunk = the pause point).

export interface ParsedBook {
  title: string
  author: string | null
  passages: Array<{ seq: number; chapter: string | null; text: string }>
}

const MAX_EPUB_BYTES = 80 * 1024 * 1024 // 80MB — generous for text+images; rejects runaway files before they hit memory
// An EPUB is a zip; every zip starts with the local-file-header magic "PK\x03\x04"
// (0x50 0x4B 0x03 0x04). Cheap pre-check so a mislabelled file fails clearly here
// instead of cryptically deep inside unzipSync.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const MAX_PASSAGE = 700 // chars — comfortably under Aura's per-call text limit

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // last, so &amp;lt; → &lt; → < resolves correctly
}

function xhtmlToParagraphs(xhtml: string): string[] {
  let s = xhtml.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  const body = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (body) s = body[1]
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n\n')
  s = s.replace(/<br\s*\/?>/gi, '\n\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return s
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t\r\f]+/g, ' ').replace(/\n+/g, ' ').trim())
    .filter((p) => p.length > 0)
}

function chunkParagraph(p: string): string[] {
  if (p.length <= MAX_PASSAGE) return [p]
  const sentences = p.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [p]
  const out: string[] = []
  let buf = ''
  for (const sent of sentences) {
    if (buf && (buf + sent).length > MAX_PASSAGE) {
      out.push(buf.trim())
      buf = ''
    }
    buf += sent
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

// Resolve a spine href relative to the OPF's directory, normalising ./ and ../.
function resolvePath(opfPath: string, href: string): string {
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const stack: string[] = []
  for (const part of (dir + href.split('#')[0]).split('/')) {
    if (part === '..') stack.pop()
    else if (part !== '.' && part !== '') stack.push(part)
  }
  return stack.join('/')
}

export async function parseEpub(filePath: string): Promise<ParsedBook> {
  // Size guard FIRST — stat before reading, so a runaway file never loads into memory.
  const { size } = await stat(filePath)
  if (size > MAX_EPUB_BYTES) {
    throw new Error(`that file is ${(size / 1024 / 1024).toFixed(0)}MB — over the ${MAX_EPUB_BYTES / 1024 / 1024}MB limit for a book. If it's really a book, something's off with the file.`)
  }
  if (size < 4) throw new Error('that file is empty or far too small to be an EPUB')

  const buf = await readFile(filePath)
  const bytes = new Uint8Array(buf)
  // Magic-byte guard — a real EPUB is a zip. Catches a mislabelled file (a PDF or
  // image renamed .epub) with a clear message instead of a cryptic unzip crash.
  if (!ZIP_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error("that doesn't look like an EPUB — the file isn't a zip archive underneath. Is it actually a .epub?")
  }

  const files = unzipSync(bytes)
  const get = (name: string): string | null => {
    if (files[name]) return strFromU8(files[name])
    const key = Object.keys(files).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? strFromU8(files[key]) : null
  }

  const container = get('META-INF/container.xml')
  const opfPath = container?.match(/full-path="([^"]+)"/i)?.[1]
  if (!opfPath) throw new Error('not a valid EPUB (no container rootfile)')
  const opf = get(opfPath)
  if (!opf) throw new Error('EPUB OPF not found')

  const title =
    decodeEntities(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() ?? '') ||
    filePath.split(/[\\/]/).pop()?.replace(/\.epub$/i, '') ||
    'Untitled'
  const author =
    decodeEntities(opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.trim() ?? '') || null

  const manifest = new Map<string, string>()
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = m[0].match(/\bid="([^"]+)"/i)?.[1]
    const href = m[0].match(/\bhref="([^"]+)"/i)?.[1]
    if (id && href) manifest.set(id, href)
  }
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/gi)].map((m) => m[1])

  const passages: ParsedBook['passages'] = []
  let seq = 0
  for (const idref of spineIds) {
    const href = manifest.get(idref)
    if (!href) continue
    const xhtml = get(resolvePath(opfPath, href))
    if (!xhtml) continue
    const chapter =
      decodeEntities(
        xhtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() ??
          xhtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ??
          '',
      ) || null
    for (const para of xhtmlToParagraphs(xhtml)) {
      for (const chunk of chunkParagraph(para)) {
        passages.push({ seq: seq++, chapter, text: chunk })
      }
    }
  }
  if (!passages.length) throw new Error('EPUB parsed, but no readable text was found')
  return { title, author, passages }
}
