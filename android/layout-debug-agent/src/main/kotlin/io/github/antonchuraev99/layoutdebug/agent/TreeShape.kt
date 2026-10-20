package io.github.antonchuraev99.layoutdebug.agent

import java.util.IdentityHashMap

/** A box in pixels of the captured frame: left/top inclusive, right/bottom exclusive. */
internal data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
}

/**
 * One selectable node of the tree the window shows. Built from ui-tooling `Group`s by
 * [TreeCapture]; everything after that is plain data, so the passes below are pure.
 *
 * @param layoutNode the Compose `LayoutNode` a live override acts on (any type here: the
 *   passes never look inside it).
 */
internal class TreeNode(
    var kind: String,
    var sourceFile: String?,
    var sourceLine: Int,
    val box: Box,
    var layoutNode: Any?,
) {
    /** The layout node this group itself emits, before ancestors inherit one: the stable id. */
    var ownLayoutNode: Any? = layoutNode
    var id: String = ""
    var parent: TreeNode? = null
    var children: MutableList<TreeNode> = ArrayList()
    var depth: Int = 0

    /**
     * The call sits in a Compose library file (a lazy item's `SaveableStateProvider`, a
     * Scaffold slot's `Layout`), or has no source at all, rather than in the app's code.
     */
    var library: Boolean = sourceFile == null

    fun add(child: TreeNode) {
        child.parent = this
        children.add(child)
    }
}

/** What `/tree` carries next to the nodes. */
internal class TreeMeta(
    val pxPerUnit: Float,
    val widthPx: Int,
    val heightPx: Int,
    val packageName: String?,
    val pid: Int?,
)

/**
 * The passes that turn raw `asTree()` output into something a person can click through.
 *
 * Raw output has one group per composable *call*, so one visible element is a chain like
 * `Scaffold → Surface → CompositionLocalProvider → Box → Layout`, all with the same box.
 */
internal object TreeShape {

    /**
     * Moves each subcomposition (one slot table of a `SubcomposeLayout`: Scaffold slots, every
     * lazy-list item) under the node that hosts it, instead of leaving it a sibling of the
     * whole screen. A table's host is the parent layout node of its first emitted node,
     * looked up among the nodes of all tables; `parentOf` gives that parent.
     *
     * Children moved under one host are ordered top-to-bottom, then left-to-right: slot
     * tables come in no particular order, and the visual order is what a list shows.
     * A table whose host is not in the tree (the main table, a dialog) stays under [root].
     */
    fun attachSubcompositions(root: TreeNode, tables: List<TreeNode>, parentOf: (Any) -> Any?) {
        val byLayoutNode = IdentityHashMap<Any, TreeNode>()
        for (table in tables) index(table, byLayoutNode)
        val hosts = LinkedHashSet<TreeNode>()
        for (table in tables) {
            val first = firstEmitted(table)
            val host = first?.let { parentOf(it) }?.let { byLayoutNode[it] }
            val target = if (host != null && !isInside(host, table)) host else root
            for (child in table.children.toList()) target.add(child)
            table.children.clear()
            if (target !== root) hosts.add(target)
        }
        for (host in hosts) host.children.sortWith(compareBy({ it.box.top }, { it.box.left }))
    }

    /**
     * Collapses chains with the same box onto one node, which adopts the inner nodes' layout
     * node (also as its own when it has none, so its id stays stable).
     *
     * The node keeps the name and source of the outermost call in the app's code: in a chain
     * like `RowCard → Card → Surface → Layout` that is `RowCard`, and the inner ones point into
     * Compose. A chain that starts in Compose itself (the top of a lazy item or a Scaffold
     * slot is a library wrapper) takes the first [TreeNode.library]-free call inside it.
     */
    fun collapse(node: TreeNode) {
        while (node.children.size == 1) {
            val only = node.children[0]
            if (only.box != node.box) break
            if (node.library && !only.library) {
                node.kind = only.kind
                node.sourceFile = only.sourceFile
                node.sourceLine = only.sourceLine
                node.library = false
            }
            if (node.layoutNode == null) node.layoutNode = only.layoutNode
            if (node.ownLayoutNode == null) node.ownLayoutNode = only.ownLayoutNode
            node.children = only.children
            for (c in node.children) c.parent = node
        }
        for (child in node.children) collapse(child)
    }

    /** Gives every node the nearest descendant layout node, so a call group can be moved too. */
    fun inheritLayoutNodes(node: TreeNode): Any? {
        for (child in node.children) {
            val fromChild = inheritLayoutNodes(child)
            if (node.layoutNode == null) node.layoutNode = fromChild
        }
        return node.layoutNode
    }

