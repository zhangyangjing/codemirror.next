import {Text} from "../../doc/src/text"
import {EditorView} from "../../view/src"
import {Range} from "../../rangeset/src/rangeset"
import {EditorState, MetaSlot, Plugin, StateField, Transaction} from "../../state/src"
import {Decoration} from "../../view/src/decoration"

import {StringStreamCursor} from "./stringstreamcursor"
import {StringStream} from "./stringstream"
import {copyState, readToken, Mode} from "./util"

class CachedState<S> {
  constructor(public state: S, public pos: number) {}
  copy(mode: Mode<S>) { return new CachedState(copyState(mode, this.state), this.pos) }
}

const MAX_SCAN_DIST = 20000

type DecoratedRange = {from: number, to: number, decorations: ReadonlyArray<Range<Decoration>>}

function cutDecoratedRange(range: DecoratedRange | null, at: number) {
  if (!range || at <= range.from) return null
  return {from: range.from, to: Math.min(at, range.to), decorations: range.decorations.filter(({to}) => to <= at)}
}

class StateCache<S> {
  constructor(private states: CachedState<S>[], private frontier: number) {}

  getFrontier(): number { return this.frontier }

  storeStates(from: number, to: number, states: ReadonlyArray<CachedState<S>>) {
    let start = this.findIndex(from), end = this.findIndex(to)
    this.states.splice(start, end - start, ...states)
    if (from <= this.frontier) this.frontier = Math.max(this.frontier, to)
  }

  // Return the first index for which all cached states after it have
  // a position >= pos
  private findIndex(pos: number): number {
    // FIXME could be binary search
    let i = 0
    while (i < this.states.length && this.states[i].pos < pos) i++
    return i
  }

  private stateBefore(pos: number, mode: Mode<S>): {state: S, pos: number} {
    if (pos > this.frontier && pos - this.frontier < MAX_SCAN_DIST) pos = this.frontier
    let index = this.findIndex(pos)
    if (index < this.states.length && this.states[index].pos == pos) index++
    return index == 0 ? new CachedState(mode.startState(), 0) : this.states[index - 1].copy(mode)
  }

  getState(editorState: EditorState, pos: number, mode: Mode<S>): S {
    let {pos: statePos, state} = this.stateBefore(pos, mode)
    if (statePos < pos - MAX_SCAN_DIST) { statePos = pos; state = mode.startState() }
    if (statePos < pos) {
      let cursor = new StringStreamCursor(editorState.doc, statePos, editorState.tabSize)
      let stream = cursor.next()
      let start = statePos, i = 0, states: CachedState<S>[] = []
      while (statePos < pos) {
        if (stream.eol()) {
          stream = cursor.next()
          statePos++
          if (++i % 50) states.push(new CachedState(copyState(mode, state), statePos))
        } else {
          readToken(mode, stream, state)
          statePos += stream.pos - stream.start
          stream.start = stream.pos
        }
      }
      this.storeStates(start, pos, states)
    }
    return state
  }

  apply(transaction: Transaction): StateCache<S> {
    if (transaction.changes.length == 0) return this
    let {start} = transaction.doc.lineAt(transaction.changes.changes.reduce((m, ch) => Math.min(m, ch.from), 1e9))
    let states = []
    for (let cached of this.states) {
      let mapped = transaction.changes.mapPos(cached.pos, -1, true)
      if (mapped > 0) states.push(mapped == cached.pos ? cached : new CachedState(cached.state, mapped))
    }
    return new StateCache(states, Math.min(start, this.frontier))
  }
}

class TokenTypeCache<S> {
  constructor(private states: StateCache<S>, private doc: Text, private tabSize: number, private mode: Mode<S>) {}

  private calculateLine(lineNo: number, state?: S) {
    const line = this.doc.line(lineNo)
    state = state || this.states.getState({doc: this.doc, tabSize: this.tabSize}, line.start, this.mode)
    const tokens = []
    const stream = new StringStream(line.slice(), this.tabSize, null)
    for (; !stream.eol(); stream.start = stream.pos) {
      const type = readToken(this.mode, stream, state)
      if (type) tokens.push({from: stream.start, to: stream.pos, type})
    }
    return {tokens, state}
  }

  typeAt(pos: number): string | null {
    const line = this.doc.lineAt(pos)
    const lineTokens = this.linesTokens(line.number, line.number)
    for (const {from, to, type} of lineTokens)
      if (from <= pos) return pos < to ? type : null
    return null
  }

  linesTokens(fromLine: number, toLine: number): ReadonlyArray<{from: number, to: number, type: string}> {
    const states = []
    let result: {from: number, to: number, type: string}[] = []
    let state
    for (let lineNo = fromLine; lineNo <= toLine; ++lineNo) {
      const offset = this.doc.line(lineNo).start
      if (state && (lineNo - fromLine) % 5 == 0) states.push(new CachedState(copyState(this.mode, state), offset))
      let tokens
      ;({tokens, state} = this.calculateLine(lineNo, state))
      result = result.concat(tokens.map(({from, to, type}) => ({from: from + offset, to: to + offset, type})))
    }
    const endPos = this.doc.line(toLine).end + 1
    if (state && toLine % 5 == 0) states.push(new CachedState(copyState(this.mode, state), endPos))
    this.states.storeStates(this.doc.line(fromLine).start, endPos, states)
    return result
  }

