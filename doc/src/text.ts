// The base size of a leaf node
const BASE_LEAF = 512
// The max size of a leaf node
const MAX_LEAF = BASE_LEAF << 1
// The desired amount of branches per node, as an exponent of 2 (so 3
// means 8 branches)
const TARGET_BRANCH_SHIFT = 3

export interface TextIterator extends Iterator<string> {
  next(skip?: number): this
  value: string
  done: boolean
  lineBreak: boolean
}

// Note line numbers are 1-based

export abstract class Text {
  abstract readonly length: number
  abstract readonly lines: number
  abstract readonly children: ReadonlyArray<Text> | null

  lineAt(pos: number): Line {
    if (pos < 0 || pos > this.length) throw new RangeError(`Invalid position ${pos} in document of length ${this.length}`)
    for (let i = 0; i < lineCache.length; i += 2) {
      if (lineCache[i] != this) continue
      let line = lineCache[i + 1]
      if (line.start <= pos && line.end >= pos) return line
    }
    return cacheLine(this, this.lineInner(pos, false, 1, 0).finish(this))
  }
  line(n: number): Line {
    if (n < 1 || n > this.lines) throw new RangeError(`Invalid line number ${n} in ${this.lines}-line document`)
    for (let i = 0; i < lineCache.length; i += 2) {
      if (lineCache[i] != this) continue
      let line = lineCache[i + 1]
      if (line.number == n) return line
    }
    return cacheLine(this, this.lineInner(n, true, 1, 0).finish(this))
  }
  // @internal
  abstract lineInner(target: number, isLine: boolean, line: number, offset: number): Line

  replace(from: number, to: number, text: ReadonlyArray<string>): Text {
    if (text.length == 0) throw new RangeError("An inserted range must have at least one line")
    return this.replaceInner(from, to, text, textLength(text))
  }
  // @internal
  abstract replaceInner(from: number, to: number, text: ReadonlyArray<string>, length: number): Text

  sliceLines(from: number, to: number = this.length): ReadonlyArray<string> {
    return this.sliceTo(from, to, [""])
  }
  // @internal
  abstract sliceTo(from: number, to: number, target: string[]): string[]
  slice(from: number, to?: number, lineSeparator?: string): string {
    return joinLines(this.sliceLines(from, to), lineSeparator)
  }

  eq(other: Text): boolean { return this == other || eqContent(this, other) }

  iter(dir: 1 | -1 = 1): TextIterator { return new RawTextCursor(this, dir) }
  iterRange(from: number, to: number = this.length): TextIterator { return new PartialTextCursor(this, from, to) }
  iterLines(from: number = 0): TextIterator { return new LineCursor(this, from) }

  // @internal
  abstract decomposeStart(to: number, target: Text[]): void
  // @internal
  abstract decomposeEnd(from: number, target: Text[]): void
  // @internal
  abstract lastLineLength(): number
  // @internal
  abstract firstLineLength(): number

  toString() { return this.slice(0, this.length) }

  // @internal
  protected constructor() {}

  static of(text: string | ReadonlyArray<string>, lineSeparator?: string | RegExp): Text {
    if (typeof text == "string") text = splitLines(text, lineSeparator)
    else if (text.length == 0) throw new RangeError("A document must have at least one line")
    let length = textLength(text)
    return length < MAX_LEAF ? new TextLeaf(text, length) : TextNode.from(TextLeaf.split(text, []), length)
  }

  static empty: Text
}

let lineCache: any[] = [], lineCachePos = -2, lineCacheSize = 12

function cacheLine(text: Text, line: Line): Line {
  lineCachePos = (lineCachePos + 2) % lineCacheSize
  lineCache[lineCachePos] = text
  lineCache[lineCachePos + 1] = line
  return line
}

export function splitLines(text: string, lineSeparator: string | RegExp = DEFAULT_SPLIT): string[] {
  return text.split(lineSeparator)
}

