import {EditorState, EditorSelection} from "../state/src"
import {EditorView} from "../view/src/"
import {keymap} from "../keymap/src/keymap"
import {history, redo, redoSelection, undo, undoSelection} from "../history/src/history"
import {lineNumbers, GutterMarker, lineNumberMarkers} from "../gutter/src/index"
import {baseKeymap, indentSelection} from "../commands/src/commands"
import {bracketMatching} from "../matchbrackets/src/matchbrackets"
import {specialChars} from "../special-chars/src/special-chars"
import {multipleSelections} from "../multiple-selections/src/multiple-selections"
import {syntaxIndentation} from "../syntax/src"

import {html} from "../html/src/html"
import {defaultTheme, highlight} from "../theme/src/"
import {dumpTextField} from "../testplugin/dumpText"
import {dumpHeightMapPlugin} from "../testplugin/dumpHeightMap"

let isMac = /Mac/.test(navigator.platform)
let state = EditorState.create({doc: `<script>
  const {readFile} = require("fs");

  readFile("package.json", "utf8", (err, data) => {
    console.log(data);
  });
</script>`, extensions: [  // extensions?: ReadonlyArray<Extension>
  lineNumbers(), // 返回了一个Extension
  history(),
  dumpTextField.extension,
  dumpHeightMapPlugin,
  specialChars(),
  multipleSelections(),
  html(),
  syntaxIndentation,
  defaultTheme,
  highlight(),
  bracketMatching(),
  keymap({
    "Mod-z": undo,
    "Mod-Shift-z": redo,
    "Mod-u": view => undoSelection(view) || true,
    [isMac ? "Mod-Shift-u" : "Alt-u"]: redoSelection,
    "Ctrl-y": isMac ? undefined : redo,
    "Shift-Tab": indentSelection
  }),
  keymap(baseKeymap),
]})

let view = (window as any).view = new EditorView({state})
document.querySelector("#editor").appendChild(view.dom)

class MyMarker extends GutterMarker<void> {
  toDOM() {
    let s = document.createElement("span")
    s.textContent = "★"
    s.style.color = "red"
    return s
  }
}

  let {selection, doc} = view.state
  let line = doc.lineAt(selection.primary.from).start
  view.dispatch(view.state.t().addMeta(lineNumberMarkers({add: [MyMarker.create(line, undefined)], filter: () => false})))