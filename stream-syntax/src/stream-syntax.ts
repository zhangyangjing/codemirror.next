import {StringStream, StringStreamCursor} from "./stringstream"
import {EditorState, StateField, Transaction, Syntax, CancellablePromise} from "../../state/src/"
import {Extension} from "../../extension/src/extension"
import {Tree, NodeType, NodeGroup} from "lezer-tree"
import {styleNodeProp, Style} from "../../theme/src"

export {StringStream}

export type StreamParserSpec<State> = {
  token(stream: StringStream, state: State, editorState: EditorState): string | null
  blankLine?(state: State, editorState: EditorState): void
  startState?(editorState: EditorState): State
  copyState?(state: State): State
  indent?(state: State, textAfter: string, editorState: EditorState): number
  docTag?: string
}

export class StreamParser<State> {
  token: (stream: StringStream, state: State, editorState: EditorState) => string | null
  blankLine: (state: State, editorState: EditorState) => void
  // FIXME maybe support passing something from the parent when nesting
  startState: (editorState: EditorState) => State
  copyState: (state: State) => State
  indent: (state: State, textAfter: string, editorState: EditorState) => number
  docType: number
  
  constructor(spec: StreamParserSpec<State>) {
    this.token = spec.token
    this.blankLine = spec.blankLine || (() => {})
    this.startState = spec.startState || (() => (true as any))
    this.copyState = spec.copyState || defaultCopyState
    this.indent = spec.indent || (() => -1)
    this.docType = tokenID(spec.docTag || "document")
  }

  readToken(state: State, stream: StringStream, editorState: EditorState) {
    stream.start = stream.pos
    for (let i = 0; i < 10; i++) {
      let result = this.token(stream, state, editorState)
      if (stream.pos > stream.start) return result
    }
    throw new Error("Stream parser failed to advance stream.")
  }
}

function defaultCopyState<State>(state: State) {
  if (typeof state != "object") return state
  let newState = {} as State
  for (let prop in state) {
    let val = state[prop]
    newState[prop] = (val instanceof Array ? val.slice() : val) as any
  }
  return newState
}

export type LegacyMode<State> = {name: string} & StreamParserSpec<State>

class RequestInfo {
  promise: CancellablePromise<Tree>
  resolve!: (tree: Tree) => void

  constructor(readonly upto: number) {
    this.promise = new Promise<Tree>(r => this.resolve = r)
    this.promise.canceled = false
  }
}

export class StreamSyntax implements Syntax {
  private field: StateField<SyntaxState<any>>
  public extension: Extension
  public indentation: Extension

  constructor(readonly parser: StreamParser<any>) {
    this.field = new StateField<SyntaxState<any>>({
      init(state) { return new SyntaxState(Tree.empty, [parser.startState(state)], 1, 0, null) },
      apply(tr, value) { return value.apply(tr) }
    })
    this.extension = [EditorState.syntax(this), this.field.extension]
    this.indentation = EditorState.indentation((state: EditorState, pos: number) => {
      return state.field(this.field).getIndent(this.parser, state, pos)
    })
  }

  tryGetTree(state: EditorState, from: number, to: number) {
    let field = state.field(this.field)
    return field.updateTree(this.parser, state, to, false) ? field.tree : null
  }

  getTree(state: EditorState, from: number, to: number) {
    let field = state.field(this.field)
    let rest = field.updateTree(this.parser, state, to, true) as CancellablePromise<Tree> | true
    return {tree: field.tree, rest: rest === true ? null : rest}
  }

  getPartialTree(state: EditorState, from: number, to: number) {
    let field = state.field(this.field)
    field.updateTree(this.parser, state, to, false)
    return field.tree
  }
  
  static legacy(mode: LegacyMode<any>): StreamSyntax {
    if (!mode.docTag) mode.docTag = "document.lang=" + mode.name
    return new StreamSyntax(new StreamParser(mode))
  }
}

const CACHE_STEP_SHIFT = 6, CACHE_STEP = 1 << CACHE_STEP_SHIFT

const MAX_RECOMPUTE_DISTANCE = 20e3

const WORK_SLICE = 100, WORK_PAUSE = 200

class SyntaxState<ParseState> {
  requests: RequestInfo[] = []
  working = -1

  constructor(public tree: Tree,
              // Slot 0 stores the start state (line 1), slot 1 the
              // state at the start of line 65, etc, so lineNo ==
              // (index * CACHE_STEP) + 1
              public cache: ParseState[],
              public frontierLine: number,
              public frontierPos: number,
              public frontierState: ParseState | null) {}

  apply(tr: Transaction) {
    if (!tr.docChanged) return this
    let {start, number} = tr.doc.lineAt(tr.changes.changedRanges()[0].fromA)
    if (number >= this.frontierLine)
      return new SyntaxState(this.tree, this.cache.slice(), this.frontierLine, this.frontierPos, this.frontierState)
    else {
      return new SyntaxState(this.tree.cut(start),
                             this.cache.slice(0, (number >> CACHE_STEP_SHIFT) + 1), number, start, null)
    }
  }