  apply(stateCache: StateCache<S>, transaction: Transaction): TokenTypeCache<S> {
    const newTabSize = transaction.getMeta(MetaSlot.changeTabSize)
    return new TokenTypeCache(stateCache, transaction.doc, newTabSize !== undefined ? newTabSize : transaction.startState.tabSize, this.mode)
  }
}

class StyleCache<S> {
  private timeout?: number | NodeJS.Timer

  constructor(private states: StateCache<S>, private tokens: TokenTypeCache<S>, private lastDecorations: null | DecoratedRange) {}

  advanceFrontier(editorState: EditorState, to: number, mode: Mode<S>, sleepTime: number, maxWorkTime: number): Promise<void> {
    if (this.states.getFrontier() >= to) return Promise.reject()
    clearTimeout(this.timeout as any)
    return new Promise(resolve => {
      const f = () => {
        const endTime = +new Date + maxWorkTime
        do {
          const frontierBefore = this.states.getFrontier()
          const target = Math.min(to, frontierBefore + MAX_SCAN_DIST / 2)
          if (this.lastDecorations && frontierBefore < this.lastDecorations.from && this.lastDecorations.from <= target){
            this.lastDecorations = null
}
          this.states.getState(editorState, target, mode)
          if (this.states.getFrontier() >= to) return resolve()
        } while (+new Date < endTime)
        this.timeout = setTimeout(f, sleepTime)
      }
      this.timeout = setTimeout(f, sleepTime)
    })
  }

  private calculateDecorations(doc: Text, from: number, to: number, mode: Mode<S>): Range<Decoration>[] {
    const fromLine = doc.lineAt(from)
    const toLine = doc.lineAt(to)
    const tokens = this.tokens.linesTokens(fromLine.number, to == toLine.start ? toLine.number - 1 : toLine.number)
    let decorations = []
    for (const token of tokens) {
      if (token.from < to && token.to >= from) decorations.push(Decoration.range(token.from, token.to, {class: 'cm-' + token.type.replace(/ /g, ' cm-')}))
    }
    return decorations
  }

  getDecorations(doc: Text, from: number, to: number, mode: Mode<S>): Range<Decoration>[] {
    let upto = from, decorations: Range<Decoration>[] = []
    if (this.lastDecorations) {
      if (from < this.lastDecorations.from) {
        upto = Math.min(to, this.lastDecorations.from)
        decorations = this.calculateDecorations(doc, from, upto, mode)
      }
      if (upto < to && this.lastDecorations.to > upto) {
        upto = this.lastDecorations.to
        decorations = decorations.concat(this.lastDecorations.decorations)
      }
    }
    if (upto < to) {
      decorations = decorations.concat(this.calculateDecorations(doc, upto, to, mode))
    }
    this.lastDecorations = {from, to, decorations}
    return decorations
  }

  apply(transaction: Transaction): StyleCache<S> {
    if (transaction.changes.length == 0) return this
    let {start} = transaction.doc.lineAt(transaction.changes.changes.reduce((m, ch) => Math.min(m, ch.from), 1e9))
    const states = this.states.apply(transaction)
    return new StyleCache(states, this.tokens.apply(states, transaction), cutDecoratedRange(this.lastDecorations, start))
  }
}

type Config = {
  sleepTime?: number,
  maxWorkTime?: number
}

export function legacyMode<S>(mode: Mode<S>, config: Config = {}) {
  const {sleepTime = 100, maxWorkTime = 100} = config
  const field = new StateField<StyleCache<S>>({
    init(state: EditorState) {
      const stateCache = new StateCache<S>([], 0)
      return new StyleCache(stateCache, new TokenTypeCache<S>(stateCache, state.doc, state.tabSize, mode), null) },
    apply(tr, cache) { return cache.apply(tr) },
    debugName: "mode"
  })

  let plugin = new Plugin({
    state: field,
    view(v: EditorView) {
      let decorations = Decoration.none, from = -1, to = -1
      function update(v: EditorView, force: boolean) {
        let vp = v.viewport
        if (force || vp.from < from || vp.to > to) {
          ;({from, to} = vp)
          const stateCache = v.state.getField(field)!
          decorations = Decoration.set(stateCache.getDecorations(v.state.doc, from, to, mode))
          stateCache.advanceFrontier(v.state, from, mode, sleepTime, maxWorkTime).then(() => {
            update(v, true)
            v.decorationUpdate()
          }, () => {})
        }
      }
      return {
        get decorations() { return decorations },
        updateViewport: update,
        updateState: (v: EditorView, p: EditorState, trs: Transaction[]) => update(v, trs.some(tr => tr.docChanged))
      }
    }
  })

  // FIXME Short-term hack—it'd be nice to have a better mechanism for this,
  // not sure yet what it'd look like
  ;(plugin as any).indentation = function(state: EditorState, pos: number): number {
    if (!mode.indent) return -1
    let modeState = state.getField(field)!.states.getState(state, pos, mode)
    let line = state.doc.lineAt(pos)
    return mode.indent(modeState, line.slice(0, Math.min(line.length, 100)).match(/^\s*(.*)/)![1])
  }

  return plugin
}