    /**
     * Ids must survive a re-capture: an override recorded against one snapshot has to find
     * the same element in the next. A layout node's identity is stable for the life of the
     * composition, so it wins; anything else falls back to its position in the tree.
     */
    fun assignIds(node: TreeNode, depth: Int = 0, idOf: (Any) -> String = { "L${System.identityHashCode(it)}" }) {
        node.depth = depth
        val seen = HashSet<String>()
        node.children.forEachIndexed { index, child ->
            val own = child.ownLayoutNode
            var id = if (own != null) idOf(own) else "${node.id}.$index"
            // A layout node shared by two kept groups (rare) must not give two nodes one id.
            if (!seen.add(id)) id = "${node.id}.$index"
            child.id = id
            assignIds(child, depth + 1, idOf)
        }
    }

    /**
     * The `/tree` JSON (the shape `src/server/android.ts` reads as `DeviceTree`) and the
     * layout node behind every movable id.
     */
    fun serialize(root: TreeNode, meta: TreeMeta): Pair<String, Map<String, Any>> {
        val layoutNodes = HashMap<String, Any>()
        val out = StringBuilder()
        out.append('{')
        out.append("\"target\":\"android\"")
        out.append(",\"unit\":\"dp\"")
        // Boxes stay in device pixels so they line up with the screenshot 1:1; divide by
        // this to get the dp an agent should write into code.
        out.append(",\"pxPerUnit\":").append(meta.pxPerUnit)
        out.append(",\"viewport\":{\"w\":").append(meta.widthPx)
            .append(",\"h\":").append(meta.heightPx)
            .append(",\"scale\":").append(meta.pxPerUnit).append('}')
        out.append(",\"rootId\":").appendJsonString(root.id)
        meta.packageName?.let { out.append(",\"package\":").appendJsonString(it) }
        meta.pid?.let { out.append(",\"pid\":").append(it) }
        out.append(",\"nodes\":{")
        var first = true
        walk(root) { node ->
            node.layoutNode?.let { layoutNodes[node.id] = it }
            if (!first) out.append(',')
            first = false
            appendNode(out, node)
        }
        out.append("}}")
        return out.toString() to layoutNodes
    }

    private fun appendNode(out: StringBuilder, node: TreeNode) {
        out.appendJsonString(node.id).append(":{")
        out.append("\"id\":").appendJsonString(node.id)
        out.append(",\"parentId\":")
        val parentId = node.parent?.id
        if (parentId == null) out.append("null") else out.appendJsonString(parentId)
        out.append(",\"childIds\":[")
        node.children.forEachIndexed { i, c ->
            if (i > 0) out.append(',')
            out.appendJsonString(c.id)
        }
        out.append(']')
        out.append(",\"depth\":").append(node.depth)
        out.append(",\"kind\":").appendJsonString(node.kind)
        val file = node.sourceFile
        val label = if (file == null) node.kind else "${node.kind} ($file:${node.sourceLine})"
        out.append(",\"label\":").appendJsonString(label)
        out.append(",\"bounds\":{\"x\":").append(node.box.left)
            .append(",\"y\":").append(node.box.top)
            .append(",\"w\":").append(node.box.width)
            .append(",\"h\":").append(node.box.height).append('}')
        out.append(",\"source\":")
        if (file == null) {
            out.append("null")
        } else {
            out.append("{\"file\":").appendJsonString(file)
            out.append(",\"line\":").append(node.sourceLine).append('}')
        }
        out.append(",\"movable\":").append(node.layoutNode != null)
        out.append('}')
    }

    private fun walk(node: TreeNode, visit: (TreeNode) -> Unit) {
        visit(node)
        for (child in node.children) walk(child, visit)
    }

    private fun index(node: TreeNode, into: IdentityHashMap<Any, TreeNode>) {
        node.ownLayoutNode?.let { if (!into.containsKey(it)) into[it] = node }
        for (child in node.children) index(child, into)
    }

    /** The first node, breadth-first, that emits a layout node of its own. */
    private fun firstEmitted(table: TreeNode): Any? {
        val queue = ArrayDeque(table.children)
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            n.ownLayoutNode?.let { return it }
            queue.addAll(n.children)
        }
        return null
    }

    private fun isInside(node: TreeNode, ancestor: TreeNode): Boolean {
        var cur: TreeNode? = node
        while (cur != null) {
            if (cur === ancestor) return true
            cur = cur.parent
        }
        return false
    }
}
