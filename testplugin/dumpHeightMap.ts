import {EditorState, Transaction, StateField} from "../state/src"
import {HeightMap, HeightMapBlock, HeightMapText, HeightMapGap, HeightMapBranch} from "../view/src/heightmap"
import {DocView} from "../view/src/docview"
import {ViewPlugin, viewPlugin, ViewUpdate} from "../view/src/extension"
import dagre, { graphlib, Render } from "dagre-d3"
import * as d3 from "d3"
import { EditorView } from "../view/src"


export const dumpHeightMapPlugin = viewPlugin((editorView: EditorView) => new MyViewPlugin(editorView))

function dumpHeightMap(heightmap: HeightMap, graph: graphlib.Graph, render: Render, canvas: d3.Selection<any>) {
    let nodeId: number = 0;

    graph.nodes().forEach(node => graph.removeNode(node))
    graph.edges().forEach(edge => graph.removeEdge(edge.w, edge.v))

    function dump(hm: HeightMap, parentId: number | null) {
        if (null != parentId) {
            nodeId++;
            graph.setEdge(`node${parentId}`, `node${nodeId}`)
        }

        switch (true) {
        case hm instanceof HeightMapBranch:
            graph.setNode(`node${nodeId}`,  { label: `type:branch\nlength:${hm.length}\nheight:${hm.height}\nsize:${hm.size}\nflags:${hm.flags}`, class: "type-S" })
            let id = nodeId
            let hmb = hm as HeightMapBranch;
            dump(hmb.left, id);
            dump(hmb.right, id);
            break;
        case hm instanceof HeightMapText:
            graph.setNode(`node${nodeId}`,  { label: `type:text\nlength:${hm.length}\nheight:${hm.height}\nsize:${hm.size}\nflags:${hm.flags}`, class: "type-S" })
            break;
        case hm instanceof HeightMapGap:
            graph.setNode(`node${nodeId}`,  { label: `type:gap\nlength:${hm.length}\nheight:${hm.height}\nsize:${hm.size}\nflags:${hm.flags}`, class: "type-S" })
            break;
        default:
            console.error("error heightMap type");
            break;
        }
    }

    graph.removeEdge
    dump(heightmap, null)


    graph.nodes().forEach(function(v) {
        var node = graph.node(v);
        node.rx = node.ry = 5;
    });

    render(canvas, graph)
}

class MyViewPlugin implements ViewPlugin {
    target: d3.Selection<any> | null
    render: dagre.Render
    graph: graphlib.Graph

    constructor(private view: EditorView) {

    }

    update(update: ViewUpdate) {
        if (undefined == this.graph) {
            this.graph = new dagre.graphlib.Graph().setGraph({}).setDefaultEdgeLabel(function() { return {}; })
            this.render = new dagre.render();
        }

        if (null == this.target || 0 == this.target.size()) {
            this.target = d3.select("#graph_height_map").append("g")
        }

        if (update.docChanged) {
            dumpHeightMap(update.view.docView.heightMap, this.graph, this.render, this.target)
        }
    }
}