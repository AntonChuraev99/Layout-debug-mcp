package io.github.antonchuraev99.layoutdebug.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TreeShapeTest {

    /** Stands in for a Compose LayoutNode; `parent` plays LayoutInfo.parentInfo. */
    private class FakeLayoutNode(val name: String, val parent: FakeLayoutNode? = null) {
        override fun toString() = name
    }

    /** `library` defaults like TreeCapture: no source is library code; `Main.kt` is the app's. */
    private fun node(
        kind: String,
        box: Box,
        layoutNode: Any? = null,
        file: String? = null,
        line: Int = -1,
        library: Boolean = file == null || file != "Main.kt",
    ) = TreeNode(kind, file, line, box, layoutNode).also { it.library = library }

    private fun root(w: Int = 100, h: Int = 200) =
        node("Composition", Box(0, 0, w, h), library = false).also { it.id = "root" }

    private val ids: (Any) -> String = { it.toString() }

    @Test
    fun `same-box chain collapses onto the outer call and takes over its layout node as id`() {
        val root = root()
        val layout = FakeLayoutNode("Lcard")
        val card = node("Card", Box(0, 0, 50, 20), file = "Screen.kt", line = 12).also(root::add)
        val surface = node("Surface", Box(0, 0, 50, 20)).also(card::add)
        val inner = node("Layout", Box(0, 0, 50, 20), layout).also(surface::add)
        node("Text", Box(4, 4, 40, 16), FakeLayoutNode("Ltext")).also(inner::add)

        TreeShape.collapse(root)
        TreeShape.inheritLayoutNodes(root)
        TreeShape.assignIds(root, idOf = ids)

        assertEquals(1, root.children.size)
        val kept = root.children[0]
        assertEquals("Card", kept.kind)
        assertEquals("Screen.kt", kept.sourceFile)
        assertSame(layout, kept.layoutNode)
        assertEquals("Lcard", kept.id)
        assertEquals(listOf("Ltext"), kept.children.map { it.id })
        assertSame(kept, kept.children[0].parent)
    }

    @Test
    fun `a call group with no layout node of its own gets a positional id but stays movable`() {
        val root = root()
        val call = node("Header", Box(0, 0, 100, 40)).also(root::add)
        node("Text", Box(0, 0, 60, 20), FakeLayoutNode("Lt1")).also(call::add)
        node("Text", Box(0, 20, 60, 40), FakeLayoutNode("Lt2")).also(call::add)

        TreeShape.collapse(root)
        TreeShape.inheritLayoutNodes(root)
        TreeShape.assignIds(root, idOf = ids)

        assertEquals("root.0", call.id)
        assertEquals("Lt1", call.layoutNode.toString())
        assertEquals(listOf("Lt1", "Lt2"), call.children.map { it.id })
        assertEquals(2, call.children[1].depth)
    }

    @Test
    fun `subcompositions are attached under their host, ordered top to bottom`() {
        val list = FakeLayoutNode("Llist")
        val main = node("Table", Box(0, 0, 100, 200))
        val screen = node("Screen", Box(0, 0, 100, 200), file = "Main.kt", line = 3).also(main::add)
        val lazy = node("LazyColumn", Box(0, 40, 100, 200), list).also(screen::add)

        // Two lazy items, each its own slot table, in no particular order.
        val item2 = node("Table", Box(0, 0, 100, 200))
        node("RowCard", Box(0, 100, 100, 140), FakeLayoutNode("Litem2", list)).also(item2::add)
        val item1 = node("Table", Box(0, 0, 100, 200))
        node("RowCard", Box(0, 50, 100, 90), FakeLayoutNode("Litem1", list)).also(item1::add)
        // A table whose host is not in the tree (a dialog) stays at the root.
        val dialog = node("Table", Box(0, 0, 100, 200))
        node("Dialog", Box(10, 10, 90, 90), FakeLayoutNode("Ldialog", FakeLayoutNode("window"))).also(dialog::add)

        val root = root()
        TreeShape.attachSubcompositions(root, listOf(item2, main, dialog, item1)) { (it as FakeLayoutNode).parent }

        assertEquals(listOf("Screen", "Dialog"), root.children.map { it.kind })
        assertEquals(listOf("Litem1", "Litem2"), lazy.children.map { it.layoutNode.toString() })
        assertSame(lazy, lazy.children[0].parent)
        assertTrue(item1.children.isEmpty())
    }

    @Test
    fun `a lazy item takes the name and source of the app's call, not of Compose's wrapper`() {
        val list = FakeLayoutNode("Llist")
        val main = node("Table", Box(0, 0, 100, 200))
        val lazy = node("LazyColumn", Box(0, 0, 100, 200), list, file = "Main.kt", line = 5).also(main::add)
        node("Header", Box(0, 0, 100, 10), FakeLayoutNode("Lheader")).also(lazy::add)
        val item = node("Table", Box(0, 0, 100, 200))
        val wrapper = node("SkippableItem", Box(0, 50, 100, 90), file = "LazyLayoutItemContentFactory.kt", line = 95)
            .also(item::add)
        val card = node("Card", Box(0, 50, 100, 90), file = "Main.kt", line = 40).also(wrapper::add)
        node("Surface", Box(0, 50, 100, 90), FakeLayoutNode("Lcard", list)).also(card::add)
            .also { it.add(node("Text", Box(4, 54, 50, 70), FakeLayoutNode("Ltext"), file = "Main.kt", line = 42)) }
        val root = root()

        TreeShape.attachSubcompositions(root, listOf(main, item)) { (it as FakeLayoutNode).parent }
        TreeShape.collapse(root)
        TreeShape.assignIds(root, idOf = ids)

        val kept = lazy.children.single { it.box.top == 50 }
        assertEquals("Card", kept.kind)
        assertEquals("Main.kt", kept.sourceFile)
        assertEquals(40, kept.sourceLine)
        assertEquals("Lcard", kept.id)
        assertEquals(listOf("Text"), kept.children.map { it.kind })
        assertFalse(kept.library)
        assertEquals("LazyColumn", lazy.kind)
    }

    @Test
    fun `the outermost app call wins over inner app and library calls`() {
        val root = root()
        val rowCard = node("RowCard", Box(0, 0, 50, 20), file = "Main.kt", line = 30).also(root::add)
        val card = node("Card", Box(0, 0, 50, 20), file = "Main.kt", line = 40).also(rowCard::add)
        node("Layout", Box(0, 0, 50, 20), FakeLayoutNode("Lcard"), file = "Box.kt", line = 72).also(card::add)

        TreeShape.collapse(root)

        val kept = root.children.single()
        assertEquals("RowCard", kept.kind)
        assertEquals(30, kept.sourceLine)
        assertEquals("Lcard", kept.ownLayoutNode.toString())
    }

    @Test
    fun `colliding ids in two subtrees still give every node its own id`() {
        val root = root()
        val left = node("Left", Box(0, 0, 50, 100), FakeLayoutNode("a")).also(root::add)
        val right = node("Right", Box(50, 0, 100, 100), FakeLayoutNode("b")).also(root::add)
        node("Text", Box(0, 0, 10, 10), FakeLayoutNode("c")).also(left::add)
        node("Text", Box(50, 0, 60, 10), FakeLayoutNode("d")).also(right::add)

        // Every layout node maps to the same raw id: the worst identity-hash collision.
        TreeShape.assignIds(root) { "L1" }
        val all = listOf(root, left, right, left.children[0], right.children[0]).map { it.id }

        assertEquals(all.size, all.toSet().size)
        assertEquals("L1", left.id)
        assertEquals("root.1", right.id)
        val (json, nodes) = TreeShape.serialize(root, TreeMeta(1f, 100, 100, null, null))
        assertEquals(4, nodes.size)
        all.forEach { id -> assertEquals(1, Regex("\"${Regex.escape(id)}\":\\{").findAll(json).count()) }
    }

    @Test
    fun `stable ids give the same object the same id and colliding hashes distinct ids`() {
        val ids = StableIds(hash = { 7 })
        val a = Any()
        val b = Any()
        val idA = ids.idOf(a)
        val idB = ids.idOf(b)
        assertTrue(idA != idB)
        assertEquals(idA, ids.idOf(a))
        assertEquals(idB, ids.idOf(b))
        ids.prune()
        assertEquals(2, ids.size)
    }

    @Test
    fun `a table is never attached inside itself`() {
        val self = FakeLayoutNode("Lself")
        val table = node("Table", Box(0, 0, 10, 10))
        node("Box", Box(0, 0, 10, 10), FakeLayoutNode("Lchild", self)).also(table::add)
            .also { it.add(node("Inner", Box(0, 0, 5, 5), self)) }
        val root = root()

        TreeShape.attachSubcompositions(root, listOf(table)) { (it as FakeLayoutNode).parent }

        assertEquals(listOf("Box"), root.children.map { it.kind })
    }

    @Test
    fun `serialize writes the DeviceTree shape the desktop tool reads`() {
        val root = root(1080, 2400)
        val text = node("Text", Box(16, 32, 216, 82), FakeLayoutNode("Lt"), file = "Main.kt", line = 41).also(root::add)
        node("Spacer", Box(0, 90, 10, 100)).also(root::add)
        TreeShape.assignIds(root, idOf = ids)

        val (json, nodes) = TreeShape.serialize(root, TreeMeta(2.625f, 1080, 2400, "com.example.app", 4242))

        assertTrue(json.startsWith("{\"target\":\"android\",\"unit\":\"dp\",\"pxPerUnit\":2.625,"))
        assertTrue(json.contains("\"viewport\":{\"w\":1080,\"h\":2400,\"scale\":2.625}"))
        assertTrue(json.contains("\"rootId\":\"root\",\"package\":\"com.example.app\",\"pid\":4242"))
        assertTrue(
            json.contains(
                "\"Lt\":{\"id\":\"Lt\",\"parentId\":\"root\",\"childIds\":[],\"depth\":1,\"kind\":\"Text\"," +
                    "\"label\":\"Text (Main.kt:41)\",\"bounds\":{\"x\":16,\"y\":32,\"w\":200,\"h\":50}," +
                    "\"source\":{\"file\":\"Main.kt\",\"line\":41},\"movable\":true}",
            ),
        )
        assertTrue(json.contains("\"root\":{\"id\":\"root\",\"parentId\":null,\"childIds\":[\"Lt\",\"root.1\"]"))
        assertTrue(json.contains("\"root.1\":{\"id\":\"root.1\",\"parentId\":\"root\",\"childIds\":[],\"depth\":1,\"kind\":\"Spacer\",\"label\":\"Spacer\""))
        assertTrue(json.contains("\"source\":null,\"movable\":false}"))
        assertTrue(json.endsWith("}}"))
        assertEquals(setOf("Lt"), nodes.keys)
        assertSame(text.layoutNode, nodes["Lt"])
    }

    @Test
    fun `json strings are escaped`() {
        assertEquals("\"a\\\"b\\\\c\\nd\\u0001\\u2028\"", Json.string("a\"b\\c\nd\u0001 "))
        assertEquals("{\"error\":\"no \\\"tree\\\"\"}", Json.error("no \"tree\""))
        assertFalse(Json.string("Привет").contains("\\u"))
    }
}