export function joinLines(text: ReadonlyArray<string>, lineSeparator: string = "\n"): string {
  return text.join(lineSeparator)
}

const DEFAULT_SPLIT = /\r\n?|\n/

class TextLeaf extends Text {
  constructor(readonly text: ReadonlyArray<string>, readonly length: number = textLength(text)) {
    super()
  }

  get lines(): number { return this.text.length }

  get children() { return null }

  replaceInner(from: number, to: number, text: ReadonlyArray<string>, length: number): Text {
    return Text.of(appendText(this.text, appendText(text, sliceText(this.text, 0, from)), to))
  }

  sliceTo(from: number, to: number = this.length, target: string[]): string[] {
    return appendText(this.text, target, from, to)
  }

  lineInner(target: number, isLine: boolean, line: number, offset: number): Line {
    for (let i = 0;; i++) {
      let string = this.text[i], end = offset + string.length
      if ((isLine ? line : end) >= target)
        return new Line(offset, end, line, string)
      offset = end + 1
      line++
    }
  }

  decomposeStart(to: number, target: Text[]) {
    target.push(new TextLeaf(sliceText(this.text, 0, to), to))
  }

  decomposeEnd(from: number, target: Text[]) {
    target.push(new TextLeaf(sliceText(this.text, from), this.length - from))
  }

  lastLineLength(): number { return this.text[this.text.length - 1].length }

  firstLineLength(): number { return this.text[0].length }

  static split(text: ReadonlyArray<string>, target: Text[]): Text[] {
    let part = [], length = -1
    for (let line of text) {
      for (;;) {
        let newLength = length + line.length + 1
        if (newLength < BASE_LEAF) {
          length = newLength
          part.push(line)
          break
        }
        let cut = BASE_LEAF - length - 1, after = line.charCodeAt(cut)
        if (after >= 0xdc00 && after < 0xe000) cut++
        part.push(line.slice(0, cut))
        target.push(new TextLeaf(part, BASE_LEAF))
        line = line.slice(cut)
        length = -1
        part = []
      }
    }
    if (length != -1) target.push(new TextLeaf(part, length))
    return target
  }
}

class TextNode extends Text {
  readonly lines: number;

  constructor(readonly children: ReadonlyArray<Text>, readonly length: number) {
    super()
    this.lines = 1
    for (let child of children) this.lines += child.lines - 1
  }

  replaceInner(from: number, to: number, text: ReadonlyArray<string>, length: number): Text {
    let lengthDiff = length - (to - from), newLength = this.length + lengthDiff
    if (newLength <= BASE_LEAF)
      return new TextLeaf(appendText(this.sliceLines(to), appendText(text, this.sliceTo(0, from, [""]))), newLength)

    let children
    for (let i = 0, pos = 0; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      if (from >= pos && to <= end &&
          (lengthDiff > 0
           ? child.length + lengthDiff < Math.max(newLength >> (TARGET_BRANCH_SHIFT - 1), MAX_LEAF)
           : child.length + lengthDiff > newLength >> (TARGET_BRANCH_SHIFT + 1))) {
        // Fast path: if the change only affects one child and the
        // child's size remains in the acceptable range, only update
        // that child
        children = this.children.slice()
        children[i] = child.replace(from - pos, to - pos, text)
        return new TextNode(children, newLength)
      } else if (end >= from) {
        // Otherwise, we must build up a new array of children
        if (children == null) children = this.children.slice(0, i)
        if (pos < from) {
          if (end == from) children.push(child)
          else child.decomposeStart(from - pos, children)
        }
        if (pos <= from && end >= from) TextLeaf.split(text, children)
        if (pos >= to) children.push(child)
        else if (end > to) child.decomposeEnd(to - pos, children)
      }
      pos = end
    }
    return children ? TextNode.from(children, newLength) : this
  }

  sliceTo(from: number, to: number, target: string[]): string[] {
    let pos = 0
    for (let child of this.children) {
      let end = pos + child.length
      if (to > pos && from < end)
        child.sliceTo(Math.max(0, from - pos), Math.min(child.length, to - pos), target)
      pos = end
    }
    return target
  }

