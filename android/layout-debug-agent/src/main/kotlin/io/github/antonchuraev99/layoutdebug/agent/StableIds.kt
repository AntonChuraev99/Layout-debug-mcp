package io.github.antonchuraev99.layoutdebug.agent

import java.lang.ref.WeakReference

/**
 * Gives each object a short id that stays the same for as long as the object lives and is
 * never shared with another object. `System.identityHashCode` alone is not that: on ART it
 * has far fewer bits than objects in a large composition, so two layout nodes can share it.
 *
 * Objects are held weakly, so a disposed layout node does not stay alive here. Not thread-safe:
 * the agent uses it on the main thread only.
 *
 * @param hash where an object goes; identity hash in production, injectable to test collisions.
 */
internal class StableIds(
    private val prefix: String = "L",
    private val hash: (Any) -> Int = System::identityHashCode,
) {
    private class Entry(obj: Any, val id: String) {
        val ref = WeakReference(obj)
    }

    private val buckets = HashMap<Int, MutableList<Entry>>()
    private var next = 1L

    fun idOf(obj: Any): String {
        val bucket = buckets.getOrPut(hash(obj)) { ArrayList(1) }
        bucket.removeAll { it.ref.get() == null }
        bucket.firstOrNull { it.ref.get() === obj }?.let { return it.id }
        val id = "$prefix${next++}"
        bucket.add(Entry(obj, id))
        return id
    }

    /** Drops entries of collected objects; call now and then (each capture). */
    fun prune() {
        val it = buckets.values.iterator()
        while (it.hasNext()) {
            val bucket = it.next()
            bucket.removeAll { e -> e.ref.get() == null }
            if (bucket.isEmpty()) it.remove()
        }
    }

    val size: Int get() = buckets.values.sumOf { it.size }
}
