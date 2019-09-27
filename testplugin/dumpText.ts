import {EditorState, Transaction, StateField} from "../state/src"
import {Text} from "../doc/src"
import dagre, { graphlib } from "dagre-d3"
import * as d3 from "d3"
import {TextLeaf, TextNode} from  "../doc/src/text"
import { stat } from "fs"

class Test {
    graph: graphlib.Graph | null
    render: dagre.Render | null
    target: d3.Selection<any> | null
}

function dumpText(text: Text, state: Test) {
    if (!state.graph) {
        state.graph = new dagre.graphlib.Graph().setGraph({}).setDefaultEdgeLabel(function() { return {}; })
        state.render = new dagre.render();
        state.target = d3.select("#graph_text").append("g")
    }

    let g = state.graph
    let render = state.render
    let target = state.target
    let nodeId: number = 0

    g.nodes().forEach(node => g.removeNode(node))
    g.edges().forEach(edge => g.removeEdge(edge.w, edge.v))

    function dump(text: Text, parentId: number | null) {
        if (null != parentId) {
            nodeId++
            g.setEdge(`node${parentId}`, `node${nodeId}`)
        }

        switch (true) {
        case text instanceof TextLeaf:
            let leaf = text as TextLeaf
            g.setNode(`node${nodeId}`,  { label: "TextLeaf", class: "type-S" })
            let _nodeId = nodeId
            for (let str of leaf.text)  {
                nodeId++
                g.setEdge(`node${_nodeId}`, `node${nodeId}`)
                g.setNode(`node${nodeId}`,  { label: str.replace(/\"/g, "\\\""), class: "type-S" })
            }
            break
        case text instanceof TextNode:
            let node = text as TextNode
            g.setNode(`node${nodeId}`,  { label: "TextNode", class: "type-S" })
            for (let nd of node.children) {
                dump(nd, nodeId)
            }
            break
        }
    }

    dump(text, null)

    g.nodes().forEach(function(v) {
        var node = g.node(v);
        node.rx = node.ry = 5;
    });

    render(target, g);
}

export const dumpTextField = new StateField({
  init(editorState: EditorState): Test {
    return new Test()
  },

  apply(tr: Transaction, state: Test, editorState: EditorState): Test {
        if (tr.docChanged) 
            dumpText(tr.doc, state)
      return state
  }
})