  lineInner(target: number, isLine: boolean, line: number, offset: number): Line {
    for (let i = 0;; i++) {
      let child = this.children[i], end = offset + child.length, endLine = line + child.lines - 1
      if ((isLine ? endLine : end) >= target) {
        let inner = child.lineInner(target, isLine, line, offset), add
        if (inner.start == offset && (add = this.lineLengthTo(i))) {
          ;(inner as any).start -= add
          ;(inner as any).content = null
        }
        if (inner.end == end && (add = this.lineLengthFrom(i + 1))) {
          ;(inner as any).end += add
          ;(inner as any).content = null
        }
        return inner
      }
      offset = end
      line = endLine
    }
  }

  decomposeStart(to: number, target: Text[]) {
    for (let i = 0, pos = 0;; i++) {
      let child = this.children[i], end = pos + child.length
      if (end <= to) {
        target.push(child)
      } else {
        if (pos < to) child.decomposeStart(to - pos, target)
        break
      }
      pos = end
    }
  }

  decomposeEnd(from: number, target: Text[]) {
    let pos = 0
    for (let child of this.children) {
      let end = pos + child.length
      if (pos >= from) target.push(child)
      else if (end > from && pos < from) child.decomposeEnd(from - pos, target)
      pos = end
    }
  }

  private lineLengthTo(to: number): number {
    let length = 0
    for (let i = to - 1; i >= 0; i--) {
      let child = this.children[i]
      if (child.lines > 1) return length + child.lastLineLength()
      length += child.length
    }
    return length
  }

  lastLineLength(): number { return this.lineLengthTo(this.children.length) }

  private lineLengthFrom(from: number): number {
    let length = 0
    for (let i = from; i < this.children.length; i++) {
      let child = this.children[i]
      if (child.lines > 1) return length + child.firstLineLength()
      length += child.length
    }
    return length
  }

  firstLineLength(): number { return this.lineLengthFrom(0) }

  static from(children: Text[], length: number): Text {
    if (length < MAX_LEAF) {
      let text = [""]
      for (let child of children) child.sliceTo(0, child.length, text)
      return new TextLeaf(text, length)
    }

    let chunkLength = Math.max(BASE_LEAF, length >> TARGET_BRANCH_SHIFT), maxLength = chunkLength << 1, minLength = chunkLength >> 1
    let chunked: Text[] = [], currentLength = 0, currentChunk: Text[] = []
    function add(child: Text) {
      let childLength = child.length, last
      if (childLength > maxLength && child instanceof TextNode) {
        for (let node of child.children) add(node)
      } else if (childLength > minLength && (currentLength > minLength || currentLength == 0)) {
        flush()
        chunked.push(child)
      } else if (child instanceof TextLeaf && currentLength > 0 &&
                 (last = currentChunk[currentChunk.length - 1]) instanceof TextLeaf &&
                 child.length + last.length <= BASE_LEAF) {
        currentLength += childLength
        currentChunk[currentChunk.length - 1] = new TextLeaf(appendText(child.text, last.text.slice()), child.length + last.length)
      } else {
        if (currentLength + childLength > chunkLength) flush()
        currentLength += childLength
        currentChunk.push(child)
      }
    }
    function flush() {
      if (currentLength == 0) return
      chunked.push(currentChunk.length == 1 ? currentChunk[0] : TextNode.from(currentChunk, currentLength))
      currentLength = 0
      currentChunk.length = 0
    }

    for (let child of children) add(child)
    flush()
    return chunked.length == 1 ? chunked[0] : new TextNode(chunked, length)
  }
}

Text.empty = Text.of("")

function textLength(text: ReadonlyArray<string>) {
  let length = -1
  for (let line of text) length += line.length + 1
  return length
}

