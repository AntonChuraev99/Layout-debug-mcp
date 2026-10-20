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

    /** What the node shows, from the semantics of its own layout node (see [TreeShape.attachText]). */
    var text: String? = null
    var contentDescription: String? = null

    fun add(child: TreeNode) {
        child.parent = this
        children.add(child)
    }
}

/** Text a layout node's own (unmerged) semantics carries. */
internal class NodeText(val text: String?, val contentDescription: String?) {
    companion object {
        /** Longest text kept per node; the desktop tool caps it further for display. */
        const val MAX = 500

        /** Joined with spaces, whitespace collapsed, capped; null when nothing is left. */
        fun clean(parts: List<String>?): String? {
            val joined = parts?.joinToString(" ")?.replace(Regex("\\s+"), " ")?.trim()
            if (joined.isNullOrEmpty()) return null
            return if (joined.length > MAX) joined.take(MAX - 1) + "…" else joined
        }
    }
}

/** A live edit the agent could not re-apply after a capture, and has dropped. */
internal class OverrideError(val id: String, val error: String)

/**
 * What went wrong around a capture without failing it: [warnings] (the tree is served, but
 * something is missing, such as element text) and dropped live edits. The desktop tool shows them.
 */
internal class TreeNotes(
    val warnings: List<String> = emptyList(),
    val overrideErrors: List<OverrideError> = emptyList(),
)

/** What `/tree` carries next to the nodes. */
internal class TreeMeta(
    val pxPerUnit: Float,
    val widthPx: Int,
    val heightPx: Int,
    val packageName: String?,
    val pid: Int?,
    /** The app's Compose UI version, as the APK reports it. */
    val composeVersion: String? = null,
)

/**
 * The passes that turn raw `asTree()` output into something a person can click through.
 *
 * Raw output has one group per composable *call*, so one visible element is a chain like
 * `Scaffold → Surface → CompositionLocalProvider → Box → Layout`, all with the same box.
 */
internal object TreeShape {

    /**
     * Removes layout nodes that are composed but not placed, with everything under them, and
     * the call groups left empty by that. A lazy list composes items ahead of scrolling
     * (prefetch) and keeps some for reuse without placing them; ui-tooling reports such a
     * node at (0, 0) with its own size, so it would cover the top-left of the screen and win
     * clicks there. Run on each table before [attachSubcompositions].
     *
     * @return whether [node] lost all its children to this (the caller drops a call group then)
     */
    fun dropUnplaced(node: TreeNode, isPlaced: (Any) -> Boolean): Boolean {
        var removedAny = false
        val it = node.children.iterator()
        while (it.hasNext()) {
            val child = it.next()
            val own = child.ownLayoutNode
            if (own != null && !isPlaced(own)) {
                it.remove()
                removedAny = true
                continue
            }
            val emptied = dropUnplaced(child, isPlaced)
            if (emptied && child.ownLayoutNode == null && child.children.isEmpty()) {
                it.remove()
                removedAny = true
            }
        }
        return removedAny && node.children.isEmpty()
    }

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
            // `Box { Text("Hello") }`: the Text is absorbed, its words must not go with it.
            if (node.text == null) node.text = only.text
            if (node.contentDescription == null) node.contentDescription = only.contentDescription
            node.children = only.children
            for (c in node.children) c.parent = node
        }
        for (child in node.children) collapse(child)
    }

    /**
     * Gives each node the text of its own layout node, looked up by identity: the semantics
     * tree hangs off the same `LayoutNode` objects the slot tables emit, so no bounds
     * matching is needed. Only the node's own layout node counts: a `Button` does not take over
     * its label `Text`, which stays its child. Runs before [collapse], while every emitted node
     * still has its own tree node; [collapse] then hands the text to the node that absorbs it.
     */
    fun attachText(node: TreeNode, lookup: (Any) -> NodeText?) {
        node.ownLayoutNode?.let(lookup)?.let {
            node.text = it.text
            node.contentDescription = it.contentDescription
        }
        for (child in node.children) attachText(child, lookup)
    }

    /** `Text "Row 1" (Main.kt:12)`: the visible text, shortened, then the call site. */
    fun labelOf(node: TreeNode): String = buildString {
        append(node.kind)
        val shown = node.text ?: node.contentDescription
        if (shown != null) append(" \"").append(if (shown.length > LABEL_TEXT) shown.take(LABEL_TEXT - 1) + "…" else shown).append('"')
        node.sourceFile?.let { append(" (").append(it).append(':').append(node.sourceLine).append(')') }
    }

    private const val LABEL_TEXT = 40

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
     * composition, so it wins ([idOf], normally [StableIds.idOf]); anything else falls back to
     * its position in the tree. Ids are unique across the whole tree: `/tree` is a map keyed by
     * id, and a repeated key would silently drop a node and send a live edit to the wrong one.
     */
    fun assignIds(root: TreeNode, idOf: (Any) -> String) {
        val seen = HashSet<String>()
        seen.add(root.id)
        assignIds(root, 0, idOf, seen)
    }

    private fun assignIds(node: TreeNode, depth: Int, idOf: (Any) -> String, seen: MutableSet<String>) {
        node.depth = depth
        node.children.forEachIndexed { index, child ->
            val own = child.ownLayoutNode
            var id = if (own != null) idOf(own) else "${node.id}.$index"
            // One layout node behind two kept groups, or a broken idOf: never two nodes with one id.
            if (!seen.add(id)) {
                id = "${node.id}.$index"
                var n = 2
                while (!seen.add(id)) id = "${node.id}.$index~${n++}"
            }
            child.id = id
            assignIds(child, depth + 1, idOf, seen)
        }
    }

    /** The layout node behind every movable id (after [assignIds]). */
    fun layoutNodes(root: TreeNode): Map<String, Any> {
        val out = HashMap<String, Any>()
        walk(root) { node -> node.layoutNode?.let { out[node.id] = it } }
        return out
    }

    /**
     * The `/tree` JSON (the shape `src/server/android.ts` reads as `DeviceTree`) and the
     * layout node behind every movable id. [notes] go out as `warnings` and `overrideErrors`
     * when there are any.
     */
    fun serialize(root: TreeNode, meta: TreeMeta, notes: TreeNotes = TreeNotes()): Pair<String, Map<String, Any>> {
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
        meta.composeVersion?.let { out.append(",\"compose\":").appendJsonString(it) }
        if (notes.warnings.isNotEmpty()) {
            out.append(",\"warnings\":[")
            notes.warnings.forEachIndexed { i, w -> if (i > 0) out.append(','); out.appendJsonString(w) }
            out.append(']')
        }
        if (notes.overrideErrors.isNotEmpty()) {
            out.append(",\"overrideErrors\":[")
            notes.overrideErrors.forEachIndexed { i, e ->
                if (i > 0) out.append(',')
                out.append("{\"id\":").appendJsonString(e.id).append(",\"error\":").appendJsonString(e.error).append('}')
            }
            out.append(']')
        }
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
        out.append(",\"label\":").appendJsonString(labelOf(node))
        node.text?.let { out.append(",\"text\":").appendJsonString(it) }
        node.contentDescription?.let { out.append(",\"contentDescription\":").appendJsonString(it) }
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
