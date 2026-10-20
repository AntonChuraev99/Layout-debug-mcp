@file:OptIn(UiToolingDataApi::class)

package io.github.antonchuraev99.layoutdebug.agent

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import androidx.compose.runtime.tooling.CompositionData
import androidx.compose.ui.layout.LayoutInfo
import androidx.compose.ui.tooling.data.Group
import androidx.compose.ui.tooling.data.NodeGroup
import androidx.compose.ui.tooling.data.UiToolingDataApi
import androidx.compose.ui.tooling.data.asTree
import java.util.Collections
import java.util.IdentityHashMap

/**
 * Turns the live composition of the resumed activity into the `/tree` answer.
 *
 * The slot tables come from Compose itself: with `isDebugInspectorInfoEnabled` set before
 * the screen is composed (the agent does it at app start), every `ComposeView` keeps a set
 * of its slot tables under the `inspection_slot_table_set` view tag and provides it as
 * `LocalInspectionTables`, so each subcomposition (`SubcomposeLayout`: Scaffold, lazy lists,
 * the navigation host) adds its own table there. This is what Android Studio's Layout
 * Inspector relies on; the app's code does not change.
 */
internal object TreeCapture {

    class Result(val json: String, val nodes: Map<String, Any>)

    /** Must run on the main thread: it reads live composition state. */
    fun capture(activity: Activity, meta: (widthPx: Int, heightPx: Int) -> TreeMeta): Result {
        val content = activity.findViewById<View>(android.R.id.content)
            ?: return error("the activity has no content view")
        if (content.width <= 0 || content.height <= 0) return error("the content view is not laid out yet")
        // ui-tooling boxes are in window coordinates; the screenshot starts at the content view.
        val origin = IntArray(2).also(content::getLocationInWindow)

        val tables = slotTables(activity.window.decorView)
        if (tables.isEmpty()) {
            return error(
                "no Compose slot tables on this screen: either it has no Compose content, or it " +
                    "was composed before the agent started (call LayoutDebug.install before the " +
                    "first activity is created, or restart the activity)",
            )
        }

        val root = TreeNode("Composition", null, -1, Box(0, 0, content.width, content.height), null)
        root.id = "root"
        // The root stays "Composition" whatever full-screen call it absorbs.
        root.library = false
        val tableRoots = tables.mapNotNull { table ->
            val tree = runCatching { table.asTree() }
                .onFailure { log("could not read a slot table: ${it.message}") }
                .getOrNull() ?: return@mapNotNull null
            TreeNode("Table", null, -1, root.box, null).also { build(tree, it, origin) }
        }
        TreeShape.attachSubcompositions(root, tableRoots) { node -> (node as? LayoutInfo)?.parentInfo }
        TreeShape.collapse(root)
        TreeShape.inheritLayoutNodes(root)
        TreeShape.assignIds(root)
        val (json, nodes) = TreeShape.serialize(root, meta(content.width, content.height))
        return Result(json, nodes)
    }

    private fun error(message: String) = Result(Json.error(message), emptyMap())

    /** Every slot table set any view of this window carries, deduplicated. */
    private fun slotTables(view: View): List<CompositionData> {
        val found = Collections.newSetFromMap(IdentityHashMap<CompositionData, Boolean>())
        collect(view, found)
        return found.toList()
    }

    private fun collect(view: View, into: MutableSet<CompositionData>) {
        val tag = view.getTag(androidx.compose.ui.R.id.inspection_slot_table_set) as? Set<*>
        if (tag != null) {
            // The composer adds to this set on the main thread, where we are.
            for (item in tag.toList()) if (item is CompositionData) into.add(item)
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) collect(view.getChildAt(i), into)
        }
    }

    /** Keeps groups that occupy space and can be named; hoists the children of the rest. */
    private fun build(group: Group, parent: TreeNode, origin: IntArray) {
        val target = if (keep(group)) {
            val loc = group.location
            val b = group.box
            TreeNode(
                kind = kindOf(group),
                sourceFile = loc?.sourceFile,
                sourceLine = loc?.lineNumber ?: -1,
                box = Box(b.left - origin[0], b.top - origin[1], b.right - origin[0], b.bottom - origin[1]),
                layoutNode = (group as? NodeGroup)?.node,
            ).also {
                it.library = loc == null || ComposePackages.isLibrary(loc.packageHash)
                parent.add(it)
            }
        } else {
            parent
        }
        for (child in group.children) build(child, target, origin)
    }

    private fun keep(group: Group): Boolean {
        val box = group.box
        if (box.right - box.left <= 0 || box.bottom - box.top <= 0) return false
        return group is NodeGroup || group.name != null
    }

    private fun kindOf(group: Group): String =
        group.name ?: (group as? NodeGroup)?.node?.javaClass?.simpleName ?: "Group"
}