function appendText(text: ReadonlyArray<string>, target: string[], from = 0, to = 1e9): string[] {
  for (let pos = 0, i = 0, first = true; i < text.length && pos <= to; i++) {
    let line = text[i], end = pos + line.length
    if (end >= from) {
      if (end > to) line = line.slice(0, to - pos)
      if (pos < from) line = line.slice(from - pos)
      if (first) { target[target.length - 1] += line; first = false }
      else target.push(line)
    }
    pos = end + 1
  }
  return target
}

function sliceText(text: ReadonlyArray<string>, from?: number, to?: number): string[] {
  return appendText(text, [""], from, to)
}

function eqContent(a: Text, b: Text): boolean {
  if (a.length != b.length || a.lines != b.lines) return false
  let iterA = new RawTextCursor(a), iterB = new RawTextCursor(b)
  for (let offA = 0, offB = 0;;) {
    if (iterA.lineBreak != iterB.lineBreak || iterA.done != iterB.done) {
      return false
    } else if (iterA.done) {
      return true
    } else if (iterA.lineBreak) {
      iterA.next(); iterB.next()
      offA = offB = 0
    } else {
      let strA = iterA.value.slice(offA), strB = iterB.value.slice(offB)
      if (strA.length == strB.length) {
        if (strA != strB) return false
        iterA.next(); iterB.next()
        offA = offB = 0
      } else if (strA.length > strB.length) {
        if (strA.slice(0, strB.length) != strB) return false
        offA += strB.length
        iterB.next(); offB = 0
      } else {
        if (strB.slice(0, strA.length) != strA) return false
        offB += strA.length
        iterA.next(); offA = 0
      }
    }
  }
}

class RawTextCursor implements TextIterator {
  public done: boolean = false
  public lineBreak: boolean = false
  public value: string = ""
  private nodes: Text[]
  private offsets: number[]

  // @internal
  constructor(text: Text, readonly dir: 1 | -1 = 1) {
    this.nodes = [text]
    this.offsets = [dir > 0 ? 0 : text instanceof TextLeaf ? text.text.length : text.children!.length]
  }

  next(skip: number = 0): this {
    for (;;) {
      let last = this.nodes.length - 1
      if (last < 0) {
        this.done = true
        this.value = ""
        this.lineBreak = false
        return this
      }
      let top = this.nodes[last]
      let offset = this.offsets[last]
      if (top instanceof TextLeaf) {
        // Internal offset with lineBreak == false means we have to
        // count the line break at this position
        if (offset != (this.dir > 0 ? 0 : top.text.length) && !this.lineBreak) {
          this.lineBreak = true
          if (skip == 0) {
            this.value = "\n"
            return this
          }
          skip--
          continue
        }
        // Otherwise, move to the next string
        let next = top.text[offset - (this.dir < 0 ? 1 : 0)]
        this.offsets[last] = (offset += this.dir)
        if (offset == (this.dir > 0 ? top.text.length : 0)) {
          this.nodes.pop()
          this.offsets.pop()
        }
        this.lineBreak = false
        if (next.length > skip) {
          this.value = skip == 0 ? next : this.dir > 0 ? next.slice(skip) : next.slice(0, next.length - skip)
          return this
        }
        skip -= next.length
      } else if (offset == (this.dir > 0 ? top.children!.length : 0)) {
        this.nodes.pop()
        this.offsets.pop()
      } else {
        let next = top.children![this.dir > 0 ? offset : offset - 1], len = next.length
        this.offsets[last] = offset + this.dir
        if (skip > len) {
          skip -= len
        } else {
          this.nodes.push(next)
          this.offsets.push(this.dir > 0 ? 0 : next instanceof TextLeaf ? next.text.length : next.children!.length)
        }
      }
    }
  }
}

class PartialTextCursor implements TextIterator {
  cursor: RawTextCursor
  limit: number
  skip: number
  value: string = ""

  constructor(text: Text, start: number, end: number) {
    this.cursor = new RawTextCursor(text, start > end ? -1 : 1)
    if (start > end) {
      this.skip = text.length - start
      this.limit = start - end
    } else {
      this.skip = start
      this.limit = end - start
    }
  }

