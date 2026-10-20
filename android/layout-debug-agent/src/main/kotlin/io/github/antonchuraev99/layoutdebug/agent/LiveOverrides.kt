package io.github.antonchuraev99.layoutdebug.agent

import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import java.lang.reflect.Method
import java.util.IdentityHashMap

/**
 * Live override channel: moves / resizes a running `LayoutNode` by swapping its Modifier,
 * so an element can be shifted on the device without a rebuild.
 *
 * All state here is touched on the main thread only (every entry point runs inside
 * [onMain]), so it needs no locking.
 */
internal object LiveOverrides {

    private data class Override(val dx: Int, val dy: Int, val w: Int, val h: Int)

    /** Layout nodes of the last capture: the targets overrides act on. */
    private var nodes: Map<String, Any> = emptyMap()

    /** Per node: the modifier it had before our tweak, and the tweaked one we set. */
    private class Swap(val base: Modifier, val applied: Modifier)

    private val swaps = IdentityHashMap<Any, Swap>()
    private val overrides = LinkedHashMap<String, Override>()

    /** After every `/tree` capture (main thread): remembers the nodes, re-applies what is active. */
    fun onCaptured(captured: Map<String, Any>, density: Float) {
        nodes = captured
        for ((id, override) in overrides) {
            val node = nodes[id] ?: continue
            runCatching { apply(node, override, density) }.onFailure {
                logError(ComposeVersion.unsupported("re-applying the live edit of $id failed", it))
            }
        }
    }

    /** `/override?id=&dx=&dy=&w=&h=`, main thread. Boxes and deltas are in frame pixels. */
    fun applyOverride(params: Map<String, String>, density: Float): String {
        val id = params["id"] ?: return Json.error("missing parameter id")
        val node = nodes[id] ?: return Json.error("node $id is not in the last /tree capture; capture again")
        when (val lookup = ModifierAccess.lookup(node.javaClass)) {
            is ModifierAccess.Lookup.Missing -> return Json.error(ComposeVersion.unsupported(lookup.what))
            is ModifierAccess.Lookup.Found -> Unit
        }
        val override = Override(
            dx = params["dx"]?.toIntOrNull() ?: 0,
            dy = params["dy"]?.toIntOrNull() ?: 0,
            w = params["w"]?.toIntOrNull() ?: -1,
            h = params["h"]?.toIntOrNull() ?: -1,
        )
        runCatching { apply(node, override, density) }.onFailure {
            return Json.error(ComposeVersion.unsupported("swapping LayoutNode.modifier by reflection failed", it.unwrap()))
        }
        overrides[id] = override
        return "{\"ok\":true,\"id\":${Json.string(id)}}"
    }

    /** `/overrides/clear`, main thread: every node gets back the modifier it had. */
    fun clear(): String {
        val count = overrides.size
        overrides.clear()
        var failure: Throwable? = null
        for ((node, swap) in swaps) {
            val access = ModifierAccess.of(node) ?: continue
            runCatching {
                // A recomposition already wrote the source modifier back: leave that one alone.
                if (access.get(node) === swap.applied) access.set(node, swap.base)
            }.onFailure { failure = it.unwrap() }
        }
        swaps.clear()
        failure?.let { return Json.error(ComposeVersion.unsupported("restoring LayoutNode.modifier by reflection failed", it)) }
        return "{\"ok\":true,\"cleared\":$count}"
    }

    /** The real cause of a reflective call, not the InvocationTargetException around it. */
    private fun Throwable.unwrap(): Throwable =
        (this as? java.lang.reflect.InvocationTargetException)?.targetException ?: this

    /**
     * Prepending the tweak means it wraps the node's own modifier chain, so the whole
     * element moves — background, padding and all — instead of just its content.
     *
     * The next recomposition of this composable writes its modifier back from source and
     * drops the tweak, which is why every capture re-applies what is still active; the base
     * is then the modifier the source wrote, not the one from before.
     */
    private fun apply(node: Any, override: Override, density: Float) {
        val access = ModifierAccess.of(node) ?: return
        val current = access.get(node) ?: return
        val previous = swaps[node]
        val base = if (previous != null && current === previous.applied) previous.base else current
        var tweak: Modifier = Modifier
        if (override.dx != 0 || override.dy != 0) {
            tweak = tweak.offset { IntOffset(override.dx, override.dy) }
        }
        if (override.w >= 0 && override.h >= 0) {
            tweak = tweak.requiredSize((override.w / density).dp, (override.h / density).dp)
        }
        val applied = tweak.then(base)
        access.set(node, applied)
        swaps[node] = Swap(base, applied)
    }
}

/**
 * `LayoutNode.modifier` is reachable only by reflection: the interface declaring it is
 * `internal` in Compose UI, and Kotlin mangles internal member names, so the accessors are
 * matched by name prefix rather than by exact signature.
 */
internal object ModifierAccess {

    class Accessors(private val getter: Method, private val setter: Method) {
        fun get(node: Any): Modifier? = getter.invoke(node) as? Modifier
        fun set(node: Any, modifier: Modifier) {
            setter.invoke(node, modifier)
        }
    }

    sealed interface Lookup {
        class Found(val accessors: Accessors) : Lookup
        /** What was looked for and not found, for the error the window shows. */
        class Missing(val what: String) : Lookup
    }

    private val cache = HashMap<Class<*>, Lookup>()

    fun of(node: Any): Accessors? = (lookup(node.javaClass) as? Lookup.Found)?.accessors

    /** Finds the accessors on [type]; the result (either way) is cached per class and logged once. */
    fun lookup(type: Class<*>): Lookup = synchronized(cache) {
        cache.getOrPut(type) {
            find(type).also { if (it is Lookup.Missing) logError(ComposeVersion.unsupported(it.what)) }
        }
    }

    /** Pure reflection over [type]'s public methods; exported for tests. */
    fun find(type: Class<*>): Lookup {
        val methods = type.methods
        val getter = methods.firstOrNull {
            it.parameterCount == 0 &&
                it.name.startsWith("getModifier") &&
                Modifier::class.java.isAssignableFrom(it.returnType)
        }
        val setter = methods.firstOrNull {
            it.parameterCount == 1 &&
                it.name.startsWith("setModifier") &&
                it.parameterTypes[0].isAssignableFrom(Modifier::class.java)
        }
        if (getter != null && setter != null) return Lookup.Found(Accessors(getter, setter))
        val missing = listOfNotNull(
            "getModifier*(): Modifier".takeIf { getter == null },
            "setModifier*(Modifier)".takeIf { setter == null },
        ).joinToString(" and ")
        return Lookup.Missing("live edits are unavailable: ${type.name} has no public $missing")
    }
}
