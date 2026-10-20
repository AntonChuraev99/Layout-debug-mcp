package io.github.antonchuraev99.layoutdebug.agent

import androidx.compose.ui.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TextAndCompatTest {

    private class Ln(val name: String) {
        override fun toString() = name
    }

    private fun node(kind: String, ln: Any?, file: String? = null, line: Int = -1) =
        TreeNode(kind, file, line, Box(0, 0, 10, 10), ln)

    @Test
    fun `text is cleaned, joined and capped`() {
        assertEquals("Row 1", NodeText.clean(listOf("  Row\n 1 ")))
        assertEquals("a b", NodeText.clean(listOf("a", "b")))
        assertNull(NodeText.clean(listOf("  ")))
        assertNull(NodeText.clean(null))
        val long = NodeText.clean(listOf("x".repeat(NodeText.MAX + 50)))!!
        assertEquals(NodeText.MAX, long.length)
        assertTrue(long.endsWith("…"))
    }

    @Test
    fun `text goes to the node that owns the layout node, not to its ancestors`() {
        val buttonLn = Ln("button")
        val textLn = Ln("label")
        val root = node("Composition", null).also { it.id = "root" }
        val button = node("Button", buttonLn, "Main.kt", 9).also(root::add)
        val label = node("Text", textLn, "Main.kt", 10).also(button::add)
        // The button's own layout node has no text semantics; its label Text has: only the Text gets it.
        val texts = mapOf<Any, NodeText>(textLn to NodeText("Primary", null))

        TreeShape.attachText(root) { texts[it] }

        assertNull(button.text)
        assertEquals("Primary", label.text)
        assertEquals("Text \"Primary\" (Main.kt:10)", TreeShape.labelOf(label))
        assertEquals("Button (Main.kt:9)", TreeShape.labelOf(button))
    }

    @Test
    fun `content description labels a node without text, and both reach the JSON`() {
        val icon = Ln("icon")
        val root = node("Composition", null).also { it.id = "root" }
        val image = node("Icon", icon, "Main.kt", 20).also(root::add)
        TreeShape.attachText(root) { if (it === icon) NodeText(null, "Close \"dialog\"") else null }
        TreeShape.assignIds(root) { "L1" }

        val (json, _) = TreeShape.serialize(root, TreeMeta(1f, 10, 10, null, null, "1.12.1"))

        assertEquals("Icon \"Close \"dialog\"\" (Main.kt:20)", TreeShape.labelOf(image))
        assertTrue(json.contains("\"contentDescription\":\"Close \\\"dialog\\\"\""))
        assertTrue(!json.contains("\"text\":"))
        assertTrue(json.contains("\"compose\":\"1.12.1\""))
    }

    @Test
    fun `a long text is shortened in the label but kept in the text field`() {
        val ln = Ln("t")
        val root = node("Composition", null).also { it.id = "root" }
        val text = node("Text", ln).also(root::add)
        val long = "y".repeat(100)
        TreeShape.attachText(root) { NodeText(long, null) }
        assertEquals("Text \"${"y".repeat(39)}…\"", TreeShape.labelOf(text))
        assertEquals(long, text.text)
    }

    @Test
    fun `a Text with its wrapper's box hands its text to the wrapper that absorbs it`() {
        // Card { Text("Save", Modifier.padding(16.dp)) }: Card -> Surface -> Text, one box.
        val surface = Ln("surface")
        val textLn = Ln("text")
        val root = TreeNode("Composition", null, -1, Box(0, 0, 100, 100), null).also { it.id = "root" }
        val card = TreeNode("Card", "Main.kt", 30, Box(0, 0, 50, 20), null).also { it.library = false; root.add(it) }
        val surfaceNode = TreeNode("Surface", "Card.kt", 1, Box(0, 0, 50, 20), surface).also(card::add)
        TreeNode("Text", "Main.kt", 31, Box(0, 0, 50, 20), textLn).also { it.library = false; surfaceNode.add(it) }
        val texts = mapOf<Any, NodeText>(textLn to NodeText("Save", "Save the draft"))

        TreeShape.attachText(root) { texts[it] }
        TreeShape.collapse(root)

        val kept = root.children.single()
        assertEquals("Card", kept.kind)
        assertTrue(kept.children.isEmpty())
        assertEquals("Save", kept.text)
        assertEquals("Save the draft", kept.contentDescription)
        assertEquals("Card \"Save\" (Main.kt:30)", TreeShape.labelOf(kept))
    }

    @Test
    fun `a wrapper with text of its own keeps it`() {
        val root = TreeNode("Composition", null, -1, Box(0, 0, 100, 100), null).also { it.id = "root" }
        val outer = TreeNode("Chip", "Main.kt", 5, Box(0, 0, 50, 20), Ln("chip")).also(root::add)
        TreeNode("Text", "Main.kt", 6, Box(0, 0, 50, 20), Ln("t")).also { outer.add(it) }
        TreeShape.attachText(root) { if (it.toString() == "chip") NodeText(null, "Filter") else NodeText("Inner", null) }
        TreeShape.collapse(root)
        val kept = root.children.single()
        assertEquals("Inner", kept.text)
        assertEquals("Filter", kept.contentDescription)
    }

    @Test
    fun `only missing or unreachable APIs are called unsupported`() {
        assertTrue(ComposeVersion.isMissingApi(NoSuchMethodError("setModifier")))
        assertTrue(ComposeVersion.isMissingApi(NoSuchFieldError("inspection_slot_table_set")))
        assertTrue(ComposeVersion.isMissingApi(NoClassDefFoundError("androidx/compose/ui/node/RootForTest")))
        assertTrue(ComposeVersion.isMissingApi(ClassNotFoundException("x")))
        assertTrue(ComposeVersion.isMissingApi(IllegalAccessException("x")))
        assertTrue(ComposeVersion.isMissingApi(NoSuchMethodException("x")))
        assertTrue(!ComposeVersion.isMissingApi(IllegalStateException("x")))
        assertTrue(!ComposeVersion.isMissingApi(NullPointerException()))

        val missing = ComposeVersion.failure("swapping failed", NoSuchMethodError("setModifier"))
        assertTrue(missing, missing.contains("This Compose version is not supported"))
        assertTrue(missing, missing.contains(" on Compose UI "))
        val bug = ComposeVersion.failure("swapping failed", IllegalStateException("boom"))
        assertTrue(bug, bug.startsWith("layout-debug agent error: swapping failed (IllegalStateException: boom)"))
        assertTrue(bug, bug.contains("Please report it"))
        assertTrue(bug, !bug.contains("not supported"))
        // The cause inside a reflective call decides, not the wrapper around it.
        val wrapped = java.lang.reflect.InvocationTargetException(IllegalStateException("inner"))
        assertTrue(ComposeVersion.failure("x", wrapped).contains("IllegalStateException: inner"))
        assertTrue(ComposeVersion.failure("x", wrapped).startsWith("layout-debug agent error"))
    }

    @Test
    fun `warnings and dropped live edits go out with the tree`() {
        val root = TreeNode("Composition", null, -1, Box(0, 0, 10, 10), null).also { it.id = "root" }
        TreeShape.assignIds(root) { "L1" }
        val (json, _) = TreeShape.serialize(
            root,
            TreeMeta(1f, 10, 10, null, null),
            TreeNotes(listOf("element text is \"unavailable\""), listOf(OverrideError("L7", "dropped"))),
        )
        assertTrue(json, json.contains(",\"warnings\":[\"element text is \\\"unavailable\\\"\"]"))
        assertTrue(json, json.contains(",\"overrideErrors\":[{\"id\":\"L7\",\"error\":\"dropped\"}]"))
        val (plain, _) = TreeShape.serialize(root, TreeMeta(1f, 10, 10, null, null))
        assertTrue(!plain.contains("warnings") && !plain.contains("overrideErrors"))
    }

    @Test
    fun `a prefetched lazy item that is not placed leaves no node at the top-left`() {
        val placed = Ln("placed")
        val unplacedRow = Ln("unplacedRow")
        val unplacedText = Ln("unplacedText")
        val table = node("Table", null)
        // Visible item: RowCard -> Row (placed).
        node("RowCard", null, "Main.kt", 75).also(table::add).add(node("Row", placed, "Main.kt", 106))
        // Prefetched item: RowCard -> Row -> Column -> Text, all reported at (0, 0), none placed.
        val ghost = node("RowCard", null, "Main.kt", 75).also(table::add)
        val ghostRow = node("Row", unplacedRow, "Main.kt", 106).also(ghost::add)
        ghostRow.add(node("Text", unplacedText, "Main.kt", 117))
        // A call group with nothing under it at all is not ours to remove.
        node("Spacer", null, "Main.kt", 80).also(table::add)

        TreeShape.dropUnplaced(table) { it === placed }

        assertEquals(listOf("RowCard", "Spacer"), table.children.map { it.kind })
        assertEquals(listOf("Row"), table.children[0].children.map { it.kind })
    }

    @Suppress("unused")
    class WithAccessors {
        private var m: Modifier = Modifier

        @JvmName("getModifier\$ui_release")
        fun readModifier(): Modifier = m

        @JvmName("setModifier\$ui_release")
        fun writeModifier(value: Modifier) {
            m = value
        }
    }

    @Suppress("unused")
    class GetterOnly {
        @JvmName("getModifier\$ui_release")
        fun readModifier(): Modifier = Modifier
    }

    @Test
    fun `modifier accessors are found by mangled name, and a miss says what is missing`() {
        val found = ModifierAccess.find(WithAccessors::class.java)
        assertTrue(found is ModifierAccess.Lookup.Found)
        val target = WithAccessors()
        val tweak: Modifier = object : Modifier.Element {}
        (found as ModifierAccess.Lookup.Found).accessors.set(target, tweak)
        assertTrue(found.accessors.get(target) === tweak)

        val getterOnly = ModifierAccess.find(GetterOnly::class.java) as ModifierAccess.Lookup.Missing
        assertTrue(getterOnly.what, getterOnly.what.contains("setModifier*(Modifier)"))
        assertTrue(!getterOnly.what.contains("getModifier*"))
        val none = ModifierAccess.find(Any::class.java) as ModifierAccess.Lookup.Missing
        assertTrue(none.what, none.what.contains("java.lang.Object has no public getModifier*(): Modifier and setModifier*(Modifier)"))
    }
}