  maybeStoreState(parser: StreamParser<ParseState>, lineBefore: number, state: ParseState) {
    if (lineBefore % CACHE_STEP == 0)
      this.cache[(lineBefore - 1) >> CACHE_STEP_SHIFT] = parser.copyState(state)
  }

  findState(parser: StreamParser<ParseState>, editorState: EditorState, line: number) {
    let cacheIndex = Math.min(this.cache.length - 1, (line - 1) >> CACHE_STEP_SHIFT)
    let cachedLine = (cacheIndex << CACHE_STEP_SHIFT) + 1
    let startPos = editorState.doc.line(cachedLine).start
    if (line - cachedLine > CACHE_STEP && editorState.doc.line(line).start - startPos > MAX_RECOMPUTE_DISTANCE)
      return null
    let state = parser.copyState(this.cache[cacheIndex])
    let cursor = new StringStreamCursor(editorState.doc, startPos, editorState.tabSize)
    for (let l = cachedLine; l < line; l++) {
      let stream = cursor.next()
      if (stream.eol()) {
        parser.blankLine(state, editorState)
      } else {
        while (!stream.eol()) parser.readToken(state, stream, editorState)
      }
      this.maybeStoreState(parser, l, state)
    }
    return state
  }

  advanceFrontier(parser: StreamParser<ParseState>, editorState: EditorState, upto: number) {
    let state = this.frontierState || this.findState(parser, editorState, this.frontierLine)!
    let sliceEnd = Date.now() + WORK_SLICE
    let cursor = new StringStreamCursor(editorState.doc, this.frontierPos, editorState.tabSize)
    let buffer: number[] = []
    let line = this.frontierLine, pos = this.frontierPos
    while (pos < upto) {
      let stream = cursor.next(), offset = cursor.offset
      if (stream.eol()) {
        parser.blankLine(state, editorState)
      } else {
        while (!stream.eol()) {
          let type = parser.readToken(state, stream, editorState)
          if (type) buffer.push(tokenID(type), offset + stream.start, offset + stream.pos, 4)
        }
      }
      this.maybeStoreState(parser, line, state)
      line++
      pos += stream.string.length + 1
      if (Date.now() > sliceEnd) break
    }
    let tree = Tree.build(buffer, nodeGroup, parser.docType).balance()
    this.tree = this.tree.append(tree).balance()
    this.frontierLine = line
    this.frontierPos = pos
    this.frontierState = state
  }

  updateTree(parser: StreamParser<ParseState>, state: EditorState, upto: number, rest: boolean): boolean | CancellablePromise<Tree> {
    // FIXME make sure multiple calls in same frame don't keep doing work
    if (this.frontierPos >= upto) return true
    if (this.working == -1) this.advanceFrontier(parser, state, upto)
    if (this.frontierPos >= upto) return true
    if (!rest) return false
    let req = this.requests.find(r => r.upto == upto && !r.promise.canceled)
    if (!req) {
      req = new RequestInfo(upto)
      this.requests.push(req)
    }
    this.scheduleWork(parser, state)
    return req.promise
  }

  scheduleWork(parser: StreamParser<ParseState>, state: EditorState) {
    if (this.working != -1) return
    this.working = setTimeout(() => this.work(parser, state), WORK_PAUSE) as any
  }

  work(parser: StreamParser<ParseState>, state: EditorState) {
    this.working = -1
    let upto = this.requests.reduce((max, req) => req.promise.canceled ? max : Math.max(max, req.upto), 0)
    if (upto > this.frontierPos) this.advanceFrontier(parser, state, upto)

    this.requests = this.requests.filter(req => {
      if (req.upto > this.frontierPos && !req.promise.canceled) return true
      if (!req.promise.canceled) req.resolve(this.tree)
      return false
    })
    if (this.requests.length) this.scheduleWork(parser, state)
  }

  getIndent(parser: StreamParser<ParseState>, state: EditorState, pos: number) {
    let line = state.doc.lineAt(pos)
    let parseState = this.findState(parser, state, line.number)
    if (parseState == null) return -1
    let text = line.slice(pos - line.start, Math.min(line.end, pos + 100) - line.start)
    return parser.indent(parseState, /^\s*(.*)/.exec(text)![1], state)
  }
}

const tokenTable: {[name: string]: number} = Object.create(null)
const typeArray: NodeType[] = [NodeType.none]
const nodeGroup = new NodeGroup(typeArray)

function resolveStyle(tag: string) {
  let parts = tag.split("."), style = Style as any
  for (let i = 0; i < parts.length; i++) {
    style = style[parts[i]]
    if (!style || style.__id == null) return null
  }
  return style.__id
}

function tokenID(tag: string) {
  let id = tokenTable[tag]
  if (id == null) {
    let styleID = resolveStyle(tag)
    if (styleID == null) {
      id = 0
    } else {
      id = tokenTable[tag] = typeArray.length
      typeArray.push(new NodeType(tag, styleNodeProp.set({}, id), id))
    }
  }
  return id
}

export function legacyMode(spec: LegacyMode<any>) {
  let syntax = StreamSyntax.legacy(spec)
  // FIXME add behavior for commenting, electric chars, etc
  return [syntax.extension, syntax.indentation]
}