  next(): this {
    if (this.limit <= 0) {
      this.limit = -1
    } else {
      let {value, lineBreak} = this.cursor.next(this.skip)
      this.skip = 0
      this.value = value
      let len = lineBreak ? 1 : value.length
      if (len > this.limit)
        this.value = this.cursor.dir > 0 ? value.slice(0, this.limit) : value.slice(len - this.limit)
      this.limit -= this.value.length
    }
    return this
  }

  get lineBreak() { return this.cursor.lineBreak }

  get done() { return this.limit < 0 }
}

class LineCursor implements TextIterator {
  cursor: TextIterator
  skip: number
  value = ""
  done = false

  constructor(text: Text, from = 0) {
    this.cursor = text.iter()
    this.skip = from
  }

  next(): this {
    if (this.cursor.done) {
      this.done = true
      this.value = ""
      return this
    }
    for (this.value = "";;) {
      let {value, lineBreak, done} = this.cursor.next(this.skip)
      this.skip = 0
      if (done || lineBreak) return this
      this.value += value
    }
  }

  get lineBreak() { return false }
}

// FIXME rename start/end to from/to for consistency with other types?
export class Line {
  // @internal
  constructor(readonly start: number,
              readonly end: number,
              readonly number: number,
              // @internal
              public content: string | null | LineContent) {}

  get length() { return this.end - this.start }

  slice(from: number = 0, to: number = this.length) {
    if (typeof this.content == "string")
      return to == from + 1 ? this.content.charAt(from) : this.content.slice(from, to)
    if (from == to) return ""
    let result = this.content!.slice(from, to)
    if (from == 0 && to == this.length) this.content = result
    return result
  }

  // @internal
  finish(text: Text): this {
    if (this.content == null) this.content = new LineContent(text, this.start)
    return this
  }
}

class LineContent {
  cursor: null | TextIterator = null
  strings: string[] | null = null

  constructor(private doc: Text, private start: number) {}

  // FIXME quadratic complexity (somewhat) when iterating long lines in small pieces
  slice(from: number, to: number) {
    if (!this.cursor) {
      this.cursor = this.doc.iter()
      this.strings = [this.cursor.next(this.start).value]
    }
    for (let result = "", pos = 0, i = 0;; i++) {
      if (i == this.strings!.length) this.strings!.push(this.cursor!.next().value)
      let string = this.strings![i], end = pos + string.length
      if (end <= from) continue
      result += string.slice(Math.max(0, from - pos), Math.min(string.length, to - pos))
      if (end >= to) return result
      pos += string.length
    }
  }
}

export function dumpText(text: Text) {
  let nodeId: number = 0;
  let maps: string[] = [];
  let nodes: string[] = [];

  function dump(text: Text, parentId: number | null) {
    if (null != parentId) {
      nodeId++;
      maps.push(`node${parentId} -> node${nodeId}`)
    }

    switch (true) {
      case text instanceof TextLeaf:
        let leaf = text as TextLeaf;
        nodes.push(`node${nodeId} [shape=ellipse, label="TextLeaf"]`)

        let _nodeId = nodeId;
        for (let str of leaf.text)  {
          nodeId++;
          maps.push(`node${_nodeId} -> node${nodeId}`)
          nodes.push(`node${nodeId} [shape=box, label="${str.replace(/\"/g, "\\\"")}"]`)
        }
        break;
      case text instanceof TextNode:
        let node = text as TextNode;
        nodes.push(`node${nodeId} [shape=circle]`)
        for (let nd of node.children) {
          dump(nd, nodeId);
        }
        break;
    }
  }

  dump(text, null)

  let mapsStr = maps.join("\n");
  let nodesStr = nodes.join("\n");
  let graphviz = `
    digraph example1 {
      ${mapsStr}
      ${nodesStr}
    }
  `
  console.log(graphviz)
}